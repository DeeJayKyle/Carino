import { z } from 'zod';

/**
 * Server configuration, read from environment variables only.
 * Secrets (API keys, VAPID private key) live here and never reach the browser.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(8787),
  HOST: z.string().default('127.0.0.1'),
  PUBLIC_URL: z.string().default('http://localhost:8787'),
  DATA_DIR: z.string().default('./data'),
  ALLOW_SIGNUP: z.enum(['true', 'false']).default('true'),
  MAX_USERS: z.coerce.number().int().default(5),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),

  // AI providers — configure one or more. The user picks the active one in Settings.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
  OPENAI_COMPAT_BASE_URL: z.string().optional(),   // e.g. http://localhost:11434/v1 for Ollama
  OPENAI_COMPAT_API_KEY: z.string().optional(),
  OPENAI_COMPAT_MODEL: z.string().optional(),
  OPENAI_COMPAT_LABEL: z.string().default('Local / OpenAI-compatible'),
  OPENAI_COMPAT_TOOLS: z.enum(['true', 'false']).default('true'),
  /** Sent as reasoning_effort, e.g. 'none' to turn off slow thinking on local models. */
  OPENAI_COMPAT_REASONING_EFFORT: z.string().max(20).optional(),
  /** core = everyday tools only (shorter prompt, much faster on small local models); full = all tools. */
  OPENAI_COMPAT_TOOLSET: z.enum(['core', 'full']).default('core'),
  /** Set to true when the model can read images (e.g. llava, qwen2.5vl, gemma3, GPT-4o, Gemini). */
  OPENAI_COMPAT_VISION: z.enum(['true', 'false']).default('false'),
  DEFAULT_PROVIDER: z.enum(['anthropic', 'openai_compat']).optional(),

  // Web research
  SEARXNG_URL: z.string().optional(),
  BRAVE_SEARCH_API_KEY: z.string().optional(),

  // GitHub (read-only). Public repos work without a token; a fine-grained read-only token adds private repos.
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_API_URL: z.string().default('https://api.github.com'),

  // Speech-to-text for voice notes sent through Telegram/WhatsApp: any OpenAI-compatible
  // /audio/transcriptions endpoint. Free options: Groq (https://api.groq.com/openai/v1, free tier)
  // or a local Whisper server such as speaches / faster-whisper-server.
  TRANSCRIBE_BASE_URL: z.string().optional(),
  TRANSCRIBE_API_KEY: z.string().optional(),
  TRANSCRIBE_MODEL: z.string().default('whisper-large-v3-turbo'),

  // Place search uses OpenStreetMap's free Nominatim service (max 1 request/second, fair use).
  // Point this at your own Nominatim server for heavy use.
  NOMINATIM_URL: z.string().default('https://nominatim.openstreetmap.org'),

  // Connected apps (MCP). Connectors on the server's own network (localhost, 192.168.x.x…) are
  // refused unless this is true — only turn it on if you run MCP servers on that network yourself.
  MCP_ALLOW_PRIVATE_NETWORK: z.enum(['true', 'false']).default('false'),

  // Web push (generate with `npm run setup`)
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:admin@example.com'),


  MAX_UPLOAD_MB: z.coerce.number().default(100),
  DAILY_TOKEN_LIMIT: z.coerce.number().int().default(400000),
});

export type Config = z.infer<typeof schema> & {
  allowSignup: boolean;
  trustProxy: boolean;
  isProd: boolean;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.parse(cleaned);
  return {
    ...parsed,
    allowSignup: parsed.ALLOW_SIGNUP === 'true',
    trustProxy: parsed.TRUST_PROXY === 'true',
    isProd: parsed.NODE_ENV === 'production',
  };
}
