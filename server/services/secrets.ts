import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Encrypts small secrets (connector access tokens) stored in the database. The key lives in
 * its own file next to the database, so a copy of carino.db alone — an export, a backup, a
 * stray copy — doesn't reveal the tokens. Backups deliberately leave the key out: after a
 * restore on another machine, connectors ask for their tokens again.
 */
const keys = new Map<string, Buffer>();

function keyFor(dataDir: string): Buffer {
  const path = resolve(dataDir, 'secret.key');
  let key = keys.get(path);
  if (key) return key;
  if (existsSync(path)) key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
  if (!key || key.length !== 32) {
    mkdirSync(dataDir, { recursive: true });
    key = randomBytes(32);
    writeFileSync(path, key.toString('base64'), { mode: 0o600 });
  }
  keys.set(path, key);
  return key;
}

export function encryptSecret(dataDir: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFor(dataDir), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
}

/** Returns null when the value can't be decrypted (e.g. the key file was replaced). */
export function decryptSecret(dataDir: string, stored: string | null | undefined): string | null {
  if (!stored?.startsWith('v1:')) return null;
  try {
    const raw = Buffer.from(stored.slice(3), 'base64');
    const d = createDecipheriv('aes-256-gcm', keyFor(dataDir), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
