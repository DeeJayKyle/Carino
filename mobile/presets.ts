// AI services the phone app can talk to directly. Every service shown has a free tier; they
// are listed best first, and each one's models are in priority order. Model names change often,
// so the app also asks the service which models the key can use (/api/device/models), and if a
// model is retired, busy or rate-limited it moves on to the next one in the list.
// Checked against each service's own docs and model lists, October 2026.
export interface FreeModel {
  id: string;
  label: string;
  /** Model family, e.g. "DeepSeek" or "Qwen", so people can find the ones they know. */
  family?: string;
  /** Reads photos. */
  vision?: boolean;
}

export interface Preset {
  id: string;
  label: string;
  free: string;
  baseUrl: string;
  /** Free models, best first. The first is the default. */
  models: FreeModel[];
  model: string;
  vision: boolean;
  keyUrl: string;
  /** Can also turn voice notes into text with the same key. */
  transcribe?: { model: string };
  /** Kept working for existing setups, but not offered (not free). */
  hidden?: boolean;
  /** The address is the user's own (a PC on their network). */
  ownAddress?: boolean;
  /** Runs on the phone itself: no key, no internet once downloaded. */
  onDevice?: boolean;
  /** Which API the service speaks (default: Chat Completions). */
  api?: 'chat' | 'responses';
  /** Paid services: every call costs money; used only with the user's approval. */
  paid?: boolean;
}

const preset = (p: Omit<Preset, 'model' | 'vision'> & { vision?: boolean }): Preset => ({
  ...p, model: p.models[0]?.id ?? '', vision: p.vision ?? !!p.models[0]?.vision,
});

/** Open models that run on the phone itself (mobile/ondevice.ts), downloaded once. */
export interface LocalModel {
  id: string;
  label: string;
  note: string;
  url: string;
  /** Download size in bytes. */
  size: number;
}

export const LOCAL_MODELS: LocalModel[] = [
  {
    id: 'qwen3-1.7b', label: 'Qwen 3 1.7B — better answers', note: 'Needs a phone with 6 GB of memory or more.',
    url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf', size: 1_107_409_472,
  },
  {
    id: 'qwen3-0.6b', label: 'Qwen 3 0.6B — small and quick', note: 'Works on most phones. Simpler answers.',
    url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf', size: 396_705_472,
  },
];

/** The address the server uses for the on-phone model; answered in the app (mobile/ondevice.ts → onDeviceFetch), never sent anywhere. */
export const ON_DEVICE_BASE_URL = 'http://localhost/on-device/v1';

