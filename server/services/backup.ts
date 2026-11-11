import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Db, Row } from '../db/index.ts';
import { parseJson } from '../db/index.ts';
import { addToIndex, indexEntity } from './indexer.ts';
import { uploadDir } from './documents.ts';

/**
 * Encrypted backups of everything a user keeps in Carino, and restoring them.
 *
 * - Encrypted with a passphrase only the user knows (PBKDF2-SHA256, 600,000 rounds → AES-256-GCM).
 *   The header is authenticated too, so any change to the file is detected.
 * - Inside: a manifest with a row count and SHA-256 for every table and file, checked on restore.
 * - Saved sign-ins, tokens, connector and channel keys are never included: after a restore the
 *   user signs in to their apps again. (They're encrypted with a key that never leaves the device.)
 * - Each new backup is test-restored inside a transaction that's rolled back, so a backup is only
 *   offered once it's known to restore.
 * - A restore is previewed first, and the data it replaces is saved as an encrypted snapshot so it
 *   can be undone.
 */

export const BACKUP_FORMAT = 1;
const MAGIC = 'CARINO-BACKUP\n';
const KDF_ROUNDS = 600_000;
/** Tables never put in a backup: sign-ins, secrets, sessions and things rebuilt automatically. */
const EXCLUDED = new Set([
  'users', 'sessions', 'oauth_states', 'client_ops', 'push_subscriptions', 'calendar_tokens',
  'app_accounts', 'app_clients', 'connectors', 'channels', 'channel_chats', 'channel_inbound',
  'exports', 'schema_migrations', 'connected_digest', 'follow_up_dismissed', 'sync_identity', 'sync_peers', 'sync_pairing', 'sync_log', 'sync_applying', 'sync_rows', 'sync_conflicts', 'folder_grants', 'local_files', 'local_file_chunks', 'file_ops',
]);
const MAX_FILES_BYTES = 500 * 1024 * 1024;

export class BackupError extends Error {}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
/** Web Crypto's typings want a plain-ArrayBuffer view. */
const bs = (u: Uint8Array) => u as unknown as BufferSource;

/** The user's tables, parents before children (from the schema's foreign keys). */
export function backupTables(db: Db): string[] {
  const names = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_index%'").map((r) => String(r.name))
    .filter((n) => !EXCLUDED.has(n) && db.all(`PRAGMA table_info(${n})`).some((c) => c.name === 'user_id'));
  const deps = new Map(names.map((n) => [n, db.all(`PRAGMA foreign_key_list(${n})`).map((f) => String(f.table)).filter((t) => t !== n && names.includes(t))]));
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string, path: Set<string>) => {
    if (seen.has(n) || path.has(n)) return;
    path.add(n);
    for (const d of deps.get(n) ?? []) visit(d, path);
    seen.add(n);
    out.push(n);
  };
  for (const n of names.sort()) visit(n, new Set());
  return out;
}

export interface Manifest {
  format: number;
  app: 'carino';
  created_at: string;
  user: { name: string; email: string };
  tables: Record<string, { count: number; sha256: string }>;
  files: Record<string, { sha256: string; size: number }>;
}
interface Payload { manifest: Manifest; tables: Record<string, Row[]>; files: Record<string, string> }

// ---------- Encrypting ----------

