import type Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, ChatRequest, ChatResult, ProviderInfo, Block, StopReason } from './types.ts';
import { ProviderError } from './types.ts';

/** First-party API prices in USD per million tokens (checked Oct 2026; verify on anthropic.com/pricing). */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-fable-5-1': { input: 10, output: 50 },
};

export const ANTHROPIC_MODELS = Object.keys(PRICING);

export type Effort = 'low' | 'medium' | 'high';

type Sdk = typeof Anthropic;
let sdk: Promise<Sdk> | null = null;
/**
 * The Claude SDK is large, and the phone app doesn't offer Claude (only an existing setup keeps
 * working), so it's loaded the first time Claude is actually used.
 */
const loadSdk = () => (sdk ??= import('@anthropic-ai/sdk').then((m) => m.default));

export class AnthropicProvider implements AIProvider {
  private apiKey?: string;
  /** Shared with copies made by withSettings, so there's only ever one client. */
  private shared: { client?: Promise<Anthropic> };
  private clientOpts: { maxRetries: number; fetch?: typeof fetch };
  private model: string;
  private effort: Effort;

  constructor(opts: { apiKey?: string; model: string; effort?: Effort; maxRetries?: number; fetch?: typeof fetch }) {
    this.apiKey = opts.apiKey;
    this.shared = {};
    this.clientOpts = { maxRetries: opts.maxRetries ?? 2, fetch: opts.fetch };
    this.model = opts.model;
    this.effort = opts.effort ?? 'medium';
  }

  private client(): Promise<Anthropic> {
    // The phone app runs this code inside the app itself (mobile/engine.ts), with the user's own key.
    return (this.shared.client ??= loadSdk().then((A) => new A({
      apiKey: this.apiKey, maxRetries: this.clientOpts.maxRetries, dangerouslyAllowBrowser: typeof window !== 'undefined',
      ...(this.clientOpts.fetch ? { fetch: this.clientOpts.fetch } : {}),
    })));
  }

  withSettings(model?: string, effort?: Effort): AnthropicProvider {
    const p = Object.create(this) as AnthropicProvider;
    if (model) p.model = model;
    if (effort) p.effort = effort;
    return p;
  }

  info(): ProviderInfo {
    return {
      id: 'anthropic',
      label: 'Claude (Anthropic)',
      model: this.model,
      configured: !!this.apiKey,
      capabilities: { tools: true, streaming: true, local: false, vision: true },
      pricing: PRICING[this.model],
      note: this.apiKey ? undefined : 'Set ANTHROPIC_API_KEY on the server to enable Claude.',
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    if (!this.apiKey) throw new ProviderError('not_configured', 'Claude is not configured on the server (ANTHROPIC_API_KEY is missing).');
    const base = {
      model: this.model,
      max_tokens: req.maxTokens ?? 32000,
      system: req.system,
      messages: req.messages as Anthropic.MessageParam[],
      tools: req.tools.map((t) => ({ ...t, eager_input_streaming: true })) as Anthropic.Tool[],
      thinking: { type: 'adaptive' },
      output_config: { effort: this.effort },
      // The system prompt and tools are frozen per conversation, so the prefix caches well.
      cache_control: { type: 'ephemeral' },
    };
    // Server-side refusal fallback is opt-in via a beta. Optional extras are dropped one at a time
    // if the API rejects them (e.g. a model or account without the beta), so chat keeps working.
    let params: any = { ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.runWithHistoryRepair(params, req);
      } catch (err) {
        const msg = err instanceof ProviderError && err.kind === 'bad_request' ? err.message : '';
        if (attempt < 2 && params.fallbacks && /fallback|beta/i.test(msg)) {
          const { betas, fallbacks, ...rest } = params;
          void betas, void fallbacks;
          params = rest;
          continue;
        }
        if (attempt < 2 && params.cache_control && /cache_control/i.test(msg)) {
          const { cache_control, ...rest } = params;
          void cache_control;
          params = rest;
          continue;
        }
        throw err;
      }
    }
  }

  /** If a replayed thinking block is rejected (e.g. history changed), retry with thinking blocks removed. */
  private async runWithHistoryRepair(params: any, req: ChatRequest): Promise<ChatResult> {
    const A = await loadSdk();
    try {
      return await this.run(params, req);
    } catch (err) {
      if (err instanceof A.BadRequestError && /thinking/i.test(err.message)) {
        const stripped = req.messages.map((m) => ({
          ...m,
          content: m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking'),
        }));
        try {
          return await this.run({ ...params, messages: stripped }, req);
        } catch (e2) {
          throw mapError(A, e2);
        }
      }
      throw mapError(A, err);
    }
  }

  private async run(params: any, req: ChatRequest): Promise<ChatResult> {
    const stream = (await this.client()).beta.messages.stream(params, { signal: req.signal });
    stream.on('text', (delta: string) => req.onText?.(delta));
    const msg: any = await stream.finalMessage();
    const stop: StopReason = ['end_turn', 'tool_use', 'max_tokens', 'refusal', 'pause_turn'].includes(msg.stop_reason)
      ? msg.stop_reason
      : 'other';
    return {
      content: msg.content as Block[],
      stopReason: stop,
      usage: {
        inputTokens: (msg.usage?.input_tokens ?? 0) + (msg.usage?.cache_read_input_tokens ?? 0) + (msg.usage?.cache_creation_input_tokens ?? 0),
        outputTokens: msg.usage?.output_tokens ?? 0,
        cacheReadTokens: msg.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: msg.usage?.cache_creation_input_tokens ?? 0,
      },
      model: msg.model ?? this.model,
    };
  }
}

function mapError(Anthropic: Sdk, err: unknown): Error {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError('aborted', 'Response cancelled.');
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
    return new ProviderError('auth', 'The Claude API key was rejected. Check ANTHROPIC_API_KEY on the server.');
  if (err instanceof Anthropic.RateLimitError)
    return new ProviderError('rate_limited', 'Claude is rate-limiting requests right now. Try again in a minute.', true);
  if (err instanceof Anthropic.BadRequestError && /credit balance|billing/i.test(err.message)) {
    return new ProviderError('auth', 'Your Anthropic account has no credit left, so Claude can’t reply. Add credit in the Claude Console (Settings → Billing), then try again.');
  }
  if (err instanceof Anthropic.BadRequestError) return new ProviderError('bad_request', `Claude rejected the request: ${err.message}`);
  if (err instanceof Anthropic.InternalServerError) return new ProviderError('unavailable', 'Claude is temporarily unavailable. Please retry.', true);
  if (err instanceof Anthropic.APIConnectionError)
    return new ProviderError('unavailable', 'Could not reach the Claude API. Check the server’s internet connection.', true);
  if (err instanceof Anthropic.APIError) return new ProviderError('unavailable', `Claude API error: ${err.message}`, true);
  return err instanceof Error ? err : new Error(String(err));
}
