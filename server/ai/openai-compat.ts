import type { AIProvider, ChatRequest, ChatResult, ProviderInfo, Block, ChatMessage } from './types.ts';
import { ProviderError } from './types.ts';

/**
 * Adapter for any server exposing the OpenAI-style /chat/completions API:
 * Ollama and llama.cpp (local, free), LM Studio, Groq, OpenRouter, Google Gemini's
 * compatibility endpoint, etc. Streaming via SSE; tool calls when the model supports them.
 */
export class OpenAICompatProvider implements AIProvider {
  private opts: { baseUrl?: string; apiKey?: string; model?: string; label: string; tools: boolean; reasoningEffort?: string; toolset?: 'core' | 'full'; vision?: boolean };
  private fetchImpl: typeof fetch;

  constructor(opts: { baseUrl?: string; apiKey?: string; model?: string; label: string; tools: boolean; reasoningEffort?: string; toolset?: 'core' | 'full'; vision?: boolean }, fetchImpl: typeof fetch = fetch) {
    this.opts = opts;
    this.fetchImpl = fetchImpl;
  }

  info(): ProviderInfo {
    const configured = !!(this.opts.baseUrl && this.opts.model);
    let local = false;
    try {
      local = !!this.opts.baseUrl && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(this.opts.baseUrl).hostname);
    } catch {}
    return {
      id: 'openai_compat',
      label: this.opts.label,
      model: this.opts.model ?? '',
      configured,
      capabilities: { tools: this.opts.tools, streaming: true, local, toolset: this.opts.toolset ?? 'core', vision: !!this.opts.vision },
      note: configured ? undefined : 'Set OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_MODEL on the server (e.g. Ollama at http://localhost:11434/v1).',
    };
  }

  /** Overridable in tests so retries don't actually wait. */
  retryDelay(ms: number) {
    return ms;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const { baseUrl, apiKey, model } = this.opts;
    if (!baseUrl || !model) throw new ProviderError('not_configured', 'The OpenAI-compatible provider is not configured on the server.');
    const body: Record<string, unknown> = {
      model,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: req.maxTokens ?? 4096,
      messages: toOpenAI(req.system, req.messages),
    };
    if (this.opts.reasoningEffort) body.reasoning_effort = this.opts.reasoningEffort;
    if (this.opts.tools && req.tools.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    }
    let res!: Response;
    for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await this.fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') throw new ProviderError('aborted', 'Response cancelled.');
      throw new ProviderError('unavailable', `Could not reach ${this.opts.label}. Is it running and reachable from the server?`, true);
    }
    if (res.status !== 429 || attempt === 2) break;
    const after = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30_000) : [5_000, 15_000][attempt];
    await res.body?.cancel().catch(() => undefined);
    await new Promise((r) => setTimeout(r, this.retryDelay(waitMs)));
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      if (res.status === 401 || res.status === 403) throw new ProviderError('auth', `${this.opts.label} rejected the API key.`);
      if (res.status === 429) throw new ProviderError('rate_limited', `${this.opts.label} is rate-limiting requests. Try again shortly.`, true);
      if (res.status >= 500) throw new ProviderError('unavailable', `${this.opts.label} returned an error (${res.status}).`, true);
      throw new ProviderError('bad_request', `${this.opts.label} rejected the request (${res.status}): ${text}`);
    }

    let text = '';
    let finish = '';
    const think = new ThinkFilter();
    const usage = { inputTokens: 0, outputTokens: 0 };
    const calls = new Map<number, { id: string; name: string; args: string; extra?: unknown }>();
    try {
      for await (const data of sseData(res.body!)) {
        if (data === '[DONE]') break;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.usage) {
          usage.inputTokens = chunk.usage.prompt_tokens ?? usage.inputTokens;
          usage.outputTokens = chunk.usage.completion_tokens ?? usage.outputTokens;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) {
          const visible = think.push(delta.content);
          if (visible) {
            text += visible;
            req.onText?.(visible);
          }
        }
        for (const tc of delta.tool_calls ?? []) {
          // Some services omit `index` and send each call whole; tell calls apart by id instead.
          let i: number;
          if (typeof tc.index === 'number') i = tc.index;
          else if (tc.id) {
            const existing = [...calls.entries()].find(([, c]) => c.id === tc.id);
            i = existing ? existing[0] : calls.size;
          } else i = Math.max(calls.size - 1, 0);
          const cur: { id: string; name: string; args: string; extra?: unknown } = calls.get(i) ?? { id: tc.id ?? `call_${i}`, name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          // Provider-specific data (e.g. Gemini's thought_signature) must be sent back unchanged.
          if (tc.extra_content) cur.extra = tc.extra_content;
          calls.set(i, cur);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') throw new ProviderError('aborted', 'Response cancelled.');
      throw new ProviderError('unavailable', `The connection to ${this.opts.label} was interrupted.`, true);
    }

    const rest = think.flush();
    if (rest) {
      text += rest;
      req.onText?.(rest);
    }
    const content: Block[] = [];
    if (text.trim()) content.push({ type: 'text', text: text.replace(/^\s+/, '') });
    for (const call of calls.values()) {
      let input: unknown = {};
      try {
        input = call.args ? JSON.parse(call.args) : {};
      } catch {
        input = { __invalid_json: call.args };
      }
      content.push({ type: 'tool_use', id: call.id, name: call.name, input, ...(call.extra ? { extra_content: call.extra } : {}) } as Block);
    }
    const stopReason = calls.size ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn';
    return { content, stopReason, usage, model };
  }
}

/**
 * Hides a leading <think>…</think> block that some local models put in the visible reply,
 * so private reasoning never reaches the user. Works on streamed fragments.
 */
export class ThinkFilter {
  private buf = '';
  private state: 'start' | 'thinking' | 'pass' = 'start';

  push(chunk: string): string {
    if (this.state === 'pass') return chunk;
    this.buf += chunk;
    if (this.state === 'start') {
      const t = this.buf.trimStart();
      if (!t) return '';
      if (t.startsWith('<think>')) this.state = 'thinking';
      else if ('<think>'.startsWith(t)) return ''; // could still become "<think>"
      else {
        this.state = 'pass';
        const out = this.buf;
        this.buf = '';
        return out;
      }
    }
    const end = this.buf.indexOf('</think>');
    if (end < 0) return '';
    const out = this.buf.slice(end + '</think>'.length).replace(/^\s+/, '');
    this.buf = '';
    this.state = 'pass';
    return out;
  }

  /** At end of stream: an unfinished think block is dropped; undecided text is released. */
  flush(): string {
    const out = this.state === 'start' ? this.buf : '';
    this.buf = '';
    return out;
  }
}

function toOpenAI(system: string, messages: ChatMessage[]) {
  const out: any[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      const toolCalls = m.content
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }, ...(b.extra_content ? { extra_content: b.extra_content } : {}) }));
      out.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      const text = m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      const images = m.content.filter((b: any) => b.type === 'image');
      for (const b of m.content as any[]) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
      }
      if (images.length) {
        out.push({
          role: 'user',
          content: [
            ...(text ? [{ type: 'text', text }] : []),
            ...images.map((b: any) => ({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } })),
          ],
        });
      } else if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

async function* sseData(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  if (buf.trim().startsWith('data:')) yield buf.trim().slice(5).trim();
}
