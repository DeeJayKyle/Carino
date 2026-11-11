import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Services } from '../context.ts';
import type { Db, Row } from '../db/index.ts';
import { nowIso, parseJson } from '../db/index.ts';
import { encryptSecret, decryptSecret } from './secrets.ts';
import { uploadDir } from './documents.ts';
import { addToIndex, indexEntity } from './indexer.ts';

/**
 * Pairing and sync between the user's own devices: a phone and a PC on the same network.
 *
 * Pairing: the PC shows a code (and QR). The phone uses it with the PC's public key; both derive the
 * same key (ECDH P-256 + HKDF, salted with the code) and show a 6-digit check number. Nothing syncs
 * until the user confirms the numbers match on both, which rules out anyone in between.
 *
 * Transport: the phone always starts (phones can't accept connections); the PC listens on the local
 * network. Every message is encrypted and authenticated with the pair's key (AES-256-GCM), so the
 * network itself needn't be trusted.
 *
 * Sync: triggers log every change to a synced table. Each change carries a fingerprint of the version
 * both devices last agreed on. A device applies a change only if its own copy is still that version;
 * if both changed it, it's kept as a conflict for the user to choose. Nothing is silently overwritten.
 */

/** Tables kept in step between devices. Approvals, routines and usage stay per-device on purpose
 *  (an approved action or a routine would otherwise run twice). */
export const SYNCED = [
  'workspaces', 'projects', 'project_items', 'tasks', 'notes', 'memories', 'conversations', 'messages',
  'documents', 'doc_chunks', 'reminders', 'place_reminders', 'expenses', 'budgets', 'money_books', 'income',
  'bills', 'debts', 'debt_payments', 'savings_goals', 'savings_moves', 'applications', 'application_items',
  'application_events', 'notifications', 'links', 'handoffs',
] as const;
const BATCH = 300;
const MAX_FILE = 25 * 1024 * 1024;
const PAIR_TTL_MS = 10 * 60_000;
const PROTOCOL = 1;

export class SyncError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** A secret saved encrypted with this device's key; unreadable means the device's key changed. */
function reveal(services: Services, stored: unknown): string {
  const v = decryptSecret(services.config.DATA_DIR, String(stored ?? ''));
  if (v == null) throw new SyncError('This device’s pairing keys can’t be read any more. Pair the devices again.', 409);
  return v;
}

const sha256hex = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const b64u = (u: Uint8Array) => Buffer.from(u).toString('base64url');
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const bs = (u: Uint8Array) => u as unknown as BufferSource;
const subtle = () => globalThis.crypto.subtle;

// ---------- Triggers and the change log ----------

/** Creates the change-log triggers (idempotent; run at start-up). */
export function ensureSyncTriggers(db: Db) {
  const have = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => String(r.name)));
  for (const t of SYNCED) {
    if (!have.has(t)) continue;
    // Only while a device is paired, and not while applying a peer's changes.
    const when = 'EXISTS (SELECT 1 FROM sync_peers) AND NOT EXISTS (SELECT 1 FROM sync_applying)';
    db.raw.exec(`
      CREATE TRIGGER IF NOT EXISTS sync_${t}_ins AFTER INSERT ON ${t} WHEN ${when} BEGIN INSERT INTO sync_log (tbl, row_id, op) VALUES ('${t}', NEW.id, 'upsert'); END;
      CREATE TRIGGER IF NOT EXISTS sync_${t}_upd AFTER UPDATE ON ${t} WHEN ${when} BEGIN INSERT INTO sync_log (tbl, row_id, op) VALUES ('${t}', NEW.id, 'upsert'); END;
      CREATE TRIGGER IF NOT EXISTS sync_${t}_del AFTER DELETE ON ${t} WHEN ${when} BEGIN INSERT INTO sync_log (tbl, row_id, op) VALUES ('${t}', OLD.id, 'delete'); END;`);
  }
}

