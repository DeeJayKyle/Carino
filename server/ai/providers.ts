import type { AIProvider, ProviderInfo } from './types.ts';
import { ProviderError } from './types.ts';
import { AnthropicProvider, ANTHROPIC_MODELS, type Effort } from './anthropic.ts';
import { OpenAICompatProvider } from './openai-compat.ts';
import { ResponsesProvider } from './responses.ts';
import type { Config } from '../config.ts';

/**
 * An AI service Carino can use: the main one chosen in settings, Claude, or an extra service
 * (another key, a local server on this PC, the on-phone model). Keys stay in memory here; they are
 * stored sealed on the device (mobile/vault.ts) and never returned to the UI.
 */
export interface ConnectionSpec {
  id: string;
  label: string;
  api: 'chat' | 'responses' | 'anthropic';
  baseUrl: string;
  apiKey?: string;
  /** Content sent here stays on the user's own devices. */
  local: boolean;
  /** free: the listed models cost nothing; paid: billed per use; unknown: treated as paid. */
  billing: 'free' | 'paid' | 'unknown';
  /** Models known from the preset or setup, best first. */
  models: { id: string; label?: string; vision?: boolean }[];
  toolset?: 'core' | 'full' | 'phone';
  tools?: boolean;
  /** The main connection (chosen in Settings): its chosen model counts as approved even if paid. */
  main?: boolean;
  preset?: string;
}

/** "connection::model" — how settings refer to a model. */
export const modelRef = (connId: string, model: string) => `${connId}::${model}`;
export function parseRef(ref: string): { connId: string; model: string } | null {
  const i = ref.indexOf('::');
  return i > 0 ? { connId: ref.slice(0, i), model: ref.slice(i + 2) } : null;
}

export interface AISettings {
  provider?: string;
  model?: string;
  effort?: Effort;
  localOnly?: boolean;
  autoRoute?: boolean;
}

/** What the router knows about a turn. */
export interface RouteSignals {
  text: string;
  attachments: number;
  historyChars: number;
  /** Label of a detected sensitive category in the message, if any. */
  sensitive?: string | null;
  /** Photos attached to this message. */
  images?: number;
}

const COMPLEX = /\b(analy[sz]e|analysis|research|compare|plan|strategy|report|summari[sz]e|draft|write|essay|lesson plan|code|debug|calculate|forecast|budget|explain why|step[- ]by[- ]step)\b/i;

/** Holds every configured provider and resolves the one a user has selected. */
export class ProviderRegistry {
  private providers = new Map<string, AIProvider>();
  private defaultId: string | undefined;
  private conns = new Map<string, ConnectionSpec>();
  /** The fetch used for AI calls (on the phone, it also answers the on-device model). */
  fetchImpl: typeof fetch = fetch;

  /** Extra services are only used through the model router, never by resolve()'s fallback order. */
  addConnection(spec: ConnectionSpec) {
    this.conns.set(spec.id, spec);
  }

  connections(): ConnectionSpec[] {
    return [...this.conns.values()];
  }

  connection(id: string) {
    return this.conns.get(id);
  }

  /** True when there is more than one service or model to choose between. */
  hasChoices() {
    return this.conns.size > 1 || [...this.conns.values()].some((c) => c.models.length > 1);
  }

  /** A provider for one model of one connection. */
  providerFor(connId: string, model: string, extra: { vision?: boolean; tools?: boolean; pricing?: { input: number; output: number }; api?: 'chat' | 'responses'; effort?: Effort } = {}): AIProvider {
    const c = this.conns.get(connId);
    if (!c) throw new ProviderError('not_configured', 'That AI service is no longer set up.');
    if (c.api === 'anthropic') {
      const a = this.providers.get('anthropic');
      if (!(a instanceof AnthropicProvider)) throw new ProviderError('not_configured', 'Claude is not set up.');
      return a.withSettings(model, extra.effort);
    }
    const api = extra.api ?? c.api;
    if (api === 'responses') {
      return new ResponsesProvider({ id: c.id, label: c.label, baseUrl: c.baseUrl, apiKey: c.apiKey, model, vision: extra.vision, local: c.local, pricing: extra.pricing }, this.fetchImpl);
    }
    return new OpenAICompatProvider({
      id: c.id, label: c.label, baseUrl: c.baseUrl, apiKey: c.apiKey, model, local: c.local, pricing: extra.pricing,
      tools: extra.tools ?? c.tools ?? true, toolset: c.toolset ?? (c.local ? 'core' : 'full'), vision: !!extra.vision,
    }, this.fetchImpl);
  }

