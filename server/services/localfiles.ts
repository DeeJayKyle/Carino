import type { Services } from '../context.ts';
import type { Db, Row } from '../db/index.ts';
import { nowIso } from '../db/index.ts';
import { notFound } from '../context.ts';
import { extract, SUPPORTED, type DocKind } from './documents.ts';
import { addToIndex, searchIndex } from './indexer.ts';
import { LocalFsError, safeRel, sha256Of, type LocalFs } from './localfs.ts';

/**
 * The user's own folders: read-only by default. Carino indexes what's in the folders the user chose
 * (names, sizes, fingerprints and readable text) to search and summarise them, find duplicates and
 * suggest tidying up. Renaming, moving or deleting happens only as an approved action, after a
 * preview, with every change recorded and undoable (a delete keeps a checked copy first).
 */

const MAX_FILES = 5000;
const MAX_DEPTH = 8;
const MAX_READ = 20 * 1024 * 1024;
const MAX_CHUNKS = 200;
const TEXT_KINDS = new Set<DocKind>(['pdf', 'docx', 'xlsx', 'csv', 'text', 'markdown']);

export class FilesError extends Error {}

const fsOf = (services: Services): LocalFs => {
  if (!services.localFs) throw new FilesError('Folders on this device aren’t available here. Use Carino for Windows or the Android app.');
  return services.localFs;
};

export function getGrant(db: Db, userId: string, id: string) {
  const g = db.get('SELECT * FROM folder_grants WHERE id = ? AND user_id = ?', id, userId);
  if (!g) throw notFound('Folder');
  return g;
}

export function addGrant(db: Db, userId: string, root: string, label: string) {
  if (!root.trim()) throw new FilesError('Choose a folder.');
  const existing = db.get('SELECT * FROM folder_grants WHERE user_id = ? AND root = ?', userId, root);
  if (existing) return existing;
  if (Number(db.get('SELECT COUNT(*) AS n FROM folder_grants WHERE user_id = ?', userId)!.n) >= 20) throw new FilesError('Up to 20 folders.');
  return db.insert('folder_grants', { user_id: userId, root, label: label.slice(0, 120) || root.slice(-60) });
}

/** Revoking forgets the folder and everything Carino noted about it. */
export function revokeGrant(db: Db, userId: string, id: string) {
  const g = getGrant(db, userId, id);
  db.run("DELETE FROM search_index WHERE user_id = ? AND entity = 'local_chunk' AND entity_id IN (SELECT c.id FROM local_file_chunks c JOIN local_files f ON f.id = c.file_id WHERE f.grant_id = ?)", userId, id);
  db.run('DELETE FROM folder_grants WHERE id = ? AND user_id = ?', id, userId);
  return g;
}

export function setCanChange(db: Db, userId: string, id: string, on: boolean) {
  getGrant(db, userId, id);
  db.run('UPDATE folder_grants SET can_change = ? WHERE id = ?', on ? 1 : 0, id);
}

/** Local-only folders are never read by an online AI (search still works on the device). */
export function setLocalOnly(db: Db, userId: string, id: string, on: boolean) {
  getGrant(db, userId, id);
  db.run('UPDATE folder_grants SET local_only = ? WHERE id = ?', on ? 1 : 0, id);
}