/** Parents before children, so a batch never refers to something not there yet. */
function tableOrder(db: Db): string[] {
  const set = new Set<string>(SYNCED);
  const deps = new Map([...set].map((t) => [t, db.all(`PRAGMA foreign_key_list(${t})`).map((f) => String(f.table)).filter((x) => x !== t && set.has(x))]));
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string) => {
    if (seen.has(t)) return;
    seen.add(t);
    for (const d of deps.get(t) ?? []) visit(d);
    out.push(t);
  };
  for (const t of SYNCED) visit(t);
  return out;
}

/** A fingerprint of a record's content (ignoring whose account it's in and where its file is kept). */
function hashRow(row: Row | null | undefined): string {
  if (!row) return '';
  const r: Record<string, unknown> = {};
  for (const k of Object.keys(row).sort()) if (k !== 'user_id' && k !== 'storage_path') r[k] = row[k];
  return sha256hex(JSON.stringify(r));
}

// ---------- Identity and keys ----------

export async function identity(services: Services) {
  const db = services.db;
  const row = db.get('SELECT * FROM sync_identity WHERE id = 1');
  if (row) return { device_id: String(row.device_id), name: String(row.name), public_key: String(row.public_key) };
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const pub = JSON.stringify(await subtle().exportKey('jwk', pair.publicKey));
  const priv = JSON.stringify(await subtle().exportKey('jwk', pair.privateKey));
  const id = randomUUID();
  const name = services.config.PUBLIC_URL?.includes('appassets') ? 'Phone' : 'This device';
  db.run('INSERT OR IGNORE INTO sync_identity (id, device_id, name, public_key, private_key) VALUES (1, ?, ?, ?, ?)', id, name, pub, encryptSecret(services.config.DATA_DIR, priv));
  return identity(services);
}

export function renameDevice(db: Db, name: string) {
  db.run('UPDATE sync_identity SET name = ? WHERE id = 1', name.trim().slice(0, 60) || 'This device');
}

/** The pair's key: ECDH(our private, their public), HKDF-SHA256 salted with the pairing code. */
async function deriveKey(services: Services, theirPublic: string, code: string, ids: [string, string]): Promise<Uint8Array> {
  const row = services.db.get('SELECT private_key FROM sync_identity WHERE id = 1')!;
  const priv = await subtle().importKey('jwk', JSON.parse(reveal(services, row.private_key)), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = await subtle().importKey('jwk', JSON.parse(theirPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = await subtle().deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hk = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const info = new TextEncoder().encode(`carino-sync-v${PROTOCOL}|${[...ids].sort().join('|')}`);
  const salt = new Uint8Array(createHash('sha256').update(normCode(code)).digest());
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: bs(salt), info: bs(info) }, hk, 256));
}

const normCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

async function hmac(key: Uint8Array, text: string) {
  const k = await subtle().importKey('raw', bs(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, new TextEncoder().encode(text)));
}

/** The 6-digit number both screens show; matching numbers mean nobody is in between. */
async function checkNumber(key: Uint8Array) {
  const h = await hmac(key, 'carino-sync-check');
  return String(((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0).padStart(10, '0').slice(-6).replace(/(\d{3})(\d{3})/, '$1 $2');
}

async function seal(key: Uint8Array, from: string, to: string, msg: unknown) {
  const iv = new Uint8Array(randomBytes(12));
  const k = await subtle().importKey('raw', bs(key), 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: new TextEncoder().encode(`${from}>${to}`) }, k, new TextEncoder().encode(JSON.stringify(msg))));
  return { v: PROTOCOL, from, to, iv: b64u(iv), ct: b64u(ct) };
}

async function open(key: Uint8Array, env: { from: string; to: string; iv: string; ct: string }) {
  const k = await subtle().importKey('raw', bs(key), 'AES-GCM', false, ['decrypt']);
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: bs(unb64u(env.iv)), additionalData: new TextEncoder().encode(`${env.from}>${env.to}`) }, k, bs(unb64u(env.ct)));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    throw new SyncError('A message from the other device couldn’t be opened. Pair the devices again.', 403);
  }
}

const peerKey = (services: Services, peer: Row) => unb64u(reveal(services, peer.shared_key));

// ---------- Pairing ----------