async function deriveKey(passphrase: string, salt: Uint8Array, rounds: number) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: bs(salt), iterations: rounds }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function gzip(data: Uint8Array, mode: 'gzip' | 'gunzip') {
  const stream = new Blob([bs(data)]).stream().pipeThrough(mode === 'gzip' ? new CompressionStream('gzip') : new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function checkPassphrase(p: unknown): string {
  if (typeof p !== 'string' || p.length < 10) throw new BackupError('Use a passphrase of at least 10 characters. Write it down: without it the backup can’t be opened.');
  if (p.length > 200) throw new BackupError('That passphrase is too long.');
  return p;
}

export async function encryptBackup(payload: Payload, passphrase: string, rounds = KDF_ROUNDS): Promise<Uint8Array> {
  const salt = new Uint8Array(randomBytes(16));
  const iv = new Uint8Array(randomBytes(12));
  const header = JSON.stringify({ format: BACKUP_FORMAT, app: 'carino', created_at: payload.manifest.created_at, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: rounds, salt: b64(salt) }, cipher: { name: 'AES-GCM', iv: b64(iv) } });
  const key = await deriveKey(passphrase, salt, rounds);
  const plain = await gzip(new TextEncoder().encode(JSON.stringify(payload)), 'gzip');
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: new TextEncoder().encode(header) }, key, bs(plain)));
  const head = new TextEncoder().encode(`${MAGIC}${header}\n`);
  const out = new Uint8Array(head.length + sealed.length);
  out.set(head);
  out.set(sealed, head.length);
  return out;
}

/** Opens a backup and checks every table and file against its manifest. */
export async function decryptBackup(file: Uint8Array, passphrase: string): Promise<Payload> {
  const magic = new TextEncoder().encode(MAGIC);
  if (file.length < magic.length + 10 || !magic.every((b, i) => file[i] === b)) throw new BackupError('That isn’t a Carino backup file.');
  const nl = file.indexOf(10, magic.length);
  if (nl < 0) throw new BackupError('The backup file is damaged.');
  const headerText = new TextDecoder().decode(file.subarray(magic.length, nl));
  const header = parseJson<any>(headerText, null);
  if (!header || header.format > BACKUP_FORMAT) throw new BackupError('This backup was made by a newer Carino. Update Carino first.');
  const rounds = Number(header.kdf?.iterations);
  if (!Number.isInteger(rounds) || rounds < 100_000 || rounds > 10_000_000) throw new BackupError('The backup file is damaged.');
  const key = await deriveKey(passphrase, unb64(header.kdf.salt), rounds);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(unb64(header.cipher.iv)), additionalData: new TextEncoder().encode(headerText) }, key, bs(file.subarray(nl + 1))));
  } catch {
    throw new BackupError('Wrong passphrase, or the file was changed or damaged.');
  }
  const payload = parseJson<Payload | null>(new TextDecoder().decode(await gzip(plain, 'gunzip')), null);
  if (!payload?.manifest || !payload.tables) throw new BackupError('The backup file is damaged.');
  verifyPayload(payload);
  return payload;
}

function verifyPayload(p: Payload) {
  for (const [t, m] of Object.entries(p.manifest.tables)) {
    const rows = p.tables[t] ?? [];
    if (rows.length !== m.count || sha256(JSON.stringify(rows)) !== m.sha256) throw new BackupError(`The backup’s “${t}” records don’t match its checksum. It may be damaged; don’t restore it.`);
  }
  for (const [id, m] of Object.entries(p.manifest.files)) {
    const data = p.files[id];
    if (!data || sha256(unb64(data)) !== m.sha256) throw new BackupError('A file in the backup doesn’t match its checksum. It may be damaged; don’t restore it.');
  }
}

// ---------- Making one ----------

export function collect(db: Db, userId: string, now: Date): Payload {
  const user = db.get('SELECT name, email FROM users WHERE id = ?', userId);
  const tables: Record<string, Row[]> = {};
  const manifest: Manifest = { format: BACKUP_FORMAT, app: 'carino', created_at: now.toISOString(), user: { name: String(user?.name ?? ''), email: String(user?.email ?? '') }, tables: {}, files: {} };
  for (const t of backupTables(db)) {
    const rows = db.all(`SELECT * FROM ${t} WHERE user_id = ? ORDER BY rowid`, userId);
    tables[t] = rows;
    manifest.tables[t] = { count: rows.length, sha256: sha256(JSON.stringify(rows)) };
  }
  const files: Record<string, string> = {};
  let total = 0;
  for (const d of tables.documents ?? []) {
    if (!d.storage_path || !existsSync(String(d.storage_path))) continue;
    const buf = new Uint8Array(readFileSync(String(d.storage_path)));
    total += buf.length;
    if (total > MAX_FILES_BYTES) throw new BackupError('Your files add up to more than 500 MB, too much for one backup. Remove some large files and try again.');
    files[String(d.id)] = b64(buf);
    manifest.files[String(d.id)] = { sha256: sha256(buf), size: buf.length };
  }
  return { manifest, tables, files };
}

