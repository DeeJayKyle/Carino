import type { Services } from '../context.ts';
import type { Settings } from '../services/settings.ts';
import type { AIProvider } from './types.ts';
import { ProviderError } from './types.ts';
import { listCatalog, spentUsd, syncCatalog, type CatalogModel } from './catalog.ts';
import { modelRef, parseRef, type RouteSignals } from './providers.ts';

/**
 * Picks the model for a message among the ones the user allowed. The hard rules are never
 * bent, whatever the scores say:
 *   1. Content marked local-only (a private chat, a local-only folder or memory, local-only mode)
 *      only ever goes to a model on the user's own devices.
 *   2. A model that costs money (or might) is used only if the user approved that service — their
 *      chosen main model counts — and only while their spending caps allow.
 *   3. Models the user turned off, or that are unavailable, are skipped.
 * Within those, it matches the job (photo → reads photos; long or complex → the strongest;
 * everyday → quick and cheap), the user's preference (privacy, balanced, speed), and test results.
 */

export type Role = 'everyday' | 'complex' | 'vision' | 'offline';

export interface Choice {
  provider: AIProvider;
  ref: string | null;
  reason: string;
  /** Next-best choices that obey the same rules, for when this one fails before answering. */
  fallbacks: { provider: () => AIProvider; ref: string; label: string }[];
  role: Role;
}

export interface Signals extends RouteSignals {
  /** The chat or something it uses must stay on the user's devices. */
  localOnly?: boolean;
  /** The device has no internet right now. */
  offline?: boolean;
}

const COMPLEX = /\b(analy[sz]e|analysis|research|compare|plan|strategy|report|summari[sz]e|draft|write|essay|code|debug|calculate|forecast|budget|explain why|step[- ]by[- ]step|spreadsheet|proposal|cover letter|application)\b/i;

export function roleFor(s: Signals): Role {
  if (s.offline) return 'offline';
  if (s.images) return 'vision';
  if (s.historyChars > 40_000 || s.attachments > 0 || s.text.length > 600 || COMPLEX.test(s.text)) return 'complex';
  return 'everyday';
}

export interface Budget { allowed: boolean; reason?: string; today: number; month: number }

export function budgetState(services: Services, userId: string, settings: Settings): Budget {
  const now = services.now();
  const today = spentUsd(services.db, userId, 24, now);
  const month = spentUsd(services.db, userId, 30 * 24, now);
  const { dailyUsd, monthlyUsd } = settings.ai.spend ?? {};
  if (typeof dailyUsd === 'number' && today >= dailyUsd) return { allowed: false, reason: `today’s AI spending limit ($${dailyUsd.toFixed(2)}) is reached`, today, month };
  if (typeof monthlyUsd === 'number' && month >= monthlyUsd) return { allowed: false, reason: `this month’s AI spending limit ($${monthlyUsd.toFixed(2)}) is reached`, today, month };
  return { allowed: true, today, month };
}

/** The main model chosen in Settings (counts as approved even when it costs money). */
function mainRef(services: Services, settings: Settings): string | null {
  try {
    const p = services.providers.resolve(settings.ai).info();
    return modelRef(p.id, p.model);
  } catch {
    return null;
  }
}

/** Why a model can't be used right now ('' = it can). */
export function blockedReason(m: CatalogModel, settings: Settings, main: string | null, budget: Budget, s: Signals): string {
  if (m.status === 'unavailable') return 'unavailable';
  if (settings.ai.disabledModels.includes(m.ref)) return 'turned off';
  if ((settings.ai.localOnly || s.localOnly) && !m.local) return 'content must stay on your devices';
  if (s.offline && !m.local) return 'no internet';
  if (m.paid !== false) {
    const approved = m.ref === main || settings.ai.approvedPaid.includes(m.conn_id);
    if (!approved) return m.paid === null ? 'may cost money — not approved' : 'costs money — not approved';
    if (!budget.allowed) return budget.reason!;
  }
  return '';
}

function score(m: CatalogModel, role: Role, prefer: Settings['ai']['prefer']): number {
  const q = m.quality ?? (m.local ? 0.45 : 0.6); // untested: a guess
  const speed = m.latency_ms ? Math.max(0, 1 - m.latency_ms / 15_000) : 0.4;
  const free = m.paid === false ? 1 : 0;
  const local = m.local ? 1 : 0;
  const w = {
    everyday: { q: 0.4, speed: 0.35, free: 0.15, local: 0.1 },
    complex: { q: 0.75, speed: 0.1, free: 0.1, local: 0.05 },
    vision: { q: 0.7, speed: 0.2, free: 0.1, local: 0 },
    offline: { q: 0.5, speed: 0.5, free: 0, local: 0 },
  }[role];
  const pref = prefer === 'privacy' ? { local: 0.35 } : prefer === 'speed' ? { speed: 0.3 } : {};
  return q * w.q + speed * (w.speed + (pref.speed ?? 0)) + free * w.free + local * (w.local + (pref.local ?? 0)) + (m.status === 'limited' ? -0.3 : 0);
}

