import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setup, signup, text, toolCall, type TestCtx } from './helpers.ts';
import { resetHelperCache } from '../server/services/helper.ts';
import { accessToken } from '../server/services/apps/accounts.ts';
import { pollRelay } from '../server/services/whatsapp-relay.ts';
// @ts-expect-error plain JavaScript Worker
import worker, { WaHub } from '../auth/worker.js';

/**
 * One-tap sign-in and the shared WhatsApp number, end to end: the app talks to the real sign-in
 * helper (auth/worker.js, run in-process), which talks to stand-ins for Google and WhatsApp.
 */
const HELPER = 'https://carino-auth.test';
const META_SECRET = 'meta-secret-0123456789';

function storage() {
  const db = new DatabaseSync(':memory:');
  return { sql: { exec(sql: string, ...params: unknown[]) {
    const rows = params.length || /^\s*select/i.test(sql) ? (db.prepare(sql).all(...(params as any[])) as any[]) : (db.exec(sql), []);
    return { toArray: () => rows, one: () => rows[0] };
  } } };
}

let ctx: TestCtx;
let seen: { url: string; body: string; headers: Record<string, string> }[];
let helperEnv: any;
let sentWa: any[];

beforeEach(() => {
  resetHelperCache();
  ctx = setup({ env: { CARINO_HELPER_URL: HELPER } });
  seen = [];
  sentWa = [];
  const secrets = {
    GOOGLE_CLIENT_ID: 'carino.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'g-secret',
    META_APP_ID: '1234', META_APP_SECRET: META_SECRET,
    WA_PHONE_NUMBER_ID: '5550100', WA_ACCESS_TOKEN: 'wa-token', WA_VERIFY_TOKEN: 'v', WA_DISPLAY_NUMBER: '+1 555-206-4808',
  };
  const hub = new WaHub({ storage: storage() }, secrets);
  helperEnv = { ...secrets, WA: { idFromName: () => 'hub', get: () => hub } };

  const net = (async (input: any, init: any = {}) => {
    const req = new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (req.url.startsWith(HELPER)) return worker.fetch(req, helperEnv);
    const body = req.method === 'GET' ? '' : await req.text();
    seen.push({ url: req.url, body, headers });
    if (req.url === 'https://oauth2.googleapis.com/token') {
      const p = new URLSearchParams(body);
      if (p.get('client_secret') !== 'g-secret') return j({ error: 'invalid_client' }, 401);
      return p.get('grant_type') === 'refresh_token' ? j({ access_token: 'g-at-2', expires_in: 3600 }) : j({ access_token: 'g-at-1', refresh_token: 'g-rt', expires_in: 3600 });
    }
    if (req.url === 'https://openidconnect.googleapis.com/v1/userinfo') return j({ sub: 'g1', email: 'herbert@gmail.com' });
    if (req.url === 'https://graph.facebook.com/v23.0/5550100/messages') { sentWa.push(JSON.parse(body)); return j({ messages: [{ id: 'wamid' }] }); }
    throw new Error(`unexpected fetch ${req.method} ${req.url}`);
  }) as typeof fetch;
  ctx.services.netFetch = net;
  // The helper's own calls (to Google, WhatsApp) use the global fetch.
  vi.stubGlobal('fetch', net);
});
afterEach(() => {
  vi.unstubAllGlobals();
  ctx.cleanup();
});

describe('One-tap sign-in through Carino’s helper', () => {
  it('offers one tap, signs in without any developer setup, and keeps the secret off the phone', async () => {
    const c = await signup(ctx);
    const apps = (await c.get('/api/apps')).data.apps;
    expect(apps.find((a: any) => a.id === 'google')).toMatchObject({ one_tap: true, client: null });
    expect(apps.find((a: any) => a.id === 'microsoft').one_tap).toBe(false);

    const start = await c.post('/api/apps/google/start');
    expect(start.data.one_tap).toBe(true);
    const u = new URL(start.data.authorize_url);
    expect(u.searchParams.get('client_id')).toBe('carino.apps.googleusercontent.com');
    expect(u.searchParams.get('redirect_uri')).toBe(`${HELPER}/callback/google`);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');

    // The provider sends the browser to the helper, whose page hands the code to the phone.
    const page = await (await worker.fetch(new Request(`${HELPER}/callback/google?code=the-code&state=${u.searchParams.get('state')}`), helperEnv)).text();
    const back = new URL(page.match(/href="([^"]+)"/)![1].replace(/&amp;/g, '&'));
    expect(back.origin + back.pathname).toBe('http://127.0.0.1:47823/callback');
    const done = await c.post('/api/oauth/finish', Object.fromEntries(back.searchParams));
    expect(done.data).toEqual({ kind: 'app', provider: 'google', label: 'herbert@gmail.com' });

    // Google got the secret from the helper, and the PKCE verifier from the phone.
    const exchange = new URLSearchParams(seen.find((s) => s.url === 'https://oauth2.googleapis.com/token')!.body);
    expect(exchange.get('client_secret')).toBe('g-secret');
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(u.searchParams.get('code_challenge'));
    expect(exchange.get('redirect_uri')).toBe(`${HELPER}/callback/google`);

    // Renewal goes through the helper too.
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 2 * 3600_000);
    const row = ctx.services.db.get("SELECT * FROM app_accounts WHERE provider = 'google'")!;
    expect(await accessToken(ctx.services, row)).toBe('g-at-2');
    expect(new URLSearchParams(seen.filter((s) => s.url === 'https://oauth2.googleapis.com/token').at(-1)!.body).get('grant_type')).toBe('refresh_token');
  });

  it('still uses the user’s own developer app when they set one up', async () => {
    const c = await signup(ctx);
    await c.req('PUT', '/api/apps/clients/google', { client_id: 'mine.apps.googleusercontent.com', client_secret: 'mine' });
    const u = new URL((await c.post('/api/apps/google/start')).data.authorize_url);
    expect(u.searchParams.get('client_id')).toBe('mine.apps.googleusercontent.com');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost/api/apps/callback');
  });

  it('falls back to manual setup when the helper can’t be reached', async () => {
    const c = await signup(ctx);
    ctx.services.netFetch = (async () => { throw new TypeError('offline'); }) as any;
    resetHelperCache();
    expect((await c.get('/api/apps')).data.apps[0].one_tap).toBe(false);
    expect((await c.post('/api/apps/google/start')).data.error).toMatch(/client ID first/);
  });
});

