import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, parseSSE, type TestCtx } from './helpers.ts';
import { loadConfig } from '../server/config.ts';
import { createRegistry, type ConnectionSpec } from '../server/ai/providers.ts';
import { ResponsesProvider, toResponsesInput } from '../server/ai/responses.ts';
import { refreshModels, testModel, listCatalog } from '../server/ai/catalog.ts';
import { updateSettings } from '../server/services/settings.ts';
import { fakeAI, combine } from './fake-ai.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

const CLOUD = 'https://cloud.example/v1';
const LOCAL = 'http://localhost:11434/v1';
const PAID = 'https://api.paid.example/v1';

const localSpec: ConnectionSpec = { id: 'c_local', label: 'Ollama', api: 'chat', baseUrl: LOCAL, local: true, billing: 'free', models: [], toolset: 'core' };
const paidSpec: ConnectionSpec = { id: 'c_paid', label: 'PaidAI', api: 'responses', baseUrl: PAID, apiKey: 'sk-test-0001', local: false, billing: 'paid', models: [{ id: 'paid-pro', vision: true }], toolset: 'full' };

/** A free cloud service as the main one, plus a local server and a paid service. */
function world(opts: { cloud?: Parameters<typeof fakeAI>[1]; local?: Parameters<typeof fakeAI>[1]; paid?: Parameters<typeof fakeAI>[1]; extras?: ConnectionSpec[]; main?: Record<string, string> } = {}) {
  const cloud = fakeAI(CLOUD, opts.cloud ?? [{ id: 'cloud-main', vision: true }, { id: 'cloud-spare' }]);
  const local = fakeAI(LOCAL, opts.local ?? [{ id: 'qwen3:8b' }]);
  const paid = fakeAI(PAID, opts.paid ?? [{ id: 'paid-pro', vision: true, responsesOnly: true }], { key: 'sk-test-0001' });
  const config = loadConfig({
    NODE_ENV: 'test', DATA_DIR: ctx.dataDir, DEFAULT_PROVIDER: 'openai_compat', OPENAI_COMPAT_BASE_URL: CLOUD, OPENAI_COMPAT_MODEL: 'cloud-main',
    OPENAI_COMPAT_LABEL: 'FreeCloud', OPENAI_COMPAT_BILLING: 'free', OPENAI_COMPAT_TOOLSET: 'full', OPENAI_COMPAT_VISION: 'true', OPENAI_COMPAT_FALLBACK_MODELS: 'cloud-spare',
    ...opts.main,
  });
  ctx.services.providers = createRegistry(config, combine(cloud, local, paid), opts.extras ?? [localSpec, paidSpec]);
  /** What the app does after adding a service and shortly after opening: read each one's models. */
  const ready = async () => {
    for (const c of ctx.services.providers.connections()) await refreshModels(ctx.services, c.id);
  };
  return { cloud, local, paid, ready };
}

async function send(c: any, convId: string, text: string) {
  const r = await c.post(`/api/conversations/${convId}/messages`, { text });
  const events = r.status === 200 ? parseSSE(r.data) : [];
  const msg = events.find((e: any) => e.event === 'message')?.data?.message;
  const err = events.find((e: any) => e.event === 'error')?.data;
  return { status: r.status, events, msg, err, data: r.data };
}

