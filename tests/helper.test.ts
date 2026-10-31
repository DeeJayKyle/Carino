import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error plain JavaScript Worker
import worker, { WaHub } from '../auth/worker.js';

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

const SECRETS = {
  GOOGLE_CLIENT_ID: 'g-id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'g-secret',
  MS_CLIENT_ID: 'ms-id', MS_CLIENT_SECRET: 'ms-secret',
  META_APP_ID: '1234', META_APP_SECRET: 'meta-secret-0123456789',
  X_CLIENT_ID: 'x-id', X_CLIENT_SECRET: 'x-secret',
  TIKTOK_CLIENT_KEY: 'tt-key', TIKTOK_CLIENT_SECRET: 'tt-secret',
  WA_PHONE_NUMBER_ID: '5550100', WA_ACCESS_TOKEN: 'wa-token', WA_VERIFY_TOKEN: 'verify-me', WA_DISPLAY_NUMBER: '+1 555 0100',
};

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
let calls: Call[];
let env: any;

function setup(secrets: Record<string, string> = SECRETS) {
  const hub = new WaHub({ storage: storage() }, secrets);
  env = { ...secrets, WA: { idFromName: () => 'hub', get: () => hub } };
}
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://carino-auth.qa.workers.dev${path}`, init), env) as Promise<Response>;
const sent = () => calls.filter((c) => c.url.endsWith('/5550100/messages')).map((c) => JSON.parse(c.body));