/** On the PC: start a pairing. Returns the code and what the phone needs (shown as text and a QR code). */
export async function startPairing(services: Services, userId: string, addresses: string[]) {
  const me = await identity(services);
  const code = Array.from(randomBytes(10), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('').replace(/(.{5})(.{5})/, '$1-$2');
  services.db.run('DELETE FROM sync_pairing WHERE expires_at < ? OR user_id = ?', services.now().toISOString(), userId);
  services.db.run('INSERT INTO sync_pairing (id, user_id, code, expires_at) VALUES (?, ?, ?, ?)', randomUUID(), userId, encryptSecret(services.config.DATA_DIR, normCode(code)), new Date(services.now().getTime() + PAIR_TTL_MS).toISOString());
  const offer = { v: PROTOCOL, id: me.device_id, name: me.name, key: me.public_key, at: addresses.slice(0, 4) };
  return { code, offer, link: `carino-pair:${Buffer.from(JSON.stringify({ ...offer, code })).toString('base64url')}`, expires_in: PAIR_TTL_MS / 1000 };
}

/** For a typed code: ask the PC at that address for its id and public key. */
export async function fetchOffer(services: Services, address: string) {
  const r = await post(services, address, { v: PROTOCOL, type: 'hello' });
  if (!r?.ok || !r.offer?.id || !r.offer?.key) throw new SyncError(r?.error ?? 'The PC didn’t answer. Check the address.');
  return r.offer as { id: string; name: string; key: string; at: string[] };
}

export function parsePairLink(link: string) {
  const m = link.trim().match(/^carino-pair:([A-Za-z0-9_-]+)$/);
  if (!m) throw new SyncError('That isn’t a Carino pairing code. Scan the QR code on your PC, or type the code and address.');
  const o = parseJson<any>(Buffer.from(m[1], 'base64url').toString(), null);
  if (!o?.id || !o?.key || !o?.code) throw new SyncError('That pairing code is incomplete.');
  return o as { id: string; name: string; key: string; at: string[]; code: string };
}

/**
 * On the phone: pair with a PC from its offer and code. Talks to the PC once to prove both sides
 * hold the same key; then both show the check number for the user to compare.
 */
export async function joinPairing(services: Services, userId: string, offer: { id: string; name: string; key: string; at: string[] }, code: string, address: string) {
  const me = await identity(services);
  if (offer.id === me.device_id) throw new SyncError('That’s this device’s own code.');
  const key = await deriveKey(services, offer.key, code, [me.device_id, offer.id]);
  const proof = b64u(await hmac(key, `pair|${me.device_id}|${offer.id}`));
  const res = await post(services, address, { v: PROTOCOL, type: 'pair', from: me.device_id, to: offer.id, name: me.name, key: me.public_key, proof });
  if (!res?.ok || res.proof !== b64u(await hmac(key, `paired|${offer.id}|${me.device_id}`))) throw new SyncError(res?.error ?? 'The PC didn’t accept the pairing. Check the code and try again.');
  savePeer(services, userId, { device_id: offer.id, name: res.name ?? offer.name, public_key: offer.key, key, address, role: 'listener' });
  return { peer: offer.id, name: res.name ?? offer.name, check: await checkNumber(key) };
}

function savePeer(services: Services, userId: string, p: { device_id: string; name: string; public_key: string; key: Uint8Array; address: string | null; role: 'listener' | 'caller' }) {
  services.db.run(
    `INSERT INTO sync_peers (device_id, user_id, name, public_key, shared_key, address, role, confirmed) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, public_key = excluded.public_key, shared_key = excluded.shared_key, address = excluded.address, role = excluded.role, confirmed = 0, sent_seq = 0, recv_seq = 0`,
    p.device_id, userId, p.name.slice(0, 60), p.public_key, encryptSecret(services.config.DATA_DIR, b64u(p.key)), p.address, p.role,
  );
  services.db.run('DELETE FROM sync_rows WHERE peer = ?', p.device_id);
}

/** The check number for a paired device (to show again). */
export async function peerCheck(services: Services, userId: string, deviceId: string) {
  const p = services.db.get('SELECT * FROM sync_peers WHERE device_id = ? AND user_id = ?', deviceId, userId);
  if (!p) throw new SyncError('Unknown device.', 404);
  return checkNumber(peerKey(services, p));
}

/** The user saw the same number on both screens: start syncing, beginning with everything already here. */
export function confirmPeer(db: Db, userId: string, deviceId: string) {
  const p = db.get('SELECT * FROM sync_peers WHERE device_id = ? AND user_id = ?', deviceId, userId);
  if (!p) throw new SyncError('Unknown device.', 404);
  if (p.confirmed) return;
  db.tx(() => {
    db.run('UPDATE sync_peers SET confirmed = 1 WHERE device_id = ?', deviceId);
    // Everything that exists now is sent once (the log only holds changes made since pairing).
    for (const t of tableOrder(db)) db.run(`INSERT INTO sync_log (tbl, row_id, op) SELECT '${t}', id, 'upsert' FROM ${t} WHERE user_id = ?`, userId);
    db.run('UPDATE sync_peers SET sent_seq = 0 WHERE device_id = ?', deviceId);
  });
}

export function forgetPeer(db: Db, userId: string, deviceId: string) {
  db.run('DELETE FROM sync_peers WHERE device_id = ? AND user_id = ?', deviceId, userId);
  db.run('DELETE FROM sync_rows WHERE peer = ?', deviceId);
  db.run("UPDATE sync_conflicts SET status = 'resolved' WHERE peer = ? AND user_id = ?", deviceId, userId);
  compactLog(db);
}

// ---------- Changes ----------

interface Change { tbl: string; id: string; row: Row | null; hash: string; base: string | null; file?: string }
interface Outcome { tbl: string; id: string; hash: string; ok: boolean }

/** Our changes the peer hasn't acknowledged: the latest state of each changed record. */
function outgoing(services: Services, peer: Row) {
  const db = services.db;
  const groups = db.all(
    'SELECT tbl, row_id, MAX(seq) AS seq FROM sync_log WHERE seq > ? GROUP BY tbl, row_id ORDER BY MAX(seq) LIMIT ?',
    Number(peer.sent_seq), BATCH,
  );
  const changes: Change[] = [];
  let upTo = Number(peer.sent_seq);
  for (const g of groups) {
    upTo = Math.max(upTo, Number(g.seq));
    const row = db.get(`SELECT * FROM ${g.tbl} WHERE id = ? AND user_id = ?`, g.row_id, peer.user_id) ?? null;
    if (!row && !db.get('SELECT 1 FROM sync_rows WHERE peer = ? AND tbl = ? AND row_id = ?', peer.device_id, g.tbl, g.row_id)) {
      // Made and deleted before the peer ever saw it: nothing to send.
      continue;
    }
    const base = db.get('SELECT hash FROM sync_rows WHERE peer = ? AND tbl = ? AND row_id = ?', peer.device_id, g.tbl, g.row_id);
    const c: Change = { tbl: String(g.tbl), id: String(g.row_id), row: row ? strip(row) : null, hash: hashRow(row), base: base ? String(base.hash) : null };
    if (row && g.tbl === 'documents' && row.storage_path && existsSync(String(row.storage_path))) {
      const buf = readFileSync(String(row.storage_path));
      if (buf.length <= MAX_FILE) c.file = Buffer.from(buf).toString('base64');
    }
    changes.push(c);
  }
  const more = groups.length === BATCH;
  return { changes, upTo, more };
}

const strip = (row: Row) => {
  const out: Row = { ...row };
  delete out.user_id;
  delete out.storage_path;
  return out;
};

/** Applies a peer's changes in one transaction. A record changed on both sides becomes a conflict. */
function applyChanges(services: Services, peer: Row, changes: Change[]): Outcome[] {
  const db = services.db;
  const userId = String(peer.user_id);
  const order = tableOrder(db);
  const rank = (c: Change) => {
    const i = order.indexOf(c.tbl);
    return c.row ? i : 1000 - i; // upserts parents first; deletes children first, after upserts
  };
  const sorted = changes.filter((c) => (SYNCED as readonly string[]).includes(c.tbl)).sort((a, b) => rank(a) - rank(b));
  const outcomes: Outcome[] = [];
  const touched: Change[] = [];
  db.tx(() => {
    db.raw.exec('PRAGMA defer_foreign_keys = ON');
    db.run('INSERT INTO sync_applying (x) VALUES (1)');
    try {
      for (const c of sorted) {
        const local = db.get(`SELECT * FROM ${c.tbl} WHERE id = ?`, c.id) ?? null;
        if (local && local.user_id !== userId) { outcomes.push({ tbl: c.tbl, id: c.id, hash: c.hash, ok: false }); continue; }
        const localHash = hashRow(local);
        const agreed = db.get('SELECT hash FROM sync_rows WHERE peer = ? AND tbl = ? AND row_id = ?', peer.device_id, c.tbl, c.id);
        const base = c.base ?? (agreed ? String(agreed.hash) : null);
        let apply: boolean;
        if (localHash === c.hash) apply = false; // already the same
        else if (!local && base === null) apply = true; // new to us
        else apply = localHash === (base ?? '');
        if (localHash === c.hash || apply) {
          if (apply) {
            writeRow(services, c, userId, !!local);
            touched.push(c);
          }
          agree(db, peer.device_id, c.tbl, c.id, c.hash, userId);
          outcomes.push({ tbl: c.tbl, id: c.id, hash: c.hash, ok: true });
        } else {
          // Changed here too since both last agreed: keep both versions for the user.
          db.run("DELETE FROM sync_conflicts WHERE peer = ? AND tbl = ? AND row_id = ? AND status = 'open'", peer.device_id, c.tbl, c.id);
          db.insert('sync_conflicts', { user_id: userId, peer: String(peer.device_id), tbl: c.tbl, row_id: c.id, mine: local ? JSON.stringify(strip(local)) : null, theirs: c.row ? JSON.stringify(c.row) : null, their_hash: c.hash });
          outcomes.push({ tbl: c.tbl, id: c.id, hash: c.hash, ok: false });
        }
      }
    } finally {
      db.run('DELETE FROM sync_applying');
    }
  });
  for (const c of touched) reindexRow(db, userId, c);
  return outcomes;
}

function agree(db: Db, peer: string, tbl: string, id: string, hash: string, userId: string) {
  db.run('INSERT INTO sync_rows (peer, tbl, row_id, hash) VALUES (?, ?, ?, ?) ON CONFLICT(peer, tbl, row_id) DO UPDATE SET hash = excluded.hash', peer, tbl, id, hash);
  db.run("UPDATE sync_conflicts SET status = 'resolved' WHERE peer = ? AND tbl = ? AND row_id = ? AND user_id = ? AND status = 'open'", peer, tbl, id, userId);
}

function writeRow(services: Services, c: Change, userId: string, exists: boolean) {
  const db = services.db;
  if (!c.row) {
    db.run(`DELETE FROM ${c.tbl} WHERE id = ? AND user_id = ?`, c.id, userId);
    return;
  }
  const cols = new Set(db.all(`PRAGMA table_info(${c.tbl})`).map((x) => String(x.name)));
  const row: Record<string, any> = {};
  for (const [k, v] of Object.entries(c.row)) if (cols.has(k)) row[k] = v; // fields from a newer Carino are skipped
  row.user_id = userId;
  if (c.tbl === 'documents') {
    if (c.file) {
      const path = join(uploadDir(services.config.DATA_DIR, userId), `${c.id}.bin`);
      writeFileSync(path, Buffer.from(c.file, 'base64'));
      row.storage_path = path;
    } else if (!exists) row.storage_path = '';
  }
  const keys = Object.keys(row);
  if (exists) db.run(`UPDATE ${c.tbl} SET ${keys.filter((k) => k !== 'id').map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.filter((k) => k !== 'id').map((k) => row[k]), c.id);
  else db.run(`INSERT INTO ${c.tbl} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => row[k]));
}

