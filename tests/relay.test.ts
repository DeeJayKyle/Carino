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

/** A delivery shaped like Meta's (made-up numbers). */
const wa = (n: number, phone = '1000001') => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { phone_number_id: phone }, messages: [{ id: `wamid.${n}`, from: '256700000000', type: 'text', text: { body: `hi ${n}` } }] } }] }] });

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

    expect((await call('/webhook', { method: 'POST', body: wa(1) })).status).toBe(401);
    expect((await call('/webhook', { method: 'POST', body: wa(1), headers: { 'x-hub-signature-256': 'sha256=abc' } })).status).toBe(200);
    await call('/webhook', { method: 'POST', body: wa(2), headers: { 'x-hub-signature-256': 'sha256=def' } });

    expect((await call('/inbox', { headers: auth('m'.repeat(32)) })).status).toBe(401);
    const { items } = await (await call('/inbox', { headers: auth() })).json() as any;
    expect(items.map((i: any) => [i.body, i.sig])).toEqual([[wa(1), 'sha256=abc'], [wa(2), 'sha256=def']]);
    await call('/ack', { method: 'POST', headers: auth(), body: JSON.stringify({ ids: [items[0].id] }) });
    const after = await (await call('/inbox', { headers: auth() })).json() as any;
    expect(after.items.map((i: any) => i.body)).toEqual([wa(2)]);
  });

  it('turns away junk and floods without dropping waiting messages', async () => {
    const call = relay();
    await call('/setup', { method: 'POST', headers: auth(), body: JSON.stringify({ verify_token: 'verify-123', phone_number_id: '1000001' }) });
    const post = (body: string, ip = '203.0.113.5') => call('/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=abc', 'cf-connecting-ip': ip } });
    expect((await post('{"a":1}')).status).toBe(403);
    expect((await post(wa(1, '9999999'))).status).toBe(403); // another business's number
    expect((await post(wa(1))).status).toBe(200);
    let limited = 0;
    for (let i = 0; i < 130; i++) if ((await post(wa(100 + i), '198.51.100.7')).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    const { items } = await (await call('/inbox', { headers: auth() })).json() as any;
    expect(items[0].body).toBe(wa(1)); // the real one is still first in line
  });

  it('with the app secret, checks Meta’s signature itself', async () => {
    const { createHmac } = await import('node:crypto');
    const call = relay({ APP_SECRET: 'app-secret-123' });
    await call('/setup', { method: 'POST', headers: auth(), body: JSON.stringify({ verify_token: 'verify-123' }) });
    const body = wa(1);
    const good = `sha256=${createHmac('sha256', 'app-secret-123').update(body).digest('hex')}`;
    expect((await call('/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=forged' } })).status).toBe(403);
    expect((await call('/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': good } })).status).toBe(200);
  });

  it('a hand-deployed relay can require a setup code to be claimed', async () => {
    const call = relay({ SETUP_CODE: 'setup-code-77' });
    const setup = (code?: string) => call('/setup', { method: 'POST', headers: { ...auth(), ...(code ? { 'x-setup-code': code } : {}) }, body: JSON.stringify({ verify_token: 'verify-123' }) });
    expect((await setup()).status).toBe(403);
    expect((await setup('wrong')).status).toBe(403);
    expect((await setup('setup-code-77')).status).toBe(200);
    expect((await setup()).status).toBe(200); // the owner updating it later doesn't need the code again
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