  register(id: string, provider: AIProvider) {
    this.providers.set(id, provider);
  }

  setDefault(id: string | undefined) {
    this.defaultId = id;
  }

  get(id: string): AIProvider | undefined {
    return this.providers.get(id);
  }

  list(): ProviderInfo[] {
    return [...this.providers.values()].map((p) => p.info());
  }

  /**
   * Picks the user's chosen provider, falling back to the first configured one.
   * Never falls back from a local model to a cloud one: that would silently send
   * data the user chose to keep on their own machine to a third party.
   */
  resolve(settings: AISettings = {}): AIProvider {
    const chosen = settings.provider ? this.providers.get(settings.provider)?.info() : undefined;
    const localOnly = !!settings.localOnly || (!!chosen?.capabilities.local && !chosen.configured);
    const order = [settings.provider, this.defaultId, ...this.providers.keys()].filter(Boolean) as string[];
    for (const id of order) {
      const p = this.providers.get(id);
      if (p && p.info().configured && (!localOnly || p.info().capabilities.local)) {
        if (p instanceof AnthropicProvider) return p.withSettings(id === settings.provider ? settings.model : undefined, settings.effort);
        return p;
      }
    }
    if (localOnly && this.hasAny()) {
      throw new ProviderError(
        'unavailable',
        `No local model is available, and Carino will not send this to a cloud provider without your permission. Start your local model, or turn off local-only mode / choose ${this.list().filter((p) => p.configured).map((p) => p.label).join(' or ')} in Settings → AI.`,
      );
    }
    throw new ProviderError(
      'not_configured',
      'No AI provider is configured yet. Add ANTHROPIC_API_KEY or an OpenAI-compatible endpoint (such as Ollama) to the server’s .env file — see the README.',
    );
  }

  /**
   * Automatic routing (opt-in): when both a local and a cloud model are available, keep sensitive
   * and short everyday turns on the local model and send long or complex work to the cloud model.
   * Without autoRoute, or without both kinds of provider, this is exactly resolve().
   */
  route(settings: AISettings, signals: RouteSignals): { provider: AIProvider; reason: string } {
    const base = this.resolve(settings);
    if (!settings.autoRoute || settings.localOnly) return { provider: base, reason: settings.localOnly ? 'Local-only mode' : 'Your selected model' };
    const usable = [...this.providers.entries()].filter(([, p]) => p.info().configured && p.info().capabilities.tools);
    const local = usable.find(([, p]) => p.info().capabilities.local);
    const cloud = usable.find(([id]) => id === settings.provider && !this.providers.get(id)!.info().capabilities.local) ?? usable.find(([, p]) => !p.info().capabilities.local);
    if (!local || !cloud) return { provider: base, reason: 'Your selected model (auto-routing needs both a local and a cloud model)' };
    const pick = (id: string) => this.resolve({ ...settings, provider: id });
    if (signals.sensitive) return { provider: pick(local[0]), reason: `Kept on your local model: message looks sensitive (${signals.sensitive})` };
    if (signals.historyChars > 40_000) return { provider: pick(cloud[0]), reason: 'Long conversation — needs a larger context window' };
    if (signals.attachments > 0) return { provider: pick(cloud[0]), reason: 'Attached documents — sent to the more capable model' };
    if (signals.text.length > 600 || COMPLEX.test(signals.text)) return { provider: pick(cloud[0]), reason: 'Complex request — sent to the more capable model' };
    return { provider: pick(local[0]), reason: 'Everyday request — handled by your local model (free, private)' };
  }