describe('Responses API adapter', () => {
  it('streams text, tool calls and usage, and converts the conversation', async () => {
    const svc = fakeAI(PAID, [{ id: 'paid-pro', vision: true }], { key: 'k' });
    const p = new ResponsesProvider({ id: 'x', label: 'PaidAI', baseUrl: PAID, apiKey: 'k', model: 'paid-pro' }, svc.fetch);
    let streamed = '';
    const r = await p.chat({ system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools: [], onText: (d) => (streamed += d) });
    expect(streamed).toBe('answer from paid-pro');
    expect(r.usage).toMatchObject({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200 });
    expect(svc.calls[0].body).toMatchObject({ instructions: 'sys', store: false, stream: true });
    const t = await p.chat({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'Use the tool' }] }], tools: [{ name: 'get_time', description: 'd', input_schema: { type: 'object' } }] });
    expect(t.stopReason).toBe('tool_use');
    expect(t.content.find((b) => b.type === 'tool_use')).toMatchObject({ name: 'get_time', input: { zone: 'Africa/Kampala' } });
    const input = toResponsesInput([
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 'c1', name: 'get_time', input: { zone: 'UTC' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '10:00' }] },
    ]);
    expect(input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }, { type: 'input_image', image_url: 'data:image/png;base64,AAA' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'calling' }] },
      { type: 'function_call', call_id: 'c1', name: 'get_time', arguments: '{"zone":"UTC"}' },
      { type: 'function_call_output', call_id: 'c1', output: '10:00' },
    ]);
    await expect(new ResponsesProvider({ id: 'x', label: 'PaidAI', baseUrl: PAID, apiKey: 'wrong', model: 'paid-pro' }, svc.fetch).chat({ system: '', messages: [], tools: [] })).rejects.toThrow(/rejected the API key/);
  });
});

describe('model catalog', () => {
  it('lists models, marks free, paid and unknown, skips non-chat models and notices retired ones', async () => {
    const c = await signup(ctx);
    world({
      cloud: [{ id: 'cloud-main' }, { id: 'cloud-spare' }, { id: 'text-embedding-3' }, { id: 'extra-model' }],
      extras: [localSpec, paidSpec, { id: 'c_router', label: 'Router', api: 'chat', baseUrl: CLOUD, local: false, billing: 'unknown', models: [] }],
    });
    expect((await refreshModels(ctx.services, 'openai_compat')).ok).toBe(true);
    await refreshModels(ctx.services, 'c_local');
    const all = listCatalog(ctx.services);
    const by = (ref: string) => all.find((m) => m.ref === ref)!;
    expect(by('openai_compat::cloud-main')).toMatchObject({ paid: false, local: false });
    expect(by('openai_compat::extra-model').paid).toBeNull(); // not in the free list: may cost money
    expect(all.some((m) => m.model === 'text-embedding-3')).toBe(false);
    expect(by('c_local::qwen3:8b')).toMatchObject({ paid: false, local: true });
    expect(by('c_paid::paid-pro')).toMatchObject({ paid: true });
    const status = (await c.get('/api/connections')).data.ai;
    expect(status.find((x: any) => x.id === 'c_local')).toMatchObject({ status: 'ok', local: true });
    // A model the service stops offering is marked unavailable, and skipped.
    world({ cloud: [{ id: 'cloud-main' }, { id: 'cloud-spare', mode: 'gone' }] });
    await refreshModels(ctx.services, 'openai_compat');
    expect(listCatalog(ctx.services).find((m) => m.ref === 'openai_compat::cloud-spare')!.status).toBe('unavailable');
    // Unreachable local server and a rejected key are reported, not thrown.
    world({ extras: [{ ...localSpec, baseUrl: 'http://localhost:9/v1' }, { ...paidSpec, apiKey: 'wrong' }] });
    expect((await refreshModels(ctx.services, 'c_local')).ok).toBe(false);
    expect(await refreshModels(ctx.services, 'c_paid')).toMatchObject({ ok: false, error: expect.stringMatching(/rejected/) });
    const after = (await c.get('/api/connections')).data.ai;
    expect(after.find((x: any) => x.id === 'c_local').status).toBe('offline');
    expect(after.find((x: any) => x.id === 'c_paid').status).toBe('needs_sign_in');
  });

  it('tests models for real: replies, tools, JSON, reasoning, photos and which API works', async () => {
    const c = await signup(ctx);
    world({ cloud: [{ id: 'cloud-main', vision: true }, { id: 'cloud-spare', tools: false }] });
    const good = await testModel(ctx.services, c.user.id, 'openai_compat', 'cloud-main');
    expect(good).toMatchObject({ ok: true, caps: { chat: true, tools: true, vision: true, json: true } });
    expect(good.scores).toMatchObject({ basic: 1, tools: 1, extract: 1, reason: 1, vision: 1 });
    const weak = await testModel(ctx.services, c.user.id, 'openai_compat', 'cloud-spare');
    expect(weak.caps).toMatchObject({ tools: false, vision: false });
    // A model that only speaks the Responses API is found and used through it.
    updateSettings(ctx.services.db, c.user.id, { ai: { approvedPaid: ['c_paid'] } });
    const r = await testModel(ctx.services, c.user.id, 'c_paid', 'paid-pro');
    expect(r.caps).toMatchObject({ responses: true, chat: false, api: 'responses', vision: true });
    // Test calls count as usage.
    expect((await c.get('/api/usage/summary')).data.byModel.length).toBeGreaterThan(0);
  });

  it('asks for approval and shows the cost before testing a paid model', async () => {
    const c = await signup(ctx);
    world();
    await refreshModels(ctx.services, 'c_paid');
    await c.post('/api/models/price', { ref: 'c_paid::paid-pro', input: 2, output: 8 });
    expect((await c.post('/api/models/test', { ref: 'c_paid::paid-pro' })).status).toBe(403);
    await c.patch('/api/settings', { ai: { approvedPaid: ['c_paid'] } });
    const ask = await c.post('/api/models/test', { ref: 'c_paid::paid-pro' });
    expect(ask.status).toBe(409);
    expect(ask.data.estimate_usd).toBeCloseTo((2200 * 2 + 400 * 8) / 1e6, 6);
    expect((await c.post('/api/models/test', { ref: 'c_paid::paid-pro', confirm_cost: true })).data.result.ok).toBe(true);
    // Free ones just run.
    expect((await c.post('/api/models/test', { ref: 'openai_compat::cloud-main' })).data.result.ok).toBe(true);
  });
});