// ---------- Restoring ----------

export type RestoreMode = 'merge' | 'replace';

export interface Preview {
  created_at: string;
  from: { name: string; email: string };
  tables: { table: string; in_backup: number; on_device: number; new: number; same: number; different: number }[];
  files: number;
  left_out: string[];
}

/** What a restore would do, without changing anything. */
export function preview(db: Db, userId: string, p: Payload): Preview {
  const tables = backupTables(db).filter((t) => p.tables[t]).map((t) => {
    const rows = p.tables[t];
    const pk = primaryKey(db, t);
    let fresh = 0;
    let same = 0;
    let different = 0;
    for (const r of rows) {
      const cur = pk.length ? db.get(`SELECT * FROM ${t} WHERE ${pk.map((k) => `${k} = ?`).join(' AND ')} AND user_id = ?`, ...pk.map((k) => (k === 'user_id' ? userId : r[k])), userId) : undefined;
      if (!cur) fresh++;
      else if (sameRow(cur, r, userId)) same++;
      else different++;
    }
    return { table: t, in_backup: rows.length, on_device: Number(db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, userId)!.n), new: fresh, same, different };
  });
  return { created_at: p.manifest.created_at, from: p.manifest.user, tables, files: Object.keys(p.files).length, left_out: ['Sign-ins to your apps', 'Connected apps (MCP)', 'Telegram and WhatsApp links'] };
}

function primaryKey(db: Db, table: string): string[] {
  return db.all(`PRAGMA table_info(${table})`).filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => String(c.name));
}

function sameRow(a: Row, b: Row, userId: string) {
  for (const k of Object.keys(b)) {
    if (k === 'user_id' || k === 'storage_path') continue;
    if (String(a[k] ?? '') !== String(b[k] ?? '') && !(k === 'user_id' && a[k] === userId)) return false;
  }
  return true;
}

/**
 * Restores a backup into this user's account. "merge" adds what's missing and keeps everything
 * already here (records that differ are left as they are and counted). "replace" makes the account
 * exactly what's in the backup. Runs in one transaction: it either all happens or none of it does.
 */