  hasAny() {
    return this.list().some((p) => p.configured);
  }
}

/** fetchImpl lets the phone app answer the OpenAI-compatible provider itself (mobile/ondevice.ts). */
export function createRegistry(config: Config, fetchImpl: typeof fetch = fetch, extras: ConnectionSpec[] = []): ProviderRegistry {
  const reg = new ProviderRegistry();
  reg.fetchImpl = fetchImpl;
  reg.register('anthropic', new AnthropicProvider({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL }));
  const compatLocal = config.OPENAI_COMPAT_LOCAL === 'true';
  reg.register(
    'openai_compat',
    config.OPENAI_COMPAT_API === 'responses' && config.OPENAI_COMPAT_BASE_URL && config.OPENAI_COMPAT_MODEL
      ? new ResponsesProvider({
        id: 'openai_compat', label: config.OPENAI_COMPAT_LABEL, baseUrl: config.OPENAI_COMPAT_BASE_URL, apiKey: config.OPENAI_COMPAT_API_KEY,
        model: config.OPENAI_COMPAT_MODEL, vision: config.OPENAI_COMPAT_VISION === 'true', local: compatLocal,
      }, fetchImpl)
      : new OpenAICompatProvider({
      baseUrl: config.OPENAI_COMPAT_BASE_URL,
      apiKey: config.OPENAI_COMPAT_API_KEY,
      model: config.OPENAI_COMPAT_MODEL,
      label: config.OPENAI_COMPAT_LABEL,
      tools: config.OPENAI_COMPAT_TOOLS === 'true',
      reasoningEffort: config.OPENAI_COMPAT_REASONING_EFFORT,
      toolset: config.OPENAI_COMPAT_TOOLSET,
      vision: config.OPENAI_COMPAT_VISION === 'true',
      fallbackModels: config.OPENAI_COMPAT_FALLBACK_MODELS?.split(',').map((m) => m.trim()).filter(Boolean),
      local: compatLocal,
    }, fetchImpl),
  );
  reg.setDefault(config.DEFAULT_PROVIDER);
  if (config.ANTHROPIC_API_KEY) {
    reg.addConnection({
      id: 'anthropic', label: 'Claude (Anthropic)', api: 'anthropic', baseUrl: 'https://api.anthropic.com', local: false, billing: 'paid',
      models: [config.ANTHROPIC_MODEL, ...ANTHROPIC_MODELS.filter((m) => m !== config.ANTHROPIC_MODEL)].map((id) => ({ id, vision: true })), toolset: 'full', main: config.DEFAULT_PROVIDER === 'anthropic',
    });
  }
  if (config.OPENAI_COMPAT_BASE_URL && config.OPENAI_COMPAT_MODEL) {
    const fallback = config.OPENAI_COMPAT_FALLBACK_MODELS?.split(',').map((m) => m.trim()).filter(Boolean) ?? [];
    const local = compatLocal || ['localhost', '127.0.0.1', '[::1]'].includes(hostOf(config.OPENAI_COMPAT_BASE_URL));
    reg.addConnection({
      id: 'openai_compat', label: config.OPENAI_COMPAT_LABEL, api: config.OPENAI_COMPAT_API, baseUrl: config.OPENAI_COMPAT_BASE_URL,
      apiKey: config.OPENAI_COMPAT_API_KEY, local, billing: local ? 'free' : config.OPENAI_COMPAT_BILLING,
      models: [config.OPENAI_COMPAT_MODEL, ...fallback].map((id, i) => ({ id, vision: i === 0 ? config.OPENAI_COMPAT_VISION === 'true' : undefined })),
      toolset: config.OPENAI_COMPAT_TOOLSET, tools: config.OPENAI_COMPAT_TOOLS === 'true', main: config.DEFAULT_PROVIDER !== 'anthropic',
    });
  }
  for (const e of extras) if (!reg.connection(e.id)) reg.addConnection({ ...e, main: false });
  return reg;
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
