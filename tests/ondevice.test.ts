import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, text, toolCall, type TestCtx } from './helpers.ts';
import { toolSpecs, PHONE_TOOLS } from '../server/tools/registry.ts';
import { configToEnv, PRESETS, LOCAL_MODELS, ON_DEVICE_BASE_URL } from '../mobile/presets.ts';
import { OpenAICompatProvider } from '../server/ai/openai-compat.ts';
import { createRegistry } from '../server/ai/providers.ts';
import { loadConfig } from '../server/config.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

describe('AI on this phone', () => {
  it('is offered as a service with no key, pointing at the phone itself', () => {
    const p = PRESETS.find((x) => x.id === 'phone')!;
    expect(p.onDevice).toBe(true);
    expect(p.models.map((m) => m.id)).toEqual(LOCAL_MODELS.map((m) => m.id));
    for (const m of LOCAL_MODELS) expect(m.url).toMatch(/^https:\/\/huggingface\.co\/.+\.gguf$/);
    const env = configToEnv({ provider: 'phone', model: 'qwen3-0.6b', apiKey: 'ignored' });
    expect(env).toMatchObject({ OPENAI_COMPAT_BASE_URL: ON_DEVICE_BASE_URL, OPENAI_COMPAT_MODEL: 'qwen3-0.6b', OPENAI_COMPAT_TOOLSET: 'phone', OPENAI_COMPAT_VISION: 'false', DEFAULT_PROVIDER: 'openai_compat' });
    expect(env.OPENAI_COMPAT_API_KEY).toBeUndefined();
    expect(env.OPENAI_COMPAT_FALLBACK_MODELS).toBeUndefined();
  });

  it('counts as local, and its requests go to the phone, never the network', async () => {
    const seen: string[] = [];
    const reg = createRegistry(loadConfig({ ...configToEnv({ provider: 'phone', model: 'qwen3-1.7b' }), DATA_DIR: ctx.dataDir }), (async (url: any) => {
      seen.push(String(url));
      const sse = 'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch);
    const p = reg.resolve({ localOnly: true });
    expect(p).toBeInstanceOf(OpenAICompatProvider);
    expect(p.info().capabilities).toMatchObject({ local: true, toolset: 'phone', vision: false });
    const r = await p.chat({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools: [] });
    expect(r.content).toEqual([{ type: 'text', text: 'Hi' }]);
    expect(seen).toEqual([`${ON_DEVICE_BASE_URL}/chat/completions`]);
  });

  it('gives the small model a short list of everyday tools with short descriptions', () => {
    const phone = toolSpecs('phone');
    expect(phone.map((t) => t.name).sort()).toEqual([...PHONE_TOOLS].sort());
    expect(JSON.stringify(phone).length).toBeLessThan(JSON.stringify(toolSpecs('core')).length / 2);
    const reminder = phone.find((t) => t.name === 'create_reminder')!;
    expect(reminder.input_schema).toMatchObject({ required: ['title', 'when'] });
    expect(JSON.stringify(reminder)).not.toMatch(/maxLength|task_id/);
    for (const t of phone) expect(t.description.length).toBeLessThanOrEqual(160);
  });

  it('uses the short prompt and phone tools in chat, and the tools still work', async () => {
    ctx.provider.toolset = 'phone';
    const c = await signup(ctx);
    const conv = (await c.post('/api/conversations', {})).data;
    ctx.provider.steps.push(() => toolCall('log_expense', { amount: 20000, category: 'food', note: 'Lunch' }));
    ctx.provider.steps.push(() => text('Logged.'));
    await c.post(`/api/conversations/${conv.id}/messages`, { text: 'I spent 20000 on lunch' });
    const req = ctx.provider.calls[0];
    expect(req.system.length).toBeLessThan(600);
    expect(req.system).toContain('CALL THE TOOL');
    expect(req.tools.map((t) => t.name).sort()).toEqual([...PHONE_TOOLS].sort());
    expect(JSON.stringify(req.messages)).toContain('call log_expense');
    expect((await c.get('/api/money')).data.expenses[0]).toMatchObject({ amount: 20000, category: 'food' });
  });

  it('other models keep the full prompt and tools', async () => {
    const c = await signup(ctx);
    const conv = (await c.post('/api/conversations', {})).data;
    ctx.provider.steps.push(() => text('Hi'));
    await c.post(`/api/conversations/${conv.id}/messages`, { text: 'hello' });
    expect(ctx.provider.calls[0].system.length).toBeGreaterThan(2000);
    expect(ctx.provider.calls[0].tools.length).toBeGreaterThan(PHONE_TOOLS.size + 10);
  });
});