beforeEach(() => {
  calls = [];
  setup();
  vi.stubGlobal('fetch', async (input: any, init: any = {}) => {
    const req = new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const body = req.method === 'GET' ? '' : await req.text();
    calls.push({ url: req.url, method: req.method, headers, body });
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (req.url === 'https://oauth2.googleapis.com/token') {
      const p = new URLSearchParams(body);
      if (p.get('code') === 'bad') return j({ error: 'invalid_grant', error_description: 'Bad code' }, 400);
      return j({ access_token: 'g-at', refresh_token: 'g-rt', expires_in: 3600 });
    }
    if (req.url === 'https://api.x.com/2/oauth2/token') return j({ access_token: 'x-at', expires_in: 7200 });
    if (req.url === 'https://open.tiktokapis.com/v2/oauth/token/') return j({ access_token: 'tt-at', expires_in: 86400 });
    if (req.url.startsWith('https://graph.facebook.com/v23.0/oauth/access_token?')) return j({ access_token: 'fb-long', expires_in: 5184000 });
    if (req.url === 'https://graph.facebook.com/v23.0/oauth/access_token') return j({ access_token: 'fb-short', expires_in: 3600 });
    if (req.url.endsWith('/5550100/messages')) return j({ messages: [{ id: 'wamid' }] });
    if (req.url === 'https://graph.facebook.com/v23.0/media1') return j({ url: 'https://lookaside.fbsbx.test/media1', mime_type: 'audio/ogg' });
    if (req.url === 'https://lookaside.fbsbx.test/media1') return new Response(new Uint8Array([1, 2, 3]));
    throw new Error(`unexpected fetch ${req.method} ${req.url}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('Sign-in helper: one-tap sign-in', () => {
  it('lists configured apps by their public client IDs only', async () => {
    const c = await (await call('/config')).json() as any;
    expect(Object.keys(c.providers).sort()).toEqual(['facebook', 'google', 'instagram', 'microsoft', 'tiktok', 'x']);
    expect(c.providers.google).toEqual({ client_id: 'g-id.apps.googleusercontent.com' });
    expect(JSON.stringify(c)).not.toMatch(/secret|wa-token/);
    expect(c.whatsapp).toEqual({ number: '+1 555 0100' });
  });

  it('hands the code from the provider to the phone’s loopback listener, escaped', async () => {
    const r = await call('/callback/google?code=abc%22%3Cscript%3E&state=s1');
    const html = await r.text();
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(html).toContain('http://127.0.0.1:47823/callback?code=abc%22%3Cscript%3E&amp;state=s1&amp;provider=google');
    expect(html).not.toContain('<script>"');
    expect((await call('/callback/evil')).status).toBe(404);
  });

  it('exchanges a code with the secret it keeps, for the right redirect address', async () => {
    const r = await (await call('/token', { method: 'POST', body: JSON.stringify({ provider: 'google', code: 'c1', code_verifier: 'v'.repeat(43) }) })).json() as any;
    expect(r).toEqual({ access_token: 'g-at', refresh_token: 'g-rt', expires_in: 3600 });
    const p = new URLSearchParams(calls[0].body);
    expect(Object.fromEntries(p)).toMatchObject({ grant_type: 'authorization_code', code: 'c1', client_id: 'g-id.apps.googleusercontent.com', client_secret: 'g-secret', redirect_uri: 'https://carino-auth.qa.workers.dev/callback/google', code_verifier: 'v'.repeat(43) });
    const bad = await call('/token', { method: 'POST', body: JSON.stringify({ provider: 'google', code: 'bad' }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe('Bad code');
  });

  it('uses Basic auth for X, client_key for TikTok, and swaps Meta tokens for 60-day ones', async () => {
    await call('/token', { method: 'POST', body: JSON.stringify({ provider: 'x', code: 'c' }) });
    expect(calls.at(-1)!.headers.authorization).toBe(`Basic ${btoa('x-id:x-secret')}`);
    await call('/token', { method: 'POST', body: JSON.stringify({ provider: 'tiktok', code: 'c' }) });
    expect(new URLSearchParams(calls.at(-1)!.body).get('client_key')).toBe('tt-key');
    const fb = await (await call('/token', { method: 'POST', body: JSON.stringify({ provider: 'facebook', code: 'c' }) })).json() as any;
    expect(fb.access_token).toBe('fb-long');
  });

  it('says plainly when an app isn’t set up', async () => {
    const r = await call('/token', { method: 'POST', body: JSON.stringify({ provider: 'linkedin', code: 'c' }) });
    expect(r.status).toBe(503);
    expect((await call('/token', { method: 'POST', body: JSON.stringify({ provider: 'nope', code: 'c' }) })).status).toBe(404);
  });
});

describe('Sign-in helper: the shared WhatsApp number', () => {
  const KEY = 'k'.repeat(40);
  const auth = (key = KEY) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
  const deliver = (from: string, message: Record<string, unknown>, secret = SECRETS.META_APP_SECRET) => {
    const body = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: 'Herbert' } }], messages: [{ from, id: `m${Math.random()}`, ...message }] } }] }] });
    return call('/whatsapp/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } });
  };

  it('verifies Meta’s webhook check and refuses unsigned deliveries', async () => {
    expect(await (await call('/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=c42')).text()).toBe('c42');
    expect((await call('/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=c42')).status).toBe(403);
    expect((await deliver('256700000001', { type: 'text', text: { body: 'hi' } }, 'forged')).status).toBe(401);
  });

  it('links a number with a code, queues its messages for that phone only, and replies only to it', async () => {
    const { code } = await (await call('/wa/register', { method: 'POST', headers: auth() })).json() as any;
    expect(code).toMatch(/^\d{6}$/);
    expect(((await (await call('/wa/status', { headers: auth() })).json()) as any).linked).toBe(false);

    // A stranger gets pointed to Carino (once an hour), and nothing is queued.
    await deliver('256799999999', { type: 'text', text: { body: 'hello?' } });
    await deliver('256799999999', { type: 'text', text: { body: 'hello??' } });
    expect(sent().filter((m) => m.to === '256799999999')).toHaveLength(1);

    await deliver('256700000001', { type: 'text', text: { body: code } });
    expect(sent().at(-1)).toMatchObject({ to: '256700000001', text: { body: expect.stringMatching(/linked to your Carino/) } });
    expect(await (await call('/wa/status', { headers: auth() })).json()).toMatchObject({ linked: true, wa_id: '256700000001', name: 'Herbert' });

    await deliver('256700000001', { type: 'text', text: { body: 'add milk' } });
    await deliver('256700000001', { type: 'audio', audio: { id: 'media1' } });
    const { items } = await (await call('/wa/inbox', { headers: auth() })).json() as any;
    expect(items.map((i: any) => i.message.type)).toEqual(['text', 'audio']);
    expect(items[0]).toMatchObject({ from: '256700000001', name: 'Herbert', message: { text: { body: 'add milk' } } });

    // Another phone can't read it, fetch its media, or send as it.
    const other = 'o'.repeat(40);
    await call('/wa/register', { method: 'POST', headers: auth(other) });
    expect(((await (await call('/wa/inbox', { headers: auth(other) })).json()) as any).items).toEqual([]);
    expect((await call('/wa/media/media1', { headers: auth(other) })).status).toBe(404);
    expect((await call('/wa/send', { method: 'POST', headers: auth(other), body: JSON.stringify({ text: 'x' }) })).status).toBe(409);
    expect((await call('/wa/inbox', { headers: auth('n'.repeat(40)) })).status).toBe(401);

    // The owner can.
    const media = await call('/wa/media/media1', { headers: auth() });
    expect([...new Uint8Array(await media.arrayBuffer())]).toEqual([1, 2, 3]);
    await call('/wa/send', { method: 'POST', headers: auth(), body: JSON.stringify({ text: 'Added milk.', buttons: [{ id: 'ok:1', title: 'Approve' }] }) });
    expect(sent().at(-1)).toMatchObject({ to: '256700000001', type: 'interactive', interactive: { action: { buttons: [{ reply: { id: 'ok:1', title: 'Approve' } }] } } });

    await call('/wa/ack', { method: 'POST', headers: auth(), body: JSON.stringify({ ids: items.map((i: any) => i.id) }) });
    expect(((await (await call('/wa/inbox', { headers: auth() })).json()) as any).items).toEqual([]);
  });

  it('is off until WhatsApp is set up', async () => {
    setup({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' });
    expect((await call('/wa/register', { method: 'POST', headers: auth() })).status).toBe(503);
    expect(((await (await call('/config')).json()) as any).whatsapp).toBeNull();
  });
});