function reindexRow(db: Db, userId: string, c: Change) {
  const entity = ({ tasks: 'task', notes: 'note', memories: 'memory', projects: 'project', conversations: 'conversation', messages: 'message', doc_chunks: 'doc_chunk' } as const)[c.tbl as 'tasks'];
  if (!entity) return;
  db.run('DELETE FROM search_index WHERE user_id = ? AND entity = ? AND entity_id = ?', userId, entity, c.id);
  const r = c.row;
  if (!r) return;
  if (entity === 'task') indexEntity(db, userId, 'task', c.id, String(r.title), `${r.description ?? ''} ${r.category ?? ''}`);
  else if (entity === 'note') indexEntity(db, userId, 'note', c.id, String(r.title), String(r.body ?? ''));
  else if (entity === 'memory' && r.status === 'active') indexEntity(db, userId, 'memory', c.id, String(r.category), String(r.content));
  else if (entity === 'project') indexEntity(db, userId, 'project', c.id, String(r.name), String(r.description ?? ''));
  else if (entity === 'conversation') indexEntity(db, userId, 'conversation', c.id, String(r.title), '');
  else if (entity === 'message' && (r.role === 'user' || r.role === 'assistant')) indexEntity(db, userId, 'message', c.id, '', String(r.content));
  else if (entity === 'doc_chunk') addToIndex(db, userId, 'doc_chunk', c.id, '', String(r.text), String(r.locator ?? ''));
}