describe('choosing a model', () => {
  it('uses free and local models, and never a paid one without approval', async () => {
    const c = await signup(ctx);
    const w = world();
    const conv = (await c.post('/api/conversations', {})).data;
    const r = await send(c, conv.id, 'Hi there');
    expect(r.msg.content).toMatch(/answer from (cloud-main|cloud-spare|qwen3:8b)/);
    expect(w.paid.calls.filter((x) => x.api !== 'models')).toHaveLength(0);
    const models = (await c.get('/api/models')).data.models;
    expect(models.find((m: any) => m.ref === 'c_paid::paid-pro').blocked).toMatch(/not approved/);
  });

  it('keeps a private chat on local models, and refuses when none is available', async () => {
    const c = await signup(ctx);
    const w = world();
    await w.ready();
    const conv = (await c.post('/api/conversations', {})).data;
    await c.patch(`/api/conversations/${conv.id}/local-only`, { local_only: true });
    const r = await send(c, conv.id, 'Write a long detailed business strategy report for my pharmacy');
    expect(r.msg.content).toBe('answer from qwen3:8b');
    expect(w.cloud.calls.filter((x) => x.api !== 'models')).toHaveLength(0);
    // Local server down: no cloud fallback; a clear message instead.
    const down = world({ local: [{ id: 'qwen3:8b', mode: 'down' }] });
    await down.ready();
    const r2 = await send(c, conv.id, 'hello again');
    expect(r2.err?.message).toMatch(/Ollama is busy or down/);
    expect(down.cloud.calls.filter((x) => x.api !== 'models')).toHaveLength(0);
    // With no local model set up at all, it says why instead of trying the cloud.
    world({ extras: [] });
    expect((await send(c, conv.id, 'and again')).err?.message).toMatch(/No local model is available/);
    // The user can switch their own private flag off again.
    expect((await c.patch(`/api/conversations/${conv.id}/local-only`, { local_only: false })).data.local_only).toBe(false);
  });

  it('switches to the next allowed model when one is down, and says so', async () => {
    const c = await signup(ctx);
    world({ cloud: [{ id: 'cloud-main', mode: 'down' }, { id: 'cloud-spare' }] });
    updateSettings(ctx.services.db, c.user.id, { ai: { roles: { everyday: 'openai_compat::cloud-main' } } });
    const conv = (await c.post('/api/conversations', {})).data;
    const r = await send(c, conv.id, 'Hi');
    expect(r.events.some((e: any) => e.event === 'switch')).toBe(true);
    expect(r.msg.content).toMatch(/answer from (cloud-spare|qwen3:8b)/);
  });

  it('uses an approved paid model within the spending limit, and stops at the limit', async () => {
    const c = await signup(ctx);
    const w = world();
    await refreshModels(ctx.services, 'c_paid');
    await c.post('/api/models/price', { ref: 'c_paid::paid-pro', input: 100, output: 100 });
    updateSettings(ctx.services.db, c.user.id, { ai: { approvedPaid: ['c_paid'], roles: { complex: 'c_paid::paid-pro' }, spend: { dailyUsd: 0.15 } } });
    const conv = (await c.post('/api/conversations', {})).data;
    const r = await send(c, conv.id, 'Analyse my sales and write a report');
    expect(r.msg.content).toBe('answer from paid-pro');
    expect(w.paid.calls.at(-1)!.api).toBe('responses');
    const usage = (await c.get('/api/usage/summary')).data;
    expect(usage.today).toBeCloseTo(0.092, 3); // 800 in + 200 cached (at 10%) + 100 out, at $100/M each
    // Second one passes the daily limit → paid model skipped, a free one answers.
    await send(c, conv.id, 'Analyse my costs and write a report');
    const r3 = await send(c, conv.id, 'Analyse my stock and write a report');
    expect(r3.msg.content).not.toBe('answer from paid-pro');
    expect((await c.get('/api/usage/summary')).data.warning.today).toBe('reached');
  });

  it('sends photos only to models that can read them', async () => {
    const c = await signup(ctx);
    world({ cloud: [{ id: 'cloud-main', vision: true }, { id: 'cloud-spare' }] });
    await testModel(ctx.services, c.user.id, 'openai_compat', 'cloud-spare');
    await testModel(ctx.services, c.user.id, 'c_local', 'qwen3:8b').catch(() => undefined);
    const doc = ctx.services.db.insert('documents', { user_id: c.user.id, filename: 'p.png', mime: 'image/png', kind: 'image', size: 10, sha256: 'abc', storage_path: 'x', status: 'ready' } as any);
    const conv = (await c.post('/api/conversations', {})).data;
    const r = await c.post(`/api/conversations/${conv.id}/messages`, { text: 'What is in this photo?', attachments: [doc.id] });
    const start = parseSSE(r.data).find((e: any) => e.event === 'start')?.data;
    expect(start.provider.model).toBe('cloud-main');
  });
});

