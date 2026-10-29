import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error plain JavaScript Worker
import worker, { Inbox } from '../relay/worker.js';

/** A Durable Object's SQL storage, backed by node:sqlite. */
function storage() {
  const db = new DatabaseSync(':memory:');
  return {
    sql: {
      exec(sql: string, ...params: unknown[]) {
        const rows = params.length || /^\s*select/i.test(sql) ? (db.prepare(sql).all(...(params as any[])) as any[]) : (db.exec(sql), []);
        return { toArray: () => rows, one: () => rows[0] };
      },
    },
  };
}

function relay(secrets: Record<string, string> = {}) {
  const inbox = new Inbox({ storage: storage() }, secrets);
  const env = { ...secrets, INBOX: { idFromName: () => 'id', get: () => inbox } };
  return (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://relay.test${path}`, init), env) as Promise<Response>;
}

const KEY = 'k'.repeat(32);
const auth = (key = KEY) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });

describe('WhatsApp relay (Cloudflare Worker)', () => {
  it('is claimed once, answers Meta’s check, and holds deliveries until collected', async () => {
    const call = relay();
    expect((await call('/')).status).toBe(200);
    expect((await call('/inbox', { headers: auth() })).status).toBe(401);
    expect((await call('/setup', { method: 'POST', headers: auth('short'), body: '{}' })).status).toBe(400);
    expect((await call('/setup', { method: 'POST', headers: auth(), body: JSON.stringify({ verify_token: 'verify-123' }) })).status).toBe(200);
    // Someone else can't take it over; the owner can update it.
    expect((await call('/setup', { method: 'POST', headers: auth('m'.repeat(32)), body: JSON.stringify({ verify_token: 'evil-token' }) })).status).toBe(409);
    expect((await call('/setup', { method: 'POST', headers: auth(), body: JSON.stringify({ verify_token: 'verify-456' }) })).status).toBe(200);

    expect(await (await call('/webhook?hub.mode=subscribe&hub.verify_token=verify-456&hub.challenge=ch1')).text()).toBe('ch1');
    expect((await call('/webhook?hub.mode=subscribe&hub.verify_token=verify-123&hub.challenge=ch1')).status).toBe(403);

    expect((await call('/webhook', { method: 'POST', body: '{"a":1}' })).status).toBe(401);
    expect((await call('/webhook', { method: 'POST', body: '{"a":1}', headers: { 'x-hub-signature-256': 'sha256=abc' } })).status).toBe(200);
    await call('/webhook', { method: 'POST', body: '{"a":2}', headers: { 'x-hub-signature-256': 'sha256=def' } });

    expect((await call('/inbox', { headers: auth('m'.repeat(32)) })).status).toBe(401);
    const { items } = await (await call('/inbox', { headers: auth() })).json() as any;
    expect(items.map((i: any) => [i.body, i.sig])).toEqual([['{"a":1}', 'sha256=abc'], ['{"a":2}', 'sha256=def']]);
    await call('/ack', { method: 'POST', headers: auth(), body: JSON.stringify({ ids: [items[0].id] }) });
    const after = await (await call('/inbox', { headers: auth() })).json() as any;
    expect(after.items.map((i: any) => i.body)).toEqual(['{"a":2}']);
  });

  it('lets the Cloudflare account owner reclaim it with the claim key', async () => {
    const call = relay({ CLAIM_KEY: 'c'.repeat(32) });
    await call('/setup', { method: 'POST', headers: auth(), body: JSON.stringify({ verify_token: 'verify-123' }) });
    expect((await call('/setup', { method: 'POST', headers: auth('m'.repeat(32)), body: JSON.stringify({ verify_token: 'verify-999' }) })).status).toBe(409);
    expect((await call('/setup', { method: 'POST', headers: auth('c'.repeat(32)), body: JSON.stringify({ verify_token: 'verify-999' }) })).status).toBe(200);
    expect((await call('/inbox', { headers: auth() })).status).toBe(401);
    expect((await call('/inbox', { headers: auth('c'.repeat(32)) })).status).toBe(200);
  });

  it('refuses oversized deliveries', async () => {
    const call = relay();
    const r = await call('/webhook', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1), headers: { 'x-hub-signature-256': 'sha256=abc' } });
    expect(r.status).toBe(413);
  });
});
