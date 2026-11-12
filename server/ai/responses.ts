import type { AIProvider, Block, ChatMessage, ChatRequest, ChatResult, ProviderInfo } from './types.ts';
import { ProviderError, tooLargeError } from './types.ts';
import { sseData } from './openai-compat.ts';

/**
 * Adapter for the OpenAI Responses API (POST /responses): OpenAI's own API for its newer and
 * reasoning models, also offered by some other services. Streams text, calls tools, reads
 * images. Nothing is stored at the provider (store: false); the conversation is sent each time,
 * as with the other adapters.
 */
export interface ResponsesOptions {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  vision?: boolean;
  local?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high';
  pricing?: { input: number; output: number };
}

export class ResponsesProvider implements AIProvider {
  private opts: ResponsesOptions;
  private fetchImpl: typeof fetch;

  constructor(opts: ResponsesOptions, fetchImpl: typeof fetch = fetch) {
    this.opts = opts;
    this.fetchImpl = fetchImpl;
  }

  info(): ProviderInfo {
    return {
      id: this.opts.id, label: this.opts.label, model: this.opts.model, configured: !!(this.opts.baseUrl && this.opts.model),
      capabilities: { tools: true, streaming: true, local: !!this.opts.local, toolset: 'full', vision: this.opts.vision ?? true },
      pricing: this.opts.pricing,
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      instructions: req.system,
      input: toResponsesInput(req.messages),
      stream: true,
      store: false,
      max_output_tokens: req.maxTokens ?? 4096,
    };
    if (this.opts.reasoningEffort) body.reasoning = { effort: this.opts.reasoningEffort };
    if (req.tools.length) body.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false }));
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') throw new ProviderError('aborted', 'Response cancelled.');
      throw new ProviderError('unavailable', `Could not reach ${this.opts.label}. Check your internet connection and try again.`, true);
    }
    if (!res.ok) {
      const t = (await res.text().catch(() => '')).slice(0, 300);
      const big = tooLargeError(this.opts.label, res.status, t);
      if (big) throw big;
      if (res.status === 401 || res.status === 403) throw new ProviderError('auth', `${this.opts.label} rejected the API key.`);
      if (res.status === 429) throw new ProviderError('rate_limited', `${this.opts.label} is rate-limiting requests, or the account is out of credit. Try again shortly.`, true);
      if (res.status === 404) throw new ProviderError('unavailable', `${this.opts.label} doesn’t offer ${this.opts.model} (or this API) any more.`);
      if (res.status >= 500) throw new ProviderError('unavailable', `${this.opts.label} is busy or down (${res.status}). Try again in a minute.`, true);
      throw new ProviderError('bad_request', `${this.opts.label} rejected the request (${res.status}): ${t}`);
    }

    let text = '';
    let status = '';
    let model = this.opts.model;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    const calls: { id: string; name: string; args: string }[] = [];
    let refused = false;
    try {
      for await (const data of sseData(res.body!)) {
        if (data === '[DONE]') break;
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        switch (ev.type) {
          case 'response.output_text.delta':
            if (typeof ev.delta === 'string' && ev.delta) {
              text += ev.delta;
              req.onText?.(ev.delta);
            }
            break;
          case 'response.refusal.delta':
            refused = true;
            if (typeof ev.delta === 'string') text += ev.delta;
            break;
          case 'response.output_item.done':
            if (ev.item?.type === 'function_call') calls.push({ id: String(ev.item.call_id ?? ev.item.id), name: String(ev.item.name), args: String(ev.item.arguments ?? '') });
            break;
          case 'response.completed':
          case 'response.incomplete':
          case 'response.failed': {
            const r = ev.response ?? {};
            status = r.status ?? ev.type.split('.')[1];
            if (r.model) model = r.model;
            if (r.usage) {
              usage.inputTokens = r.usage.input_tokens ?? 0;
              usage.outputTokens = r.usage.output_tokens ?? 0;
              usage.cacheReadTokens = r.usage.input_tokens_details?.cached_tokens ?? 0;
            }
            if (ev.type === 'response.failed') throw new ProviderError('unavailable', `${this.opts.label} couldn’t finish: ${r.error?.message ?? 'unknown error'}`, true);
            if (ev.type === 'response.incomplete' && r.incomplete_details?.reason) status = `incomplete:${r.incomplete_details.reason}`;
            break;
          }
          case 'error':
            throw new ProviderError('unavailable', `${this.opts.label}: ${ev.message ?? ev.error?.message ?? 'error'}`, true);
        }
      }
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      if (err?.name === 'AbortError') throw new ProviderError('aborted', 'Response cancelled.');
      throw new ProviderError('unavailable', `The connection to ${this.opts.label} was interrupted.`, true);
    }
    const content: Block[] = [];
    if (text.trim()) content.push({ type: 'text', text });
    for (const c of calls) {
      let input: unknown = {};
      try {
        input = c.args ? JSON.parse(c.args) : {};
      } catch {
        input = { __invalid_json: c.args };
      }
      content.push({ type: 'tool_use', id: c.id, name: c.name, input });
    }
    const stopReason = refused ? 'refusal' : calls.length ? 'tool_use' : status === 'incomplete:max_output_tokens' ? 'max_tokens' : 'end_turn';
    return { content, stopReason, usage, model };
  }
}

/** Carino's conversation format → Responses API input items. */
export function toResponsesInput(messages: ChatMessage[]) {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      if (text) out.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const b of m.content as any[]) {
        if (b.type === 'tool_use') out.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      }
    } else {
      for (const b of m.content as any[]) {
        if (b.type === 'tool_result') out.push({ type: 'function_call_output', call_id: b.tool_use_id, output: b.is_error ? `Error: ${b.content}` : b.content });
      }
      const parts: any[] = [];
      for (const b of m.content as any[]) {
        if (b.type === 'text' && b.text) parts.push({ type: 'input_text', text: b.text });
        if (b.type === 'image') parts.push({ type: 'input_image', image_url: `data:${b.source.media_type};base64,${b.source.data}` });
      }
      if (parts.length) out.push({ role: 'user', content: parts });
    }
  }
  return out;
}