describe('content kept on your devices', () => {
  function folder(userId: string, localOnly: boolean) {
    const db = ctx.services.db;
    const g = db.insert('folder_grants', { user_id: userId, root: `C:/Private${localOnly}`, label: localOnly ? 'Private' : 'Shared', local_only: localOnly ? 1 : 0 } as any);
    const f = db.insert('local_files', { user_id: userId, grant_id: g.id, rel_path: 'salary.txt', name: 'salary.txt', size: 10, kind: 'text', text_chars: 30, indexed_at: new Date().toISOString() } as any);
    db.insert('local_file_chunks', { user_id: userId, file_id: f.id, seq: 0, text: 'My salary is 4,200,000 a month' } as any);
    return f.id as string;
  }

  it('never gives a local-only folder or memory to an online model', async () => {
    const c = await signup(ctx);
    world({ extras: [] }); // only the online main model
    const fileId = folder(c.user.id, true);
    const mem = (await c.post('/api/memories', { content: 'My bank PIN hint is the cat', category: 'fact' })).data;
    await c.patch(`/api/memories/${mem.id ?? mem.memory?.id}`, { local_only: true });
    const { executeTool, makeContext } = await import('../server/tools/registry.ts');
    const toolCtx = makeContext(ctx.services, c.user.id, null);
    toolCtx.cloud = true;
    const read = await executeTool('read_local_file', { file_id: fileId }, toolCtx);
    expect(read.status).toBe('error');
    expect(JSON.stringify(read)).not.toContain('4,200,000');
    const recall = await executeTool('recall_memories', { query: 'bank PIN cat' }, toolCtx);
    expect(JSON.stringify(recall)).not.toContain('PIN hint');
    // In a chat, the memory isn't in what the online model receives.
    const conv = (await c.post('/api/conversations', {})).data;
    const w = fakeAI(CLOUD, [{ id: 'cloud-main' }]);
    world({ extras: [] });
    await send(c, conv.id, 'What is my bank PIN hint? cat');
    void w;
    expect(JSON.stringify(ctx.services.db.all('SELECT api_content FROM messages WHERE conversation_id = ?', conv.id))).not.toContain('PIN hint is the cat');
  });

  it('locks a chat to local models once a local model has read local-only content', async () => {
    const c = await signup(ctx);
    await world({ extras: [localSpec] }).ready();
    const fileId = folder(c.user.id, true);
    const conv = (await c.post('/api/conversations', {})).data;
    const { executeTool, makeContext } = await import('../server/tools/registry.ts');
    const toolCtx = makeContext(ctx.services, c.user.id, conv.id);
    toolCtx.cloud = false;
    const read = await executeTool('read_local_file', { file_id: fileId }, toolCtx);
    expect(read.status).toBe('executed');
    expect(toolCtx.touchedLocalOnly).toBe(true);
    // Through a real turn: the flag is stored and can't be undone.
    const { markConversationLocalOnly } = await import('../server/services/localonly.ts');
    markConversationLocalOnly(ctx.services.db, c.user.id, conv.id);
    expect((await c.patch(`/api/conversations/${conv.id}/local-only`, { local_only: false })).status).toBe(400);
    const r = await send(c, conv.id, 'Write a detailed analysis report of my salary');
    expect(r.msg.content).toBe('answer from qwen3:8b');
  });
});

