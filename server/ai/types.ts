/**
 * Provider-neutral conversation format. It mirrors the Anthropic content-block
 * shape; other providers convert to and from it in their adapters.
 */
export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
/** Stored in history instead of the image bytes; expanded to an ImageBlock when sent. */
export type ImageRefBlock = { type: 'image_ref'; document_id: string; filename: string };
/** Opaque provider-specific blocks (e.g. Claude thinking blocks) replayed unchanged. */
export type OpaqueBlock = { type: string; [k: string]: unknown };

export type Block = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock | ImageRefBlock | OpaqueBlock;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called with each streamed text fragment. */
  onText?: (delta: string) => void;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | 'other';

export interface ChatResult {
  content: Block[];
  stopReason: StopReason;
  /** inputTokens counts every input token, including any read from or written to the prompt cache. */
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  model: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  model: string;
  configured: boolean;
  capabilities: { tools: boolean; streaming: boolean; local: boolean; toolset?: 'core' | 'full' | 'phone'; /** Can read images. */ vision?: boolean };
  /** USD per million tokens, when known. */
  pricing?: { input: number; output: number };
  note?: string;
}

export interface AIProvider {
  info(): ProviderInfo;
  chat(req: ChatRequest): Promise<ChatResult>;
}

/** Errors the UI can explain: missing config, provider outage, rate limit, etc. */
export class ProviderError extends Error {
  kind: 'not_configured' | 'rate_limited' | 'unavailable' | 'bad_request' | 'auth' | 'aborted' | 'refused' | 'too_large';
  retryable: boolean;
  /** too_large: the most the model accepts per request, in tokens, when the service said. */
  limit?: number;
  constructor(kind: ProviderError['kind'], message: string, retryable = false) {
    super(message);
    this.kind = kind;
    this.retryable = retryable;
  }
}

export const textOf = (blocks: Block[]) =>
  blocks.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join('');

/**
 * A service saying the request is bigger than the model (or the account's plan) accepts. Free
 * plans often cap tokens per request or per minute (Groq's free plan: about 6,000–12,000).
 */
export function tooLargeError(label: string, status: number, text: string): ProviderError | null {
  if (status !== 413 && !/request too large|reduce (the length|your message)|context.length|maximum context|too many tokens|prompt is too long/i.test(text)) return null;
  const limit = Number(text.match(/limit\D{0,3}(\d{3,7})/i)?.[1] ?? text.match(/maximum context length is (\d+)/i)?.[1] ?? 0) || undefined;
  const asked = Number(text.match(/requested\D{0,3}(\d{3,7})/i)?.[1] ?? 0) || undefined;
  const e = new ProviderError('too_large', `${label} can take about ${limit ? limit.toLocaleString('en') : 'so many'} tokens at a time on your plan${asked ? `, and this needed ${asked.toLocaleString('en')}` : ''}.`);
  e.limit = limit;
  return e;
}
