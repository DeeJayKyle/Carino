import { describe, it, expect } from 'vitest';
import * as node from 'node:crypto';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import * as shim from '../mobile/shims/crypto.ts';
import { Buffer as PhoneBuffer } from '../mobile/buffer.ts';
import { configureSqlite, DatabaseSync } from '../mobile/shims/sqlite.ts';
import { configToEnv, maskConfig, PRESETS } from '../mobile/presets.ts';
import { OpenAICompatProvider } from '../server/ai/openai-compat.ts';

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
      TRANSCRIBE_API_KEY: 'gsk_123456', OPENAI_COMPAT_TOOLSET: 'full', OPENAI_COMPAT_MODEL: 'openai/gpt-oss-120b',
      OPENAI_COMPAT_FALLBACK_MODELS: 'qwen/qwen3.8-27b,openai/gpt-oss-20b',
    });
    expect(configToEnv({ provider: 'gemini', apiKey: 'AIza', model: 'gemini-x' })).toMatchObject({ OPENAI_COMPAT_MODEL: 'gemini-x', OPENAI_COMPAT_VISION: 'true' });
    expect(configToEnv({ provider: 'anthropic', apiKey: 'sk-ant' })).toMatchObject({ ANTHROPIC_API_KEY: 'sk-ant', DEFAULT_PROVIDER: 'anthropic' });
    expect(configToEnv({ provider: null })).toEqual({});
    expect(maskConfig({ provider: 'groq', apiKey: 'gsk_abcdef1234' }).apiKey).toBe('••••1234');
  });
});

describe('free AI models', () => {
  it('says what to check when the AI service cannot be reached', async () => {
    const offline = (async () => { throw new TypeError('Failed to fetch'); }) as any;
    const msg = async (baseUrl: string) => {
      const p = new OpenAICompatProvider({ baseUrl, model: 'm', label: 'Svc', tools: false }, offline);
      return p.chat({ system: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] }).then(() => '', (e: any) => e.message);
    };
    expect(await msg('https://api.groq.com/openai/v1')).toBe('Could not reach Svc. Check your internet connection and try again.');
    expect(await msg('http://192.168.1.20:11434/v1')).toBe('Could not reach Svc. Is it running, and on the same Wi-Fi as this device?');
    expect(await msg('http://localhost:11434/v1')).toContain('same Wi-Fi');
  });

  it('offers only free services, best first, each with free models in priority order', () => {
    const shown = PRESETS.filter((p) => !p.hidden);
    expect(shown[0].id).toBe('gemini');
    expect(shown.map((p) => p.id)).not.toContain('anthropic');
    for (const p of shown) {
      expect(p.models.length, p.id).toBeGreaterThan(0);
      expect(p.model, p.id).toBe(p.models[0].id);
      expect(new Set(p.models.map((m) => m.id)).size, p.id).toBe(p.models.length);
    }
    // Retired names must not come back as defaults.
    expect(PRESETS.find((p) => p.id === 'gemini')!.models.map((m) => m.id)).not.toContain('gemini-2.5-flash');
    expect(PRESETS.find((p) => p.id === 'groq')!.models.map((m) => m.id)).not.toContain('llama-3.3-70b-versatile');
    expect(PRESETS.find((p) => p.id === 'openrouter')!.models.every((m) => m.id.endsWith(':free') || m.id === 'openrouter/free')).toBe(true);
    // DeepSeek and Qwen are reachable through a free service.
    const families = shown.flatMap((p) => p.models.map((m) => m.family));
    expect(families).toContain('DeepSeek');
    expect(families).toContain('Qwen');
  });

  it('moves on to the next free model when one is retired, busy or rate-limited', async () => {
    const asked: string[] = [];
    const replies: Record<string, number> = { a: 404, b: 503, c: 429 };
    const p = new OpenAICompatProvider({ baseUrl: 'http://x/v1', model: 'a', label: 'Svc', tools: false, fallbackModels: ['b', 'c', 'd'] }, (async (_u: string, init: any) => {
      const model = JSON.parse(init.body).model;
      asked.push(model);
      if (replies[model]) return new Response(JSON.stringify({ error: { message: `model ${model} problem` } }), { status: replies[model] });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }) as any);
    p.retryDelay = () => 0;
    const r = await p.chat({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }], tools: [] } as any);
    expect(asked).toEqual(['a', 'b', 'c', 'd']);
    expect(r.model).toBe('d');
    expect((r.content[0] as any).text).toBe('hi');
  });

  it('does not switch models for a bad key, and says which models it tried', async () => {
    const keyFail = new OpenAICompatProvider({ baseUrl: 'http://x/v1', model: 'a', label: 'Svc', tools: false, fallbackModels: ['b'] }, (async () => new Response('{}', { status: 401 })) as any);
    await expect(keyFail.chat({ system: 's', messages: [], tools: [] } as any)).rejects.toThrow(/rejected the API key/);
    const allBusy = new OpenAICompatProvider({ baseUrl: 'http://x/v1', model: 'a', label: 'Svc', tools: false, fallbackModels: ['b'] }, (async () => new Response('{}', { status: 503 })) as any);
    await expect(allBusy.chat({ system: 's', messages: [], tools: [] } as any)).rejects.toThrow(/busy or down \(503\) \(tried a, b\)/);
  });
});