const kindOf = (name: string): DocKind | 'other' => {
  const ext = (name.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
  return (SUPPORTED[ext]?.kind as DocKind | undefined) ?? 'other';
};

/** Looks through a folder (and its subfolders) and updates what Carino knows about it. Changed files only. */
export async function scanGrant(services: Services, userId: string, grantId: string) {
  const db = services.db;
  const fs = fsOf(services);
  const g = getGrant(db, userId, grantId);
  const seen = new Set<string>();
  let read = 0;
  let files = 0;
  const queue: [string, number][] = [['', 0]];
  try {
    while (queue.length && files < MAX_FILES) {
      const [dir, depth] = queue.shift()!;
      for (const e of await fs.list(String(g.root), dir)) {
        if (e.dir) {
          if (depth < MAX_DEPTH) queue.push([e.rel, depth + 1]);
          continue;
        }
        if (++files > MAX_FILES) break;
        seen.add(e.rel);
        const prev = db.get('SELECT * FROM local_files WHERE grant_id = ? AND rel_path = ?', grantId, e.rel);
        if (prev && prev.size === e.size && prev.mtime === e.mtime && prev.sha256) continue;
        await indexFile(services, userId, g, e, prev);
        read++;
      }
    }
    // Gone from the folder: forget it.
    for (const f of db.all('SELECT id, rel_path FROM local_files WHERE grant_id = ?', grantId)) if (!seen.has(String(f.rel_path))) forgetFile(db, userId, String(f.id));
    db.run('UPDATE folder_grants SET last_scan_at = ?, last_error = NULL WHERE id = ?', nowIso(), grantId);
  } catch (e: any) {
    db.run('UPDATE folder_grants SET last_error = ? WHERE id = ?', String(e?.message ?? e).slice(0, 300), grantId);
    throw e instanceof LocalFsError ? new FilesError(e.message) : e;
  }
  return { files: Math.min(files, MAX_FILES), read, capped: files > MAX_FILES };
}

function forgetFile(db: Db, userId: string, fileId: string) {
  db.run("DELETE FROM search_index WHERE user_id = ? AND entity = 'local_chunk' AND entity_id IN (SELECT id FROM local_file_chunks WHERE file_id = ?)", userId, fileId);
  db.run('DELETE FROM local_files WHERE id = ?', fileId);
}

async function indexFile(services: Services, userId: string, g: Row, e: { rel: string; name: string; size: number; mtime: string }, prev: Row | undefined) {
  const db = services.db;
  const fs = fsOf(services);
  const kind = kindOf(e.name);
  let sha: string | null = null;
  let chunks: { text: string; locator: string }[] = [];
  let chars = 0;
  if (e.size <= MAX_READ) {
    const buf = Buffer.from(await fs.read(String(g.root), e.rel, MAX_READ));
    sha = sha256Of(buf);
    if (kind !== 'other' && TEXT_KINDS.has(kind)) {
      try {
        const x = await extract(kind, buf);
        chunks = x.chunks.slice(0, MAX_CHUNKS);
        chars = x.totalChars;
      } catch {
        // Unreadable (damaged or password-protected): kept by name only.
      }
    }
  }
  if (prev) forgetFile(db, userId, String(prev.id));
  const f = db.insert('local_files', {
    user_id: userId, grant_id: String(g.id), rel_path: e.rel, name: e.name, ext: (e.name.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase(),
    size: e.size, mtime: e.mtime, sha256: sha, kind, text_chars: chars, summary: chunks[0]?.text.slice(0, 300) ?? '', indexed_at: nowIso(),
  });
  chunks.forEach((c, seq) => {
    const ch = db.insert('local_file_chunks', { user_id: userId, file_id: String(f.id), seq, locator: c.locator, text: c.text });
    addToIndex(db, userId, 'local_chunk', String(ch.id), e.name, c.text, c.locator);
  });
}

// ---------- Reading ----------

export function listFiles(db: Db, userId: string, opts: { grant?: string; q?: string; kind?: string; limit?: number } = {}) {
  const where = ['f.user_id = ?'];
  const params: any[] = [userId];
  if (opts.grant) { where.push('f.grant_id = ?'); params.push(opts.grant); }
  if (opts.kind) { where.push('f.kind = ?'); params.push(opts.kind); }
  if (opts.q) { where.push('(f.name LIKE ? OR f.rel_path LIKE ?)'); params.push(`%${opts.q}%`, `%${opts.q}%`); }
  return db.all(`SELECT f.*, g.label AS folder FROM local_files f JOIN folder_grants g ON g.id = f.grant_id WHERE ${where.join(' AND ')} ORDER BY f.rel_path LIMIT ?`, ...params, opts.limit ?? 500);
}

/** Searches inside the files (and their names). */
export function searchFiles(db: Db, userId: string, q: string, limit = 20) {
  const hits = searchIndex(db, userId, q, { entities: ['local_chunk'], limit: limit * 2 });
  const out = new Map<string, any>();
  for (const h of hits) {
    const c = db.get('SELECT c.locator, f.*, g.label AS folder FROM local_file_chunks c JOIN local_files f ON f.id = c.file_id JOIN folder_grants g ON g.id = f.grant_id WHERE c.id = ? AND c.user_id = ?', h.id, userId);
    if (c && !out.has(String(c.id))) out.set(String(c.id), { ...c, snippet: h.snippet, where: c.locator });
  }
  for (const f of listFiles(db, userId, { q, limit })) if (!out.has(String(f.id))) out.set(String(f.id), { ...f, snippet: '', where: 'name' });
  return [...out.values()].slice(0, limit);
}

/** The readable text of one file (for a summary); it isn't sent anywhere unless the user asks the assistant. */
export function fileText(db: Db, userId: string, fileId: string, maxChars = 60_000) {
  const f = db.get('SELECT f.*, g.label AS folder FROM local_files f JOIN folder_grants g ON g.id = f.grant_id WHERE f.id = ? AND f.user_id = ?', fileId, userId);
  if (!f) throw notFound('File');
  let text = '';
  for (const c of db.all('SELECT text, locator FROM local_file_chunks WHERE file_id = ? ORDER BY seq', fileId)) {
    if (text.length >= maxChars) break;
    text += `${c.locator ? `[${c.locator}] ` : ''}${c.text}\n`;
  }
  return { file: f, text: text.slice(0, maxChars), scanned: !f.text_chars && (f.kind === 'image' || f.kind === 'pdf') };
}

const looksLikeCopy = (name: string) => (/^copy of |\bcopy\b|\(\d+\)\.[^.]+$| - copy|_copy\b/i.test(name) ? 1 : 0);

/** Files with the same content (same fingerprint), in any of the folders. */
export function duplicates(db: Db, userId: string) {
  const groups = db.all(
    `SELECT sha256, COUNT(*) AS n, MAX(size) AS size FROM local_files WHERE user_id = ? AND sha256 IS NOT NULL AND size > 0
     GROUP BY sha256 HAVING COUNT(*) > 1 ORDER BY MAX(size) * (COUNT(*) - 1) DESC LIMIT 100`, userId,
  );
  return groups.map((g) => ({
    sha256: String(g.sha256), size: Number(g.size), copies: Number(g.n), wasted: Number(g.size) * (Number(g.n) - 1),
    // The one to keep comes first: not named like a copy, then the oldest, then the shortest path.
    files: db.all('SELECT f.id, f.grant_id, f.rel_path, f.name, f.mtime, g.label AS folder FROM local_files f JOIN folder_grants g ON g.id = f.grant_id WHERE f.user_id = ? AND f.sha256 = ?', userId, g.sha256)
      .sort((a, b) => looksLikeCopy(String(a.name)) - looksLikeCopy(String(b.name)) || String(a.mtime).localeCompare(String(b.mtime)) || String(a.rel_path).length - String(b.rel_path).length || String(a.rel_path).localeCompare(String(b.rel_path))),
  }));
}

// ---------- Suggestions and changes ----------

export type FileOp = { op: 'move'; grant_id: string; from: string; to: string } | { op: 'delete'; grant_id: string; path: string };

const KIND_FOLDER: Record<string, string> = { pdf: 'PDFs', docx: 'Documents', xlsx: 'Spreadsheets', csv: 'Spreadsheets', text: 'Notes', markdown: 'Notes', image: 'Pictures' };

/**
 * Ideas for tidying up, each a list of changes to preview: extra copies of the same file, and loose
 * files at the top of a folder grouped by type and year. Nothing happens until the user approves.
 */
export function suggestions(db: Db, userId: string) {
  const out: { id: string; title: string; why: string; ops: FileOp[] }[] = [];
  for (const d of duplicates(db, userId).slice(0, 10)) {
    const [keep, ...extra] = d.files;
    out.push({
      id: `dup-${d.sha256.slice(0, 12)}`, title: `Delete ${extra.length} extra cop${extra.length === 1 ? 'y' : 'ies'} of ${keep.name}`,
      why: `The same content is in ${d.copies} places; keeping ${keep.folder}/${keep.rel_path} (the oldest).`,
      ops: extra.map((f: any) => ({ op: 'delete', grant_id: String(f.grant_id), path: String(f.rel_path) })),
    });
  }
  for (const g of db.all('SELECT * FROM folder_grants WHERE user_id = ?', userId)) {
    const loose = db.all("SELECT * FROM local_files WHERE grant_id = ? AND rel_path NOT LIKE '%/%' AND kind <> 'other'", g.id);
    const groups = new Map<string, Row[]>();
    for (const f of loose) {
      const key = `${KIND_FOLDER[String(f.kind)] ?? 'Other'}/${String(f.mtime ?? '').slice(0, 4) || 'Undated'}`;
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    for (const [dest, files] of groups) {
      if (files.length < 3) continue;
      out.push({
        id: `tidy-${String(g.id).slice(0, 8)}-${dest}`, title: `Move ${files.length} ${dest.split('/')[0].toLowerCase()} into ${dest}`,
        why: `${files.length} loose files of the same kind and year at the top of ${g.label}.`,
        ops: files.map((f) => ({ op: 'move', grant_id: String(g.id), from: String(f.rel_path), to: `${dest}/${f.name}` })),
      });
    }
  }
  return out;
}

/** Checks a set of changes before they're offered for approval: every file known, the folder allows changes. */
export function checkOps(db: Db, userId: string, ops: FileOp[]) {
  if (!ops.length || ops.length > 200) throw new FilesError('Between 1 and 200 changes at a time.');
  return ops.map((o) => {
    const g = getGrant(db, userId, o.grant_id);
    if (!g.can_change) throw new FilesError(`Changes to “${g.label}” aren’t allowed. Allow changes for that folder in Files first (each one is still approved).`);
    const rel = safeRel(o.op === 'move' ? o.from : o.path);
    const f = db.get('SELECT * FROM local_files WHERE grant_id = ? AND rel_path = ?', g.id, rel);
    if (!f?.sha256) throw new FilesError(`${rel} isn’t in Carino’s list for ${g.label}. Scan the folder again.`);
    return { ...o, ...(o.op === 'move' ? { from: rel, to: safeRel(o.to) } : { path: rel }), label: g.label, sha256: String(f.sha256), size: Number(f.size) };
  });
}

/** Carries out approved changes, one by one, each checked first and recorded so it can be undone. */
export async function applyOps(services: Services, userId: string, ops: FileOp[], actionId: string | null) {
  const db = services.db;
  const fs = fsOf(services);
  const checked = checkOps(db, userId, ops);
  const results: { op: string; path: string; ok: boolean; error?: string }[] = [];
  for (const o of checked) {
    const g = getGrant(db, userId, o.grant_id);
    const rel = o.op === 'move' ? o.from : o.path;
    try {
      // The file must still be what the user approved.
      const now = sha256Of(await fs.read(String(g.root), rel, MAX_READ));
      if (now !== o.sha256) throw new FilesError(`${rel} changed since the preview; skipped.`);
      if (o.op === 'move') {
        await fs.rename(String(g.root), rel, o.to);
        db.insert('file_ops', { user_id: userId, grant_id: String(g.id), action_id: actionId, op: 'move', from_rel: rel, to_rel: o.to, sha256: o.sha256 });
        db.run('UPDATE local_files SET rel_path = ?, name = ? WHERE grant_id = ? AND rel_path = ?', o.to, o.to.split('/').pop() ?? o.to, g.id, rel);
      } else {
        const recovery = await fs.deleteWithRecovery(String(g.root), rel, o.sha256);
        db.insert('file_ops', { user_id: userId, grant_id: String(g.id), action_id: actionId, op: 'delete', from_rel: rel, sha256: o.sha256, recovery });
        const f = db.get('SELECT id FROM local_files WHERE grant_id = ? AND rel_path = ?', g.id, rel);
        if (f) forgetFile(db, userId, String(f.id));
      }
      results.push({ op: o.op, path: rel, ok: true });
    } catch (e: any) {
      results.push({ op: o.op, path: rel, ok: false, error: String(e?.message ?? e) });
    }
  }
  return results;
}

/** Undoes one recorded change: moves the file back, or puts the saved copy back; checks it either way. */
export async function undoOp(services: Services, userId: string, opId: string) {
  const db = services.db;
  const fs = fsOf(services);
  const op = db.get("SELECT * FROM file_ops WHERE id = ? AND user_id = ? AND status = 'done'", opId, userId);
  if (!op) throw new FilesError('Nothing to undo there.');
  const g = getGrant(db, userId, String(op.grant_id));
  if (op.op === 'move') {
    const now = sha256Of(await fs.read(String(g.root), String(op.to_rel), MAX_READ));
    if (now !== op.sha256) throw new FilesError(`${op.to_rel} has changed since it was moved; move it back yourself if you still want to.`);
    await fs.rename(String(g.root), String(op.to_rel), String(op.from_rel));
  } else {
    await fs.restore(String(g.root), String(op.from_rel), String(op.recovery), String(op.sha256));
  }
  db.run("UPDATE file_ops SET status = 'undone', undone_at = ? WHERE id = ?", nowIso(), opId);
  return { undone: true };
}

export function history(db: Db, userId: string) {
  return db.all('SELECT o.*, g.label AS folder FROM file_ops o JOIN folder_grants g ON g.id = o.grant_id WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 200', userId);
}
