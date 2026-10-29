// AI services the phone app can talk to directly. All but Claude have a free tier.
export interface Preset {
  id: string;
  label: string;
  free: string;
  baseUrl: string;
  model: string;
  vision: boolean;
  keyUrl: string;
  /** Can also turn voice notes into text with the same key. */
  transcribe?: { model: string };
}

export const PRESETS: Preset[] = [
  {
    id: 'groq', label: 'Groq', free: 'Free tier, very fast. Also transcribes voice notes.',
    baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', vision: false,
    keyUrl: 'https://console.groq.com/keys', transcribe: { model: 'whisper-large-v3-turbo' },
  },
  {
    id: 'gemini', label: 'Google Gemini', free: 'Free tier with a Google account. Reads photos too.',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', vision: true,
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'openrouter', label: 'OpenRouter', free: 'Many free models (names end in “:free”).',
    baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', vision: false,
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'custom', label: 'Other (OpenAI-compatible)', free: 'Ollama on your PC, LM Studio, or any compatible service.',
    baseUrl: 'http://192.168.1.10:11434/v1', model: 'llama3.2', vision: false, keyUrl: '',
  },
  {
    id: 'anthropic', label: 'Claude (Anthropic)', free: 'Paid. Best quality.',
    baseUrl: '', model: 'claude-sonnet-5-5', vision: true, keyUrl: 'https://console.anthropic.com/settings/keys',
  },
];

export interface DeviceConfig {
  provider: string | null;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  vision?: boolean;
  /** Free speech-to-text for voice notes from Telegram (Groq key). */
  groqKey?: string;
  searxngUrl?: string;
  braveKey?: string;
  githubToken?: string;
}

/** Server settings (the same names as the server's .env) for a device configuration. */
export function configToEnv(c: DeviceConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const p = PRESETS.find((x) => x.id === c.provider);
  if (p?.id === 'anthropic') {
    if (c.apiKey) env.ANTHROPIC_API_KEY = c.apiKey;
    if (c.model) env.ANTHROPIC_MODEL = c.model;
    env.DEFAULT_PROVIDER = 'anthropic';
  } else if (p) {
    env.OPENAI_COMPAT_BASE_URL = (p.id === 'custom' ? c.baseUrl : p.baseUrl) || p.baseUrl;
    env.OPENAI_COMPAT_MODEL = c.model || p.model;
    if (c.apiKey) env.OPENAI_COMPAT_API_KEY = c.apiKey;
    env.OPENAI_COMPAT_LABEL = p.label;
    env.OPENAI_COMPAT_TOOLSET = p.id === 'custom' ? 'core' : 'full';
    env.OPENAI_COMPAT_VISION = String(c.vision ?? p.vision);
    env.DEFAULT_PROVIDER = 'openai_compat';
  }
  const groq = c.groqKey || (p?.id === 'groq' ? c.apiKey : undefined);
  if (groq) {
    env.TRANSCRIBE_BASE_URL = 'https://api.groq.com/openai/v1';
    env.TRANSCRIBE_API_KEY = groq;
  }
  if (c.searxngUrl) env.SEARXNG_URL = c.searxngUrl;
  if (c.braveKey) env.BRAVE_SEARCH_API_KEY = c.braveKey;
  if (c.githubToken) env.GITHUB_TOKEN = c.githubToken;
  return env;
}

/** What the app shows: keys are reduced to their last 4 characters. */
export function maskConfig(c: DeviceConfig) {
  const mask = (k?: string) => (k ? `••••${k.slice(-4)}` : '');
  return { ...c, apiKey: mask(c.apiKey), groqKey: mask(c.groqKey), braveKey: mask(c.braveKey), githubToken: mask(c.githubToken), hasKey: !!c.apiKey };
}