function recordOutcomes(db: Db, peer: Row, outcomes: Outcome[]) {
  for (const o of outcomes) if (o.ok) agree(db, String(peer.device_id), o.tbl, o.id, o.hash, String(peer.user_id));
}

/** Drops log entries every paired device has acknowledged. */
function compactLog(db: Db) {
  const min = db.get('SELECT MIN(sent_seq) AS m FROM sync_peers WHERE confirmed = 1');
  if (min?.m != null) db.run('DELETE FROM sync_log WHERE seq <= ?', Number(min.m));
  else if (!db.get('SELECT 1 FROM sync_peers')) db.run('DELETE FROM sync_log');
}

// ---------- The listener (PC) ----------

/** Handles one request from a paired phone. `body` and the result are the JSON sent over the network. */
export async function handleSyncRequest(services: Services, body: string): Promise<string> {
  try {
    return JSON.stringify(await handle(services, parseJson<any>(body, null)));
  } catch (e: any) {
    return JSON.stringify({ ok: false, error: e instanceof SyncError ? e.message : 'Sync failed on the PC.' });
  }
}

async function handle(services: Services, req: any) {
  const db = services.db;
  const me = await identity(services);
  if (!req || req.v !== PROTOCOL) throw new SyncError('This Carino is a different version. Update both devices.');
  if (req.type === 'hello') {
    // Only while pairing: the PC's id and public key, for a phone that typed the code instead of
    // scanning. (Anyone in between swapping the key would be caught by the check number.)
    if (!db.get('SELECT 1 FROM sync_pairing WHERE expires_at > ?', services.now().toISOString())) throw new SyncError('The PC isn’t pairing right now. Choose “Pair a phone” on the PC first.');
    return { ok: true, offer: { v: PROTOCOL, id: me.device_id, name: me.name, key: me.public_key, at: [] } };
  }
  if (req.to !== me.device_id) throw new SyncError('That message is for another device.');
  if (req.type === 'pair') {
    // The pairing waiting on this PC (one at a time); the proof shows the phone used its code.
    const pending = db.get('SELECT * FROM sync_pairing WHERE expires_at > ? ORDER BY expires_at DESC LIMIT 1', services.now().toISOString());
    if (!pending) throw new SyncError('The PC isn’t pairing right now. Choose “Pair a phone” on the PC first.');
    if (typeof req.key !== 'string' || typeof req.from !== 'string' || typeof req.proof !== 'string') throw new SyncError('Incomplete pairing request.');
    const code = reveal(services, pending.code);
    let key: Uint8Array;
    try {
      key = await deriveKey(services, req.key, code, [me.device_id, req.from]);
    } catch {
      throw new SyncError('That pairing request isn’t valid.');
    }
    if (req.proof !== b64u(await hmac(key, `pair|${req.from}|${me.device_id}`))) {
      // A wrong code: after 10, the pairing is cancelled (a new one must be started on the PC).
      db.run('UPDATE sync_pairing SET attempts = attempts + 1 WHERE id = ?', pending.id);
      db.run('DELETE FROM sync_pairing WHERE id = ? AND attempts >= 10', pending.id);
      throw new SyncError('That code doesn’t match the one on the PC.');
    }
    db.run('DELETE FROM sync_pairing WHERE id = ?', pending.id);
    savePeer(services, String(pending.user_id), { device_id: req.from, name: String(req.name ?? 'Phone'), public_key: req.key, key, address: null, role: 'caller' });
    return { ok: true, name: me.name, proof: b64u(await hmac(key, `paired|${me.device_id}|${req.from}`)) };
  }
  const peer = db.get('SELECT * FROM sync_peers WHERE device_id = ?', String(req.from ?? ''));
  if (!peer) throw new SyncError('This device isn’t paired with the PC. Pair them again.', 403);
  const msg = await open(peerKey(services, peer), req);
  if (!peer.confirmed) return seal(peerKey(services, peer), me.device_id, peer.device_id, { ok: false, error: 'Confirm the check number on the PC first.' });
  if (msg.type === 'sync') {
    const outcomes = applyChanges(services, peer, msg.changes ?? []);
    db.run('UPDATE sync_peers SET recv_seq = MAX(recv_seq, ?), last_sync_at = ?, last_error = NULL WHERE device_id = ?', Number(msg.up_to ?? 0), nowIso(), peer.device_id);
    const out = outgoing(services, db.get('SELECT * FROM sync_peers WHERE device_id = ?', peer.device_id)!);
    return seal(peerKey(services, peer), me.device_id, peer.device_id, { ok: true, outcomes, changes: out.changes, up_to: out.upTo, more: out.more });
  }
  if (msg.type === 'ack') {
    const p = db.get('SELECT * FROM sync_peers WHERE device_id = ?', peer.device_id)!;
    recordOutcomes(db, p, msg.outcomes ?? []);
    db.run('UPDATE sync_peers SET sent_seq = MAX(sent_seq, ?) WHERE device_id = ?', Number(msg.up_to ?? 0), peer.device_id);
    compactLog(db);
    return seal(peerKey(services, peer), me.device_id, peer.device_id, { ok: true });
  }
  throw new SyncError('Unknown request.');
}

