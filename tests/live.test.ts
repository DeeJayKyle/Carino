import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, type TestCtx } from './helpers.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

describe('live voice', () => {
  it('says what is missing when no live-capable service is connected', async () => {
    const c = await signup(ctx);
    const o = (await c.get('/api/live')).data;
    expect(o.available).toEqual([]);
    expect(o.reason).toMatch(/OpenAI or Google Gemini/);
    expect((await c.post('/api/live/session', { provider: 'openai' })).status).toBe(400);
  });

  it('hands the page a short-lived token, never the real key, with Carino’s tools', async () => {
    const c = await signup(ctx);
    ctx.services.providers.addConnection({ id: 'openai', label: 'OpenAI', api: 'responses', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-real-key', local: false, billing: 'paid', models: [{ id: 'm' }] });
    let sent: any;
    ctx.services.netFetch = (async (url: string, init: any) => {
      sent = { url, auth: init.headers.authorization, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ value: 'ek_short' }));
    }) as any;
    const r = (await c.post('/api/live/session', { provider: 'openai' })).data;
    expect(r.token).toBe('ek_short');
    expect(JSON.stringify(r)).not.toContain('sk-real-key');
    expect(sent.url).toContain('/realtime/client_secrets');
    expect(sent.auth).toBe('Bearer sk-real-key');
    expect(sent.body.session.tools.map((t: any) => t.name)).toContain('create_task');
    expect(sent.body.session.instructions).toMatch(/live voice conversation/);
  });

  it('runs allowed tools for the voice model and refuses others', async () => {
    const c = await signup(ctx);
    const ok = (await c.post('/api/live/tool', { name: 'create_task', args: { title: 'Buy milk' } })).data.output;
    expect(JSON.stringify(ok)).toMatch(/Buy milk|waiting/);
    const no = (await c.post('/api/live/tool', { name: 'change_local_files', args: {} })).data.output;
    expect(no.error).toMatch(/Not available/);
  });
});
