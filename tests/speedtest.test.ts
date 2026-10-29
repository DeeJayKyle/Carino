import { describe, expect, it } from 'vitest';
import { rank, speedTest, timeModel } from '../mobile/speedtest.ts';

/** A fake AI service: each model answers after its own delay, or with an error status. */
function fakeService(models: Record<string, { delay?: number; status?: number; empty?: boolean; reasoning?: boolean }>) {
  const calls: string[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const { model } = JSON.parse(String(init.body));
    calls.push(model);
    const m = models[model] ?? { status: 404 };
    if (m.status) return new Response(JSON.stringify({ error: { message: `model ${model} not found` } }), { status: m.status });
    await new Promise((r) => setTimeout(r, m.delay ?? 0));
    const chunks = m.empty ? [] : [m.reasoning ? { reasoning: 'thinking' } : { content: 'Ready' }, { content: ' to help.' }];
    const body = chunks.map((d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe('AI speed test', () => {
  it('times every model and lists the fastest first, failures last', async () => {
    const { fetchFn } = fakeService({ slow: { delay: 60 }, fast: { delay: 5 }, gone: { status: 404 }, mid: { delay: 30 } });
    const r = await speedTest(fetchFn, 'https://ai.test/v1', 'k', ['slow', 'fast', 'gone', 'mid']);
    expect(r.map((x) => x.model)).toEqual(['fast', 'mid', 'slow', 'gone']);
    expect(r[0]).toMatchObject({ ok: true });
    expect(r[0].firstMs).toBeLessThanOrEqual(r[0].totalMs!);
    expect(r[3]).toMatchObject({ ok: false, error: 'not available to this key' });
  });

  it('stops after the first model when the key is rejected', async () => {
    const { fetchFn, calls } = fakeService({ a: { status: 401 }, b: { delay: 1 } });
    const r = await speedTest(fetchFn, 'https://ai.test/v1', 'bad', ['a', 'b']);
    expect(calls).toEqual(['a']);
    expect(r[0]).toMatchObject({ ok: false, error: 'key not accepted' });
  });

  it('explains rate limits, outages and empty replies in plain words', async () => {
    const { fetchFn } = fakeService({ limited: { status: 429 }, down: { status: 503 }, empty: { empty: true } });
    expect((await timeModel(fetchFn, 'https://ai.test/v1', 'k', 'limited')).error).toBe('over the free limit right now');
    expect((await timeModel(fetchFn, 'https://ai.test/v1', 'k', 'down')).error).toBe('busy or down');
    expect((await timeModel(fetchFn, 'https://ai.test/v1', 'k', 'empty')).error).toBe('sent an empty reply');
  });

  it('counts a reasoning model\'s thinking as the start of its answer', async () => {
    const { fetchFn } = fakeService({ thinker: { reasoning: true } });
    expect(await timeModel(fetchFn, 'https://ai.test/v1', 'k', 'thinker')).toMatchObject({ ok: true });
  });

  it('reports a service it cannot reach, and a model that never answers', async () => {
    const offline = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    expect((await timeModel(offline, 'https://ai.test/v1', 'k', 'm')).error).toBe('could not reach the service');
    const hang = ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)))) as unknown as typeof fetch;
    expect((await timeModel(hang, 'https://ai.test/v1', 'k', 'm', 30)).error).toBe('too slow (no reply in 25 s)');
  });

  it('keeps failed models in the order they were tried', () => {
    expect(rank([{ model: 'x', ok: false }, { model: 'y', ok: true, totalMs: 9 }, { model: 'z', ok: false }]).map((r) => r.model)).toEqual(['y', 'x', 'z']);
  });
});