export const PRESETS: Preset[] = [
  preset({
    id: 'gemini', label: 'Google Gemini', free: 'Free with a Google account. Best all-rounder; reads photos.',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash — best', vision: true },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', vision: true },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite — fastest', vision: true },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', vision: true },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)', vision: true },
      { id: 'gemini-flash-latest', label: 'Latest Flash (Google picks)', vision: true },
    ],
  }),
  preset({
    id: 'groq', label: 'Groq', free: 'Free, very fast. Also turns voice notes into text.',
    baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', transcribe: { model: 'whisper-large-v3-turbo' },
    models: [
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B — best' },
      { id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B', family: 'Qwen' },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B — fastest' },
    ],
  }),
  preset({
    id: 'openrouter', label: 'OpenRouter', free: 'Free models from many labs (20 a minute, 50 a day).',
    baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys',
    models: [
      { id: 'openrouter/free', label: 'Auto — any working free model', vision: true },
      { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B', vision: true },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra' },
      { id: 'nvidia/nemotron-3.5-super-vl:free', label: 'Nemotron 3.5 Super VL', vision: true },
      { id: 'thinkingmachines/inkling:free', label: 'Inkling', vision: true },
      { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B — fast', vision: true },
    ],
  }),
  preset({
    id: 'mistral', label: 'Mistral', free: 'Free “Experiment” plan (your chats may be used for training).',
    baseUrl: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys',
    models: [
      { id: 'mistral-medium-latest', label: 'Mistral Medium', vision: true },
      { id: 'mistral-large-latest', label: 'Mistral Large', vision: true },
      { id: 'mistral-small-latest', label: 'Mistral Small — fast', vision: true },
      { id: 'ministral-8b-latest', label: 'Ministral 8B — fastest' },
    ],
  }),
  preset({
    id: 'nvidia', label: 'NVIDIA', free: 'Free developer access to DeepSeek, Kimi, GLM and more (40 a minute).',
    baseUrl: 'https://integrate.api.nvidia.com/v1', keyUrl: 'https://build.nvidia.com/settings/api-keys',
    models: [
      { id: 'deepseek-ai/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', family: 'DeepSeek' },
      { id: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6', family: 'Kimi' },
      { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', family: 'GLM' },
      { id: 'nvidia/nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super' },
      { id: 'google/gemma-4-31b-it', label: 'Gemma 4 31B', vision: true },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B — fast' },
    ],
  }),
  preset({
    id: 'zai', label: 'Z.ai (GLM)', free: 'GLM Flash models are free (non-commercial use).',
    baseUrl: 'https://api.z.ai/api/paas/v4', keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    models: [
      { id: 'glm-4.7-flash', label: 'GLM 4.7 Flash — best', family: 'GLM' },
      { id: 'glm-4.5-flash', label: 'GLM 4.5 Flash', family: 'GLM' },
      { id: 'glm-4.6v-flash', label: 'GLM 4.6V Flash — reads photos', family: 'GLM', vision: true },
    ],
  }),
  preset({
    id: 'ollama-cloud', label: 'Ollama Cloud', free: 'Free plan with light use of big open models.',
    baseUrl: 'https://ollama.com/v1', keyUrl: 'https://ollama.com/settings/keys',
    models: [
      { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', family: 'DeepSeek' },
      { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash', family: 'GLM' },
      { id: 'gpt-oss:120b', label: 'GPT-OSS 120B' },
      { id: 'kimi-k2.6', label: 'Kimi K2.6', family: 'Kimi' },
      { id: 'gemma4:31b', label: 'Gemma 4 31B', vision: true },
      { id: 'gpt-oss:20b', label: 'GPT-OSS 20B — fast' },
    ],
  }),
  preset({
    id: 'phone', label: 'On this phone (offline)', free: 'Free and fully private: a small AI runs on your phone, no internet or account needed. Download it once (0.4–1.1 GB). Simpler and slower than online AI; can\u2019t read photos.',
    baseUrl: ON_DEVICE_BASE_URL, keyUrl: '', onDevice: true,
    models: LOCAL_MODELS.map((m) => ({ id: m.id, label: m.label, family: 'Qwen' })),
  }),
  preset({
    id: 'custom', label: 'Ollama on your PC', free: 'Free and private: runs on your own computer. Also LM Studio or any compatible server.',
    baseUrl: 'http://192.168.1.10:11434/v1', keyUrl: '', ownAddress: true,
    models: [
      { id: 'qwen3:8b', label: 'Qwen 3 8B', family: 'Qwen' },
      { id: 'gemma4:e4b', label: 'Gemma 4 E4B', vision: true },
      { id: 'llama3.2', label: 'Llama 3.2 3B — small PCs' },
    ],
  }),
  {
    id: 'openai', label: 'OpenAI', free: 'Paid: uses your OpenAI credit. Carino asks before using it, and you can set a spending limit.',
    baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', api: 'responses', paid: true,
    // Checked Aug 2025; the app also reads the current list from OpenAI and tests each model.
    models: [{ id: 'gpt-5-mini', label: 'GPT-5 mini — quick', vision: true }, { id: 'gpt-5', label: 'GPT-5 — strongest', vision: true }],
    model: 'gpt-5-mini', vision: true,
  },
  {
    id: 'anthropic', label: 'Claude (Anthropic)', free: 'Paid.', hidden: true, paid: true,
    baseUrl: '', models: [], model: 'claude-sonnet-5-5', vision: true, keyUrl: 'https://console.anthropic.com/settings/keys',
  },
];

/** Picks the vision setting for a model, from its entry in the list. */
export function modelVision(p: Preset, model: string) {
  return p.models.find((m) => m.id === model)?.vision ?? p.vision;
}

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
  /** More AI services, used alongside the main one when Carino picks a model per message. */
  connections?: ExtraConnection[];
}

/** An extra AI service: a preset (with its key) or a local server found on this device. */
export interface ExtraConnection {
  id: string;
  preset: string;
  label?: string;
  baseUrl?: string;
  apiKey?: string;
}

/** True for addresses on this device or the home network (content stays with the user). */
export function ownNetwork(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '[::1]' || h.endsWith('.local') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  } catch {
    return false;
  }
}

/** Server settings (the same names as the server's .env) for a device configuration. */
export function configToEnv(c: DeviceConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const p = PRESETS.find((x) => x.id === c.provider);
  if (p?.id === 'anthropic') {
    if (c.apiKey) env.ANTHROPIC_API_KEY = c.apiKey;
    if (c.model) env.ANTHROPIC_MODEL = c.model;
    env.DEFAULT_PROVIDER = 'anthropic';
  } else if (p?.onDevice) {
    env.OPENAI_COMPAT_BASE_URL = ON_DEVICE_BASE_URL;
    env.OPENAI_COMPAT_MODEL = c.model || p.model;
    env.OPENAI_COMPAT_LABEL = 'Carino on this phone';
    env.OPENAI_COMPAT_TOOLSET = 'phone';
    env.OPENAI_COMPAT_VISION = 'false';
    env.OPENAI_COMPAT_LOCAL = 'true';
    env.OPENAI_COMPAT_BILLING = 'free';
    env.DEFAULT_PROVIDER = 'openai_compat';
  } else if (p) {
    const model = c.model || p.model;
    env.OPENAI_COMPAT_BASE_URL = (p.ownAddress ? c.baseUrl : p.baseUrl) || p.baseUrl;
    env.OPENAI_COMPAT_MODEL = model;
    if (c.apiKey) env.OPENAI_COMPAT_API_KEY = c.apiKey;
    env.OPENAI_COMPAT_LABEL = p.label;
    env.OPENAI_COMPAT_TOOLSET = p.ownAddress ? 'core' : 'full';
    const own = !!p.ownAddress && ownNetwork(env.OPENAI_COMPAT_BASE_URL);
    env.OPENAI_COMPAT_LOCAL = String(own);
    env.OPENAI_COMPAT_BILLING = own ? 'free' : p.paid ? 'paid' : p.ownAddress ? 'unknown' : 'free';
    if (p.api === 'responses') env.OPENAI_COMPAT_API = 'responses';
    env.OPENAI_COMPAT_VISION = String(c.vision ?? modelVision(p, model));
    // If the chosen model is retired, busy or rate-limited, try the service's other free models.
    if (!p.ownAddress && !p.paid) {
      const rest = p.models.map((m) => m.id).filter((id) => id !== model);
      if (rest.length) env.OPENAI_COMPAT_FALLBACK_MODELS = rest.join(',');
    }
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

/** The connection descriptions for extra services (keys included; they stay in memory). */
export function connectionSpecs(c: DeviceConfig) {
  return (c.connections ?? []).flatMap((x) => {
    const p = PRESETS.find((y) => y.id === x.preset);
    if (!p) return [];
    const baseUrl = (p.ownAddress || x.baseUrl ? x.baseUrl : p.baseUrl) || p.baseUrl;
    const local = !!p.onDevice || (!!p.ownAddress && ownNetwork(baseUrl));
    return [{
      id: x.id, label: x.label || p.label, api: (p.api ?? 'chat') as 'chat' | 'responses', baseUrl: p.onDevice ? ON_DEVICE_BASE_URL : baseUrl,
      apiKey: x.apiKey, local, billing: (local ? 'free' : p.paid ? 'paid' : p.ownAddress ? 'unknown' : 'free') as 'free' | 'paid' | 'unknown',
      models: p.ownAddress ? [] : p.models.map((m) => ({ id: m.id, label: m.label, vision: m.vision })),
      toolset: (p.onDevice ? 'phone' : local ? 'core' : 'full') as 'core' | 'full' | 'phone', preset: p.id,
    }];
  });
}