describe('The shared WhatsApp number', () => {
  const deliver = (from: string, message: Record<string, unknown>) => {
    const body = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: 'Herbert' } }], messages: [{ from, id: `m${Math.random()}`, ...message }] } }] }] });
    return worker.fetch(new Request(`${HELPER}/whatsapp/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', META_SECRET).update(body).digest('hex')}` } }), helperEnv);
  };

  it('links by code, answers through the helper, and keeps approvals working', async () => {
    // Approvals are timestamped by the database's own clock, so this test runs on real time.
    ctx.clock.now = new Date();
    const c = await signup(ctx);
    expect((await c.get('/api/channels')).data.shared_whatsapp).toEqual({ number: '+1 555-206-4808' });
    const l = (await c.post('/api/channels/whatsapp/shared/link')).data;
    expect(l).toMatchObject({ code: expect.stringMatching(/^\d{6}$/), number: '+1 555-206-4808', link: `https://wa.me/15552064808?text=${l.code}` });
    expect((await c.get('/api/channels/whatsapp/shared/status')).data.linked).toBe(false);

    await deliver('256700000001', { type: 'text', text: { body: l.code } });
    expect(sentWa.at(-1)).toMatchObject({ to: '256700000001', text: { body: expect.stringMatching(/linked to your Carino/) } });
    expect((await c.get('/api/channels/whatsapp/shared/status')).data).toEqual({ linked: true, wa_id: '256700000001' });
    const ch = (await c.get('/api/channels')).data.channels.find((x: any) => x.kind === 'whatsapp');
    expect(ch.chats).toHaveLength(1);

    // A message is collected from the helper and answered back through it.
    ctx.provider.steps.push(() => toolCall('delete_task', { task_id: 'nope' }), () => text('Done.'));
    await deliver('256700000001', { type: 'text', text: { body: 'add milk' } });
    expect(await pollRelay(ctx.services)).toBe(1);

    // The first reply ended with Approve / Decline buttons for the deletion.
    expect(sentWa.at(-1)).toMatchObject({ type: 'interactive', interactive: { action: { buttons: [{ reply: { title: 'Approve' } }, { reply: { title: 'Decline' } }] } } });
    await new Promise((r) => setTimeout(r, 20));
    ctx.clock.now = new Date();
    ctx.provider.steps.push(() => text('Hello Herbert!'));
    await deliver('256700000001', { type: 'text', text: { body: 'hi' } });
    await pollRelay(ctx.services);
    expect(sentWa.at(-1)).toMatchObject({ to: '256700000001', type: 'text', text: { body: 'Hello Herbert!' } });
    // Nothing is left waiting.
    expect(await pollRelay(ctx.services)).toBe(0);
  });

  it('unlinking removes the number from the helper', async () => {
    const c = await signup(ctx);
    const l = (await c.post('/api/channels/whatsapp/shared/link')).data;
    await deliver('256700000001', { type: 'text', text: { body: l.code } });
    await c.get('/api/channels/whatsapp/shared/status');
    expect((await c.del(`/api/channels/${l.channel_id}`)).status).toBe(200);
    sentWa.length = 0;
    await deliver('256700000001', { type: 'text', text: { body: 'still there?' } });
    // The number is a stranger again: pointed to Carino, nothing queued.
    expect(sentWa.at(-1).text.body).toMatch(/send me the 6-digit code/);
  });
});
