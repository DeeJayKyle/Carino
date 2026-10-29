import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from './db/index.ts';
import type { SessionUser } from './context.ts';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

export const SESSION_COOKIE = 'carino_session';
export const SESSION_DAYS = 30;

/** Passwords are stored as scrypt$N$r$p$salt$hash — never in plain text. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize('NFKC'), salt, KEYLEN, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Creates a session. The raw token goes in the cookie; only its hash is stored. */
export function createSession(db: Db, userId: string, userAgent: string | undefined, now: Date) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400_000);
  db.run(
    'INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)',
    sha256(token), userId, expires.toISOString(), (userAgent ?? '').slice(0, 200),
  );
  return { token, expires };
}

export function resolveSession(db: Db, token: string | undefined, now: Date): { user: SessionUser; sessionId: string } | null {
  if (!token || token.length > 100) return null;
  const id = sha256(token);
  const row = db.get(
    `SELECT s.id AS sid, s.expires_at, u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    id,
  );
  if (!row) return null;
  if (new Date(row.expires_at) <= now) {
    db.run('DELETE FROM sessions WHERE id = ?', id);
    return null;
  }
  return { user: { id: row.id, email: row.email, name: row.name }, sessionId: row.sid };
}

export function destroySession(db: Db, sessionId: string) {
  db.run('DELETE FROM sessions WHERE id = ?', sessionId);
}
