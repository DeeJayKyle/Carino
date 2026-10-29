import type { AIProvider, ProviderInfo } from './types.ts';
import { ProviderError } from './types.ts';
import { AnthropicProvider, type Effort } from './anthropic.ts';
import { OpenAICompatProvider } from './openai-compat.ts';
import type { Config } from '../config.ts';

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
}

const COMPLEX = /\b(analy[sz]e|analysis|research|compare|plan|strategy|report|summari[sz]e|draft|write|essay|lesson plan|code|debug|calculate|forecast|budget|explain why|step[- ]by[- ]step)\b/i;

/** Holds every configured provider and resolves the one a user has selected. */
export class ProviderRegistry {
  private providers = new Map<string, AIProvider>();
  private defaultId: string | undefined;

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

export function createRegistry(config: Config): ProviderRegistry {
  const reg = new ProviderRegistry();
  reg.register('anthropic', new AnthropicProvider({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL }));
  reg.register(
    'openai_compat',
    new OpenAICompatProvider({
      baseUrl: config.OPENAI_COMPAT_BASE_URL,
      apiKey: config.OPENAI_COMPAT_API_KEY,
      model: config.OPENAI_COMPAT_MODEL,
      label: config.OPENAI_COMPAT_LABEL,
      tools: config.OPENAI_COMPAT_TOOLS === 'true',
      reasoningEffort: config.OPENAI_COMPAT_REASONING_EFFORT,
      toolset: config.OPENAI_COMPAT_TOOLSET,
      vision: config.OPENAI_COMPAT_VISION === 'true',
    }),
  );
  reg.setDefault(config.DEFAULT_PROVIDER);
  return reg;
}