// ---------- The caller (phone) ----------

async function post(services: Services, address: string, body: unknown) {
  const f = services.netFetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${address.replace(/\/$/, '')}/carino-sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new SyncError('Can’t reach your PC. Is Carino open on it, on the same Wi-Fi?', 503);
  }
  return res.json().catch(() => ({ ok: false, error: 'The PC sent something unexpected.' }));
}

/** One full sync with a paired PC: send our changes, take theirs, acknowledge. Repeats while there's more. */
export async function syncWith(services: Services, userId: string, deviceId: string) {
  const db = services.db;
  const me = await identity(services);
  let sent = 0;
  let received = 0;
  for (let round = 0; round < 50; round++) {
    const peer = db.get('SELECT * FROM sync_peers WHERE device_id = ? AND user_id = ?', deviceId, userId);
    if (!peer) throw new SyncError('Unknown device.', 404);
    if (!peer.confirmed) throw new SyncError('Compare the check numbers and confirm first.');
    if (peer.role !== 'listener' || !peer.address) throw new SyncError('This device connects to you; sync from it.');
    const key = peerKey(services, peer);
    try {
      const out = outgoing(services, peer);
      const res = await post(services, String(peer.address), await seal(key, me.device_id, peer.device_id, { type: 'sync', changes: out.changes, up_to: out.upTo }) as any);
      const reply = res?.iv ? await open(key, res) : res;
      if (!reply?.ok) throw new SyncError(reply?.error ?? 'The PC refused the sync.');
      recordOutcomes(db, peer, reply.outcomes ?? []);
      db.run('UPDATE sync_peers SET sent_seq = MAX(sent_seq, ?) WHERE device_id = ?', out.upTo, deviceId);
      const outcomes = applyChanges(services, peer, reply.changes ?? []);
      await post(services, String(peer.address), await seal(key, me.device_id, peer.device_id, { type: 'ack', outcomes, up_to: reply.up_to }) as any);
      db.run('UPDATE sync_peers SET recv_seq = MAX(recv_seq, ?), last_sync_at = ?, last_error = NULL WHERE device_id = ?', Number(reply.up_to ?? 0), nowIso(), deviceId);
      compactLog(db);
      sent += out.changes.length;
      received += (reply.changes ?? []).length;
      if (!out.more && !reply.more) break;
    } catch (e: any) {
      db.run('UPDATE sync_peers SET last_error = ? WHERE device_id = ?', String(e?.message ?? e).slice(0, 300), deviceId);
      throw e;
    }
  }
  return { sent, received, conflicts: Number(db.get("SELECT COUNT(*) AS n FROM sync_conflicts WHERE user_id = ? AND status = 'open'", userId)!.n) };
}

