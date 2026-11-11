/**
 * A fake AI service speaking the OpenAI-style APIs (Chat Completions and Responses, streamed),
 * for testing model listing, model tests, routing and fallback without a network.
 */
export interface FakeModel {
  id: string;
  /** down: 503; gone: 404; reject: 401; slow: answers after a delay. */
  mode?: 'ok' | 'down' | 'gone' | 'reject' | 'slow';
  vision?: boolean;
  tools?: boolean;
  /** Only answers on the Responses API (like some newer OpenAI models). */
  responsesOnly?: boolean;
  pricing?: { prompt: string; completion: string };
}

export interface FakeCall { url: string; api: 'chat' | 'responses' | 'models'; model?: string; body?: any }

const sse = (events: unknown[]) => {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`));
      c.close();
    },
  });
};

/** What a well-behaved model would answer to Carino's test prompts (and anything else). */
function answer(prompt: string, model: FakeModel, hasImage: boolean, hasTools: boolean): { text?: string; call?: { name: string; args: any } } {
  if (hasTools && /Use the tool/.test(prompt) && model.tools !== false) return { call: { name: 'get_time', args: { zone: 'Africa/Kampala' } } };
  if (/exactly the word: ready/.test(prompt)) return { text: 'ready' };
  if (/as JSON/.test(prompt)) return { text: '{"person": "Sarah", "amount": 45000}' };
  if (/pharmacy opens at 08:00/.test(prompt)) return { text: '17:30' };
  if (hasImage) return { text: model.vision ? 'Red' : 'I cannot see images.' };
  return { text: `answer from ${model.id}` };
}

export function fakeAI(base: string, models: FakeModel[], opts: { key?: string } = {}) {
  const calls: FakeCall[] = [];
  const find = (id?: string) => models.find((m) => m.id === id);
  const f: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(base)) throw new TypeError(`fetch failed: ${url}`);
    const auth = new Headers(init?.headers).get('authorization');
    if (opts.key && auth !== `Bearer ${opts.key}`) return new Response('{"error":"bad key"}', { status: 401 });
    const path = url.slice(base.length);
    if (path === '/models') {
      calls.push({ url, api: 'models' });
      return Response.json({ data: models.filter((m) => m.mode !== 'gone').map((m) => ({ id: m.id, ...(m.pricing ? { pricing: m.pricing } : {}), ...(m.vision ? { architecture: { input_modalities: ['text', 'image'] } } : {}) })) });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    const api = path === '/responses' ? 'responses' : 'chat';
    calls.push({ url, api, model: body.model, body });
    const m = find(body.model);
    if (!m || m.mode === 'gone') return new Response('{"error":{"message":"model not found"}}', { status: 404 });
    if (m.mode === 'down') return new Response('overloaded', { status: 503 });
    if (m.mode === 'reject') return new Response('{"error":"bad key"}', { status: 401 });
    if (api === 'chat' && m.responsesOnly) return new Response('{"error":{"message":"This model is only supported in v1/responses"}}', { status: 400 });
    if (m.mode === 'slow') await new Promise((r) => setTimeout(r, 30));
    // Probes (non-streamed): just say OK.
    if (!body.stream) return Response.json(api === 'chat' ? { choices: [{ message: { content: 'OK' } }] } : { output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] });
    let prompt = '';
    let hasImage = false;
    if (api === 'chat') {
      const last = body.messages.filter((x: any) => x.role === 'user').at(-1);
      const content = last?.content;
      prompt = typeof content === 'string' ? content : (content ?? []).map((p: any) => p.text ?? '').join(' ');
      hasImage = Array.isArray(content) && content.some((p: any) => p.type === 'image_url');
    } else {
      const last = body.input.filter((x: any) => x.role === 'user').at(-1);
      prompt = (last?.content ?? []).map((p: any) => p.text ?? '').join(' ');
      hasImage = (last?.content ?? []).some((p: any) => p.type === 'input_image');
    }
    const a = answer(prompt, m, hasImage, !!body.tools?.length);
    if (api === 'chat') {
      const events: unknown[] = [];
      if (a.text) events.push({ choices: [{ delta: { content: a.text } }] });
      if (a.call) events.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: a.call.name, arguments: JSON.stringify(a.call.args) } }] } }] });
      events.push({ choices: [{ delta: {}, finish_reason: a.call ? 'tool_calls' : 'stop' }] });
      events.push({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 } });
      events.push('[DONE]');
      return new Response(sse(events), { headers: { 'content-type': 'text/event-stream' } });
    }
    const events: unknown[] = [{ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }];
    if (a.text) events.push({ type: 'response.output_text.delta', delta: a.text });
    if (a.call) events.push({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'fc_1', name: a.call.name, arguments: JSON.stringify(a.call.args) } });
    events.push({ type: 'response.completed', response: { status: 'completed', model: m.id, usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 200 } } } });
    return new Response(sse(events), { headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch: f, calls };
}

/** Routes requests to several fake services by address. */
export function combine(...services: { fetch: typeof fetch }[]): typeof fetch {
  return async (input, init) => {
    let last: unknown;
    for (const s of services) {
      try {
        return await s.fetch(input, init);
      } catch (e) {
        last = e;
      }
    }
    throw last;
  };
}
