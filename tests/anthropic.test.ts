import { describe, it, expect } from 'vitest';
import { AnthropicProvider } from '../server/ai/anthropic.ts';

/** Exercises the Claude adapter against a stubbed HTTP layer (no network, no real key). */
function provider(responses: ((body: any) => Response)[], seen: any[]) {
  return new AnthropicProvider({
    apiKey: 'sk-test', model: 'claude-haiku-5-5', maxRetries: 0,
    fetch: (async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      seen.push(body);
      return responses.shift()!(body);
    }) as typeof fetch,
  });
}

const sseResponse = (text: string) => {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const badRequest = (message: string) => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), { status: 400, headers: { 'content-type': 'application/json' } });

const req = { system: 'sys', tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }], messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }] };

describe('Claude adapter', () => {
  it('streams text, sends caching + adaptive thinking, and reports cache usage', async () => {
    const seen: any[] = [];
    const deltas: string[] = [];
    const res = await provider([() => sseResponse('Hello!')], seen).chat({ ...req, onText: (d) => deltas.push(d) });
    expect(deltas.join('')).toBe('Hello!');
    expect(res.usage).toMatchObject({ inputTokens: 5010, outputTokens: 7, cacheReadTokens: 5000 });
    expect(seen[0]).toMatchObject({ model: 'claude-haiku-5-5', stream: true, thinking: { type: 'adaptive' }, cache_control: { type: 'ephemeral' }, fallbacks: 'default' });
    expect(seen[0].tools[0].eager_input_streaming).toBe(true);
  });

  it('retries without optional extras the API rejects', async () => {
    const seen: any[] = [];
    const res = await provider([
      () => badRequest('fallbacks: Extra inputs are not permitted'),
      () => badRequest('cache_control: not supported'),
      () => sseResponse('ok'),
    ], seen).chat(req);
    expect(res.content[0]).toMatchObject({ type: 'text', text: 'ok' });
    expect(seen[1].fallbacks).toBeUndefined();
    expect(seen[2].cache_control).toBeUndefined();
  });

  it('explains an empty credit balance in plain language', async () => {
    const p = provider([1, 2, 3].map(() => () => badRequest('Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.')), []);
    await expect(p.chat(req)).rejects.toMatchObject({ kind: 'auth', message: expect.stringMatching(/no credit left.*Billing/) });
  });

  it('maps an invalid key to a clear error', async () => {
    const p = provider([() => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json' } })], []);
    await expect(p.chat(req)).rejects.toMatchObject({ kind: 'auth' });
  });
});