// ---------- Conflicts ----------

export function listConflicts(db: Db, userId: string) {
  return db.all("SELECT c.*, p.name AS peer_name FROM sync_conflicts c LEFT JOIN sync_peers p ON p.device_id = c.peer WHERE c.user_id = ? AND c.status = 'open' ORDER BY c.created_at", userId)
    .map((c) => ({ ...c, mine: parseJson(c.mine, null), theirs: parseJson(c.theirs, null) }));
}

/**
 * "mine": keep this device's version; it's sent to the other device as the newer one.
 * "theirs": take the other device's version here.
 */
export function resolveConflict(services: Services, userId: string, id: string, choice: 'mine' | 'theirs') {
  const db = services.db;
  const c = db.get("SELECT * FROM sync_conflicts WHERE id = ? AND user_id = ? AND status = 'open'", id, userId);
  if (!c) throw new SyncError('That conflict is already settled.', 404);
  const peer = db.get('SELECT * FROM sync_peers WHERE device_id = ?', c.peer);
  db.tx(() => {
    if (choice === 'theirs') {
      const theirs = parseJson<Row | null>(c.theirs, null);
      db.raw.exec('PRAGMA defer_foreign_keys = ON');
      db.run('INSERT INTO sync_applying (x) VALUES (1)');
      try {
        writeRow(services, { tbl: String(c.tbl), id: String(c.row_id), row: theirs, hash: String(c.their_hash), base: null }, userId, !!db.get(`SELECT 1 FROM ${c.tbl} WHERE id = ?`, c.row_id));
      } finally {
        db.run('DELETE FROM sync_applying');
      }
      if (peer) {
        agree(db, String(peer.device_id), String(c.tbl), String(c.row_id), String(c.their_hash), userId);
        // Tell the other device too, so its side of the conflict is settled (it sees the versions agree).
        db.run("INSERT INTO sync_log (tbl, row_id, op) VALUES (?, ?, 'upsert')", c.tbl, c.row_id);
      }
    } else if (peer) {
      // Our version goes out as a change made on top of theirs.
      agree(db, String(peer.device_id), String(c.tbl), String(c.row_id), String(c.their_hash), userId);
      db.run("INSERT INTO sync_log (tbl, row_id, op) VALUES (?, ?, 'upsert')", c.tbl, c.row_id);
    }
    db.run("UPDATE sync_conflicts SET status = 'resolved' WHERE id = ?", id);
  });
  if (choice === 'theirs') reindexRow(db, userId, { tbl: String(c.tbl), id: String(c.row_id), row: parseJson(c.theirs, null), hash: '', base: null });
}

export function listPeers(db: Db, userId: string): (Row & { confirmed: boolean; pending: number })[] {
  return db.all('SELECT device_id, name, address, role, confirmed, last_sync_at, last_error, created_at FROM sync_peers WHERE user_id = ? ORDER BY created_at', userId)
    .map((p) => ({ ...p, confirmed: !!p.confirmed, pending: Number(db.get('SELECT COUNT(DISTINCT tbl || row_id) AS n FROM sync_log WHERE seq > (SELECT sent_seq FROM sync_peers WHERE device_id = ?)', p.device_id)!.n) }));
}