export function restore(db: Db, userId: string, dataDir: string, p: Payload, mode: RestoreMode) {
  const order = backupTables(db).filter((t) => p.tables[t]);
  const counts: Record<string, { added: number; kept: number }> = {};
  const written: string[] = [];
  try {
    db.tx(() => {
      if (mode === 'replace') {
        // Children first, so nothing is left pointing at a deleted parent.
        for (const t of [...order].reverse()) db.run(`DELETE FROM ${t} WHERE user_id = ?`, userId);
        db.run('DELETE FROM search_index WHERE user_id = ?', userId);
      }
      for (const t of order) {
        const cols = new Set(db.all(`PRAGMA table_info(${t})`).map((c) => String(c.name)));
        let added = 0;
        let kept = 0;
        for (const raw of p.tables[t]) {
          const row: Record<string, any> = {};
          for (const [k, v] of Object.entries(raw)) if (cols.has(k)) row[k] = v; // columns from a newer Carino are skipped
          row.user_id = userId;
          if (t === 'documents') {
            const data = p.files[String(row.id)];
            if (data) {
              const path = join(uploadDir(dataDir, userId), `${row.id}.bin`);
              if (!existsSync(path)) {
                writeFileSync(path, unb64(data));
                written.push(path);
              }
              row.storage_path = path;
            } else row.storage_path = '';
          }
          const keys = Object.keys(row);
          const res = db.run(`INSERT OR IGNORE INTO ${t} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => row[k]));
          if (Number(res.changes)) added++;
          else kept++;
        }
        counts[t] = { added, kept };
      }
      reindex(db, userId);
    });
  } catch (err) {
    for (const f of written) rmSync(f, { force: true });
    throw err;
  }
  return counts;
}

/** Proves a backup restores: does a full "replace" restore inside a transaction, then rolls it back. */
export function testRestore(db: Db, userId: string, dataDir: string, p: Payload) {
  const probe = join(dataDir, 'backups', '.probe');
  db.raw.exec('SAVEPOINT backup_test');
  try {
    // Files aren't written in the test: only the database side is exercised.
    const noFiles = { ...p, files: {} };
    restore(db, userId, probe, noFiles, 'replace');
    for (const t of Object.keys(p.tables)) {
      const n = Number(db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, userId)!.n);
      if (n !== p.tables[t].length) throw new BackupError(`Test restore: “${t}” came back with ${n} records instead of ${p.tables[t].length}.`);
    }
  } finally {
    db.raw.exec('ROLLBACK TO backup_test');
    db.raw.exec('RELEASE backup_test');
    rmSync(probe, { recursive: true, force: true });
  }
}

/** Rebuilds the search index for a user's restored records. */
function reindex(db: Db, userId: string) {
  db.run('DELETE FROM search_index WHERE user_id = ?', userId);
  for (const t of db.all('SELECT * FROM tasks WHERE user_id = ?', userId)) indexEntity(db, userId, 'task', t.id, t.title, `${t.description} ${t.category} ${parseJson<string[]>(t.tags, []).join(' ')}`);
  for (const n of db.all('SELECT * FROM notes WHERE user_id = ?', userId)) indexEntity(db, userId, 'note', n.id, n.title, n.body);
  for (const m of db.all("SELECT * FROM memories WHERE user_id = ? AND status = 'active'", userId)) indexEntity(db, userId, 'memory', m.id, m.category, m.content);
  for (const p of db.all('SELECT * FROM projects WHERE user_id = ?', userId)) indexEntity(db, userId, 'project', p.id, p.name, `${p.description} ${p.goals}`);
  for (const c of db.all('SELECT id, title FROM conversations WHERE user_id = ?', userId)) indexEntity(db, userId, 'conversation', c.id, c.title, '');
  for (const m of db.all("SELECT id, content FROM messages WHERE user_id = ? AND role IN ('user', 'assistant')", userId)) indexEntity(db, userId, 'message', m.id, '', m.content);
  for (const c of db.all('SELECT c.id, c.text, c.locator, d.filename FROM doc_chunks c JOIN documents d ON d.id = c.document_id WHERE c.user_id = ?', userId)) addToIndex(db, userId, 'doc_chunk', c.id, c.filename, c.text, c.locator);
}

// ---------- Backups kept on this device ----------

const dir = (dataDir: string, userId: string) => resolve(dataDir, 'backups', userId);

export function saveLocal(dataDir: string, userId: string, name: string, data: Uint8Array) {
  mkdirSync(dir(dataDir, userId), { recursive: true });
  const path = join(dir(dataDir, userId), name);
  writeFileSync(path, data);
  return path;
}

export function listLocal(dataDir: string, userId: string) {
  const d = dir(dataDir, userId);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith('.carino-backup')).sort().reverse().map((name) => ({ name, size: readFileSync(join(d, name)).length, kind: name.startsWith('before-restore') ? 'safety' : 'backup' }));
}

export function readLocal(dataDir: string, userId: string, name: string) {
  if (!/^[\w.-]+\.carino-backup$/.test(name)) throw new BackupError('Unknown backup.');
  const path = join(dir(dataDir, userId), name);
  if (!existsSync(path)) throw new BackupError('Unknown backup.');
  return new Uint8Array(readFileSync(path));
}

export function deleteLocal(dataDir: string, userId: string, name: string) {
  if (!/^[\w.-]+\.carino-backup$/.test(name)) throw new BackupError('Unknown backup.');
  rmSync(join(dir(dataDir, userId), name), { force: true });
}

export const backupName = (now: Date, kind = 'carino') => `${kind}-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.carino-backup`;