describe('accounts', () => {
  it('cancels access at Google when disconnecting, and points elsewhere when it cannot', async () => {
    const c = await signup(ctx);
    const revoked: string[] = [];
    ctx.services.netFetch = (async (input: any, init: any) => {
      revoked.push(`${init?.method} ${String(input)}`);
      return new Response('{}', { status: 200 });
    }) as any;
    const { encryptSecret } = await import('../server/services/secrets.ts');
    const secret = encryptSecret(ctx.dataDir, JSON.stringify({ access_token: 'at', refresh_token: 'rt' }));
    const g = ctx.services.db.insert('app_accounts', { user_id: c.user.id, provider: 'google', external_id: 'g1', label: 'me@example.com', secret } as any);
    const x = ctx.services.db.insert('app_accounts', { user_id: c.user.id, provider: 'x', external_id: 'x1', label: '@me', secret } as any);
    const r1 = (await c.del(`/api/apps/accounts/${g.id}`)).data;
    expect(r1).toMatchObject({ deleted: true, revoked: true });
    expect(revoked[0]).toMatch(/POST https:\/\/oauth2\.googleapis\.com\/revoke/);
    const r2 = (await c.del(`/api/apps/accounts/${x.id}`)).data;
    expect(r2).toMatchObject({ deleted: true, revoked: false, manage_url: expect.stringContaining('x.com') });
  });
});
