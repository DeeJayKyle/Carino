// Times each free model with the user's own key, from the phone, so the app can pick the one that
// answers fastest where the user is. One short streamed request per model, one after another (so
// free rate limits aren't hit all at once).

export interface SpeedResult {
  model: string;
  ok: boolean;
  /** From sending until the first words arrive (what feels like "thinking time"). */
  firstMs?: number;
  /** Until the reply has finished. */
  totalMs?: number;
  error?: string;
}

const PROMPT = 'Reply with exactly: Ready to help.';

function reason(status: number, text: string): string {
  // The status code decides first; the message text only helps with vague 400s.
  if (status === 401 || status === 403) return 'key not accepted';
  if (status === 429) return 'over the free limit right now';
  if (status >= 500) return 'busy or down';
  if (status === 404 || /not.?found|does not exist|unknown model/i.test(text)) return 'not available to this key';
  return `error ${status}`;
}

/** Times one model: a tiny streamed chat request, measuring the first chunk with text and the end. */
export async function timeModel(
  fetchFn: typeof fetch, base: string, key: string | undefined, model: string, timeoutMs = 25_000, now = () => performance.now(),
): Promise<SpeedResult> {
  const t0 = now();
  try {
    const res = await fetchFn(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, stream: true, max_tokens: 64, messages: [{ role: 'user', content: PROMPT }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !res.body) return { model, ok: false, error: reason(res.status, await res.text().catch(() => '')) };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let firstMs: number | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:') || firstMs !== undefined) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const d = JSON.parse(data)?.choices?.[0]?.delta ?? {};
          // Reasoning models think first; their thinking counts as "started answering" too.
          if (d.content || d.reasoning || d.reasoning_content) firstMs = Math.round(now() - t0);
        } catch { /* keep-alive or partial line */ }
      }
    }
    const totalMs = Math.round(now() - t0);
    if (firstMs === undefined) return { model, ok: false, totalMs, error: 'sent an empty reply' };
    return { model, ok: true, firstMs, totalMs };
  } catch (e: any) {
    return { model, ok: false, error: e?.name === 'TimeoutError' ? 'too slow (no reply in 25 s)' : 'could not reach the service' };
  }
}

/** Times every model in turn. Results are fastest first; models that failed go last. */
export async function speedTest(
  fetchFn: typeof fetch, base: string, key: string | undefined, models: string[], onEach?: (r: SpeedResult) => void,
): Promise<SpeedResult[]> {
  const out: SpeedResult[] = [];
  for (const m of models.slice(0, 8)) {
    const r = await timeModel(fetchFn, base, key, m);
    out.push(r);
    onEach?.(r);
    // A rejected key fails the same way for every model: stop early instead of trying them all.
    if (r.error === 'key not accepted') break;
  }
  return rank(out);
}

/** Fastest to finish first; failed ones at the end, in the order tried. */
export function rank(results: SpeedResult[]): SpeedResult[] {
  return [...results].sort((a, b) => (a.ok === b.ok ? (a.ok ? a.totalMs! - b.totalMs! : 0) : a.ok ? -1 : 1));
}
