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
  capabilities: { tools: boolean; streaming: boolean; local: boolean; toolset?: 'core' | 'full'; /** Can read images. */ vision?: boolean };
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
  kind: 'not_configured' | 'rate_limited' | 'unavailable' | 'bad_request' | 'auth' | 'aborted' | 'refused';
  retryable: boolean;
  constructor(kind: ProviderError['kind'], message: string, retryable = false) {
    super(message);
    this.kind = kind;
    this.retryable = retryable;
  }
}

export const textOf = (blocks: Block[]) =>
  blocks.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join('');