export function chooseModel(services: Services, userId: string, settings: Settings, s: Signals): Choice {
  const reg = services.providers;
  syncCatalog(services);
  const role = roleFor(s);
  const main = mainRef(services, settings);
  const budget = budgetState(services, userId, settings);
  const all = listCatalog(services);
  const needsVision = role === 'vision';
  const usable = all.filter((m) => !blockedReason(m, settings, main, budget, s))
    // Carino works through tools; a model shown not to call them is used only if nothing else is left.
    .filter((m, _i, arr) => m.caps.tools !== false || arr.every((x) => x.caps.tools === false))
    .filter((m) => !needsVision || m.caps.vision !== false);
  const build = (m: CatalogModel) => () => reg.providerFor(m.conn_id, m.model, {
    vision: m.caps.vision ?? (needsVision ? true : undefined), tools: m.caps.tools !== false,
    pricing: m.price_in !== null && m.price_out !== null ? { input: m.price_in, output: m.price_out } : undefined,
    api: m.caps.api, effort: settings.ai.effort,
  });

  if (!usable.length) {
    const why = (settings.ai.localOnly || s.localOnly)
      ? 'This needs to stay on your devices, and no local model is available right now. Start your local model (or download the on-phone one), then try again.'
      : s.offline ? 'You’re offline and there’s no model on this device. Download the on-phone model in Settings → AI to keep going offline.'
      : !budget.allowed ? `Your ${budget.reason}. Free and local models carry on — add one in Connections, or raise the limit in Settings → AI.`
      : 'None of your AI models can take this right now. Check Connections, or approve another model.';
    throw new ProviderError('unavailable', why);
  }

  // A model chosen for this job, if it can be used; otherwise the main one when it fits; otherwise the best by score.
  const pinned = settings.ai.roles[role] ? usable.find((m) => m.ref === settings.ai.roles[role]) : undefined;
  const mainFits = !settings.ai.autoSelect && main ? usable.find((m) => m.ref === main) : undefined;
  const ranked = [...usable].sort((a, b) => score(b, role, settings.ai.prefer) - score(a, role, settings.ai.prefer));
  const pick = pinned ?? mainFits ?? (settings.ai.autoSelect ? ranked[0] : usable.find((m) => m.ref === main) ?? ranked[0]);
  const rest = ranked.filter((m) => m !== pick).slice(0, 3);
  const label = (m: CatalogModel) => `${m.label ?? m.model} (${m.connection})`;
  const reason = pinned ? `Your choice for ${ROLE_TEXT[role]}`
    : (s.localOnly || settings.ai.localOnly) ? 'Kept on your devices'
    : mainFits ? 'Your selected model'
    : pick.ref === main && role === 'everyday' ? 'Your selected model'
    : `Best available for ${ROLE_TEXT[role]}${pick.paid === false ? ' (free)' : ''}${pick.local ? ', on your device' : ''}`;
  return {
    provider: build(pick)(), ref: pick.ref, reason, role,
    fallbacks: rest.map((m) => ({ provider: build(m), ref: m.ref, label: label(m) })),
  };
}

/**
 * The provider for a turn. With only the main service set up, this is the familiar behaviour
 * (the chosen model, with its own fallbacks) plus the hard rules; with more, chooseModel decides.
 */
export function selectProvider(services: Services, userId: string, settings: Settings, s: Signals): Choice {
  const reg = services.providers;
  const extras = reg.connections().filter((c) => !c.main);
  if (extras.length) return chooseModel(services, userId, settings, s);
  const localOnly = settings.ai.localOnly || !!s.localOnly;
  const { provider, reason } = reg.route({ ...settings.ai, localOnly }, s);
  const info = provider.info();
  if (localOnly && !info.capabilities.local) {
    throw new ProviderError('unavailable', 'This chat is kept on your devices, and no local model is available. Start your local model (or download the on-phone one), then try again.');
  }
  const spec = reg.connection(info.id);
  const mayCost = !info.capabilities.local && (spec ? spec.billing !== 'free' : !!info.pricing);
  if (mayCost) {
    const budget = budgetState(services, userId, settings);
    if (!budget.allowed) throw new ProviderError('rate_limited', `Your ${budget.reason}. Raise it in Settings → AI, or add a free or local model in Connections.`);
  }
  return { provider, ref: modelRef(info.id, info.model), reason: localOnly && settings.ai.localOnly === false ? 'Kept on your devices' : reason, fallbacks: [], role: roleFor(s) };
}

export const ROLE_TEXT: Record<Role, string> = { everyday: 'everyday chat', complex: 'complex tasks', vision: 'photos', offline: 'offline use' };

/**
 * The model recommended for each job, from the allowed models and their test results.
 * Paid ones that aren't approved are left out (they can't be used without approval).
 */
export function recommend(services: Services, userId: string, settings: Settings) {
  syncCatalog(services);
  const main = mainRef(services, settings);
  const budget = budgetState(services, userId, settings);
  const all = listCatalog(services);
  const out: Record<Role, { ref: string; label: string; why: string } | null> = { everyday: null, complex: null, vision: null, offline: null };
  for (const role of ['everyday', 'complex', 'vision', 'offline'] as Role[]) {
    const s: Signals = { text: '', attachments: 0, historyChars: 0, images: role === 'vision' ? 1 : 0, offline: role === 'offline' };
    const ok = all.filter((m) => !blockedReason(m, { ...settings, ai: { ...settings.ai, localOnly: false } }, main, budget, s))
      .filter((m) => (role !== 'vision' || m.caps.vision === true) && (role !== 'offline' || m.local) && m.caps.tools !== false);
    const best = ok.sort((a, b) => score(b, role, settings.ai.prefer) - score(a, role, settings.ai.prefer))[0];
    if (best) {
      const bits = [best.quality !== null ? `scored ${Math.round(best.quality * 100)}%` : 'not tested yet', best.latency_ms ? `${(best.latency_ms / 1000).toFixed(1)}s first reply` : '', best.paid === false ? 'free' : 'paid', best.local ? 'stays on your device' : ''];
      out[role] = { ref: best.ref, label: `${best.label ?? best.model} · ${best.connection}`, why: bits.filter(Boolean).join(', ') };
    }
  }
  return out;
}

export { parseRef };
