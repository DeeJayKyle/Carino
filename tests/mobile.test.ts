import { describe, it, expect } from 'vitest';
import * as node from 'node:crypto';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import * as shim from '../mobile/shims/crypto.ts';
import { Buffer as PhoneBuffer } from '../mobile/buffer.ts';
import { configureSqlite, DatabaseSync } from '../mobile/shims/sqlite.ts';
import { configToEnv, maskConfig } from '../mobile/presets.ts';

describe('phone app stand-ins for Node', () => {
  it('encrypts, hashes and signs exactly like node:crypto', () => {
    const key = node.randomBytes(32);
    const iv = node.randomBytes(12);
    const c = shim.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([c.update('connector token', 'utf8'), c.final()]);
    const d = node.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(c.getAuthTag());
    expect(Buffer.concat([d.update(body), d.final()]).toString()).toBe('connector token');
    expect(shim.createHash('sha256').update('abc').digest('hex')).toBe(node.createHash('sha256').update('abc').digest('hex'));
    expect(shim.createHmac('sha256', 'secret').update('payload').digest('hex')).toBe(node.createHmac('sha256', 'secret').update('payload').digest('hex'));
    const n = shim.randomInt(100000, 1000000);
    expect(n).toBeGreaterThanOrEqual(100000);
    expect(n).toBeLessThan(1000000);
  });

  it('adds base64url to the Buffer polyfill', () => {
    const raw = Uint8Array.from([251, 255, 191, 0, 1]);
    expect(PhoneBuffer.from(raw).toString('base64url')).toBe(Buffer.from(raw).toString('base64url'));
    expect([...PhoneBuffer.from(Buffer.from(raw).toString('base64url'), 'base64url')]).toEqual([...raw]);
  });

  it('runs SQL with full-text search, transactions and snapshots', async () => {
    const sqlite3 = await (sqlite3InitModule as any)({ print: () => {}, printErr: () => {} });
    let writes = 0;
    configureSqlite(sqlite3, { onWrite: () => writes++ });
    const db = new DatabaseSync(':memory:');
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER); CREATE VIRTUAL TABLE f USING fts5(body, tokenize = 'porter unicode61');");
    expect(db.prepare('INSERT INTO t VALUES (?, ?)').run('a', 1).changes).toBe(1);
    db.prepare('INSERT INTO f (body) VALUES (?)').run('selling chapati near the taxi park');
    expect(db.prepare('SELECT * FROM t WHERE id = ?').get('a')).toEqual({ id: 'a', n: 1 });
    expect(db.prepare('SELECT * FROM t WHERE id = ?').get('zz')).toBeUndefined();
    expect(db.prepare("SELECT snippet(f, 0, '[', ']', '…', 4) AS s FROM f WHERE f MATCH ?").all('chapati')[0].s).toContain('[chapati]');
    db.exec('BEGIN');
    expect(db.isTransaction).toBe(true);
    db.exec('ROLLBACK');
    expect(db.isTransaction).toBe(false);
    expect(writes).toBeGreaterThan(0);
    // A saved snapshot opens again with the same data.
    configureSqlite(sqlite3, { initial: db.serialize() });
    const copy = new DatabaseSync(':memory:');
    expect(copy.prepare('SELECT n FROM t').get()).toEqual({ n: 1 });
    db.close();
    copy.close();
  });

  it('turns the chosen free AI service into server settings, and hides keys', () => {
    expect(configToEnv({ provider: 'groq', apiKey: 'gsk_123456' })).toMatchObject({
      OPENAI_COMPAT_BASE_URL: 'https://api.groq.com/openai/v1', OPENAI_COMPAT_API_KEY: 'gsk_123456', DEFAULT_PROVIDER: 'openai_compat',
      TRANSCRIBE_API_KEY: 'gsk_123456', OPENAI_COMPAT_TOOLSET: 'full',
    });
    expect(configToEnv({ provider: 'gemini', apiKey: 'AIza', model: 'gemini-x' })).toMatchObject({ OPENAI_COMPAT_MODEL: 'gemini-x', OPENAI_COMPAT_VISION: 'true' });
    expect(configToEnv({ provider: 'anthropic', apiKey: 'sk-ant' })).toMatchObject({ ANTHROPIC_API_KEY: 'sk-ant', DEFAULT_PROVIDER: 'anthropic' });
    expect(configToEnv({ provider: null })).toEqual({});
    expect(maskConfig({ provider: 'groq', apiKey: 'gsk_abcdef1234' }).apiKey).toBe('••••1234');
  });
});
