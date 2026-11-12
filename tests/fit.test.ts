import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, parseSSE, type TestCtx } from './helpers.ts';
import { loadConfig } from '../server/config.ts';
import { createRegistry } from '../server/ai/providers.ts';
import { refreshModels } from '../server/ai/catalog.ts';
import { fit, estimateTokens, pickTools } from '../server/ai/fit.ts';
import { tooLargeError } from '../server/ai/types.ts';
import { toolSpecs } from '../server/tools/registry.ts';
import { APP_TOOLS } from '../server/services/apps/index.ts';
import { fakeAI } from './fake-ai.ts';
import { z } from 'zod';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

const appSpecs = APP_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: z.toJSONSchema(t.input) as Record<string, unknown> }));
const allTools = () => [...toolSpecs('full'), ...appSpecs];
const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] });

describe('fitting requests into small models', () => {
  it('reads the limit from a service that says the request is too big', () => {
    const e = tooLargeError('Groq', 413, '{"error":{"message":"Request too large for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 13934, please reduce your message size"}}')!;
    expect(e.kind).toBe('too_large');
    expect(e.limit).toBe(8000);
    expect(e.message).toMatch(/8,000 tokens at a time.*13,934/);
    expect(tooLargeError('X', 429, 'Rate limit reached for tokens per minute')).toBeNull();
  });

  it('keeps the tools a message is about and drops the rest', () => {
    const picked = pickTools(allTools(), 'can you explore my Google drive', new Set(), 1).map((t) => t.name);
    expect(picked).toEqual(expect.arrayContaining(['drive_search', 'drive_read', 'create_task']));
    expect(picked).not.toContain('tiktok_upload_video');
    expect(picked).not.toContain('slack_send');
    const money = pickTools(allTools(), 'I spent 15k on lunch', new Set(), 1).map((t) => t.name);
    expect(money).toContain('log_expense');
  });

  it('fits everything under the limit, leaving room for the reply', () => {
    const tools = allTools();
    expect(estimateTokens(tools)).toBeGreaterThan(8000);
    const history = Array.from({ length: 30 }, (_, i) => user(`older message ${i} ${'x'.repeat(400)}`));
    const messages = [...history.flatMap((m) => [m, { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] }]), user('can you explore my Google drive')];
    const f = fit({ system: 's'.repeat(4000), messages, tools, text: 'can you explore my Google drive', turnStart: messages.length - 1, limit: 8000 });
    const size = estimateTokens('s'.repeat(4000)) + estimateTokens(f.messages) + estimateTokens(f.tools) + (f.maxTokens ?? 4096);
    expect(size).toBeLessThanOrEqual(8000);
    expect(f.tools.map((t) => t.name)).toContain('drive_search');
    expect(f.messages.at(-1)).toEqual(user('can you explore my Google drive'));
    // No limit known: everything goes.
    expect(fit({ system: 's', messages, tools, text: 'x', turnStart: 0, limit: null }).tools.length).toBe(tools.length);
  });

  it('when Groq says a request is too big, learns its limit and answers with a leaner one', async () => {
    const GROQ = 'https://api.groq.com/openai/v1';
    const svc = fakeAI(GROQ, [{ id: 'openai/gpt-oss-120b' }]);
    const sizes: number[] = [];
    const f: typeof fetch = async (input, init) => {
      const body = String(init?.body ?? '');
      if (String(input).endsWith('/chat/completions') && body.includes('"stream":true')) {
        sizes.push(body.length);
        // Like the free plan: anything above ~5,000 tokens is refused.
        if (body.length > 17_500) return new Response(JSON.stringify({ error: { message: `Request too large for model on tokens per minute (TPM): Limit 5000, Requested ${Math.round(body.length / 3.5)}` } }), { status: 413 });
      }
      return svc.fetch(input, init);
    };
    const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: ctx.dataDir, DEFAULT_PROVIDER: 'openai_compat', OPENAI_COMPAT_BASE_URL: GROQ, OPENAI_COMPAT_MODEL: 'openai/gpt-oss-120b', OPENAI_COMPAT_LABEL: 'Groq', OPENAI_COMPAT_BILLING: 'free', OPENAI_COMPAT_TOOLSET: 'full' });
    ctx.services.providers = createRegistry(config, f, []);
    for (const c of ctx.services.providers.connections()) await refreshModels(ctx.services, c.id);
    const c = await signup(ctx);
    const conv = (await c.post('/api/conversations', {})).data;
    const r = await c.post(`/api/conversations/${conv.id}/messages`, { text: 'can you explore my Google drive' });
    const events = parseSSE(r.data);
    expect(events.find((e: any) => e.event === 'error')).toBeUndefined();
    expect(events.find((e: any) => e.event === 'message')?.data?.message?.content).toMatch(/answer from/);
    expect(sizes.at(-1)!).toBeLessThanOrEqual(17_500);
    // Next time it starts small, without being refused first.
    const before = sizes.length;
    await c.post(`/api/conversations/${conv.id}/messages`, { text: '?' });
    expect(sizes.length).toBe(before + 1);
  });
});
