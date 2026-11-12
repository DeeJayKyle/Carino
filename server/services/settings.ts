import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { parseJson, nowIso } from '../db/index.ts';

export const DEFAULT_WIDGETS = ['briefing', 'today', 'upcoming', 'projects', 'quick', 'recent', 'review', 'suggestions'].map((id) => ({ id, visible: true }));

export const settingsSchema = z.object({
  profile: z.object({
    displayName: z.string().max(80).default(''),
    assistantStyle: z.enum(['balanced', 'concise', 'detailed', 'warm', 'playful', 'upbeat', 'mine']).default('balanced'),
    /** How the user writes (learned from their own messages, or samples they gave), for "like me". */
    voiceProfile: z.string().max(1500).default(''),
    customInstructions: z.string().max(2000).default(''),
    /** The assistant can be renamed; "Carino" stays the app's name. */
    assistantName: z.string().trim().max(40).default('Carino'),
    /** Language for replies; empty = match the user. */
    replyLanguage: z.string().max(40).default(''),
    /** Mascot accessory, earned through challenges (services/achievements.ts); auto wears the best one earned. */
    mascotAccessory: z.enum(['auto', 'none', 'party', 'crown', 'chef', 'cap', 'headband']).default('auto'),
    /** What the user said they want help with during onboarding (Discover ordering). */
    interests: z.array(z.string().max(40)).max(20).default([]),
  }).default({ displayName: '', assistantStyle: 'balanced', voiceProfile: '', customInstructions: '', assistantName: 'Carino', replyLanguage: '', mascotAccessory: 'auto', interests: [] }),
  ai: z.object({
    provider: z.string().max(40).optional(),
    model: z.string().max(80).optional(),
    effort: z.enum(['low', 'medium', 'high']).default('medium'),
    dailyTokenLimit: z.number().int().min(0).max(50_000_000).optional(),
    /** Rolling 30-day token cap; 0 or unset = no monthly limit. */
    monthlyTokenLimit: z.number().int().min(0).max(1_500_000_000).optional(),
    /** Never send conversations to a cloud provider; fail visibly if no local model is available. */
    localOnly: z.boolean().default(false),
    /** Choose between a local and a cloud model per message (see ProviderRegistry.route). */
    autoRoute: z.boolean().default(false),
    /** Pick the model for each message among the ones you've allowed (capability, privacy, speed, budget). */
    autoSelect: z.boolean().default(true),
    prefer: z.enum(['privacy', 'balanced', 'speed']).default('balanced'),
    /** A chosen model per job ("connection::model"); empty = pick automatically. */
    roles: z.object({
      everyday: z.string().max(240).optional(),
      complex: z.string().max(240).optional(),
      vision: z.string().max(240).optional(),
      offline: z.string().max(240).optional(),
    }).default({}),
    /** Models never to use ("connection::model"). */
    disabledModels: z.array(z.string().max(240)).max(500).default([]),
    /** Connections whose paid models may be used. Your chosen main model counts as approved. */
    approvedPaid: z.array(z.string().max(80)).max(50).default([]),
    /** Spending caps in USD; unset = no cap. Reaching one stops paid models (free and local ones carry on). */
    spend: z.object({
      dailyUsd: z.number().min(0).max(100_000).nullable().optional(),
      monthlyUsd: z.number().min(0).max(1_000_000).nullable().optional(),
    }).default({}),
  }).default({ effort: 'medium', localOnly: false, autoRoute: false, autoSelect: true, prefer: 'balanced', roles: {}, disabledModels: [], approvedPaid: [], spend: {} }),
  memory: z.object({
    enabled: z.boolean().default(true),
    /** explicit: only when the user asks; ask: every assistant-initiated memory needs approval; ask_sensitive: approval for sensitive or inferred only. */
    saveMode: z.enum(['ask_sensitive', 'ask', 'explicit']).default('ask_sensitive'),
    disabledCategories: z.array(z.string()).default([]),
    retentionDays: z.number().int().min(0).max(36500).default(0), // 0 = keep until deleted
  }).default({ enabled: true, saveMode: 'ask_sensitive', disabledCategories: [], retentionDays: 0 }),
  permissions: z.object({
    /** Allow reversible changes (create/update tasks, notes, reminders) without asking. */
    autoReversible: z.boolean().default(true),
    /** Per-tool override: auto | ask | off. Consequential tools can never be "auto". */
    tools: z.record(z.string(), z.enum(['auto', 'ask', 'off'])).default({}),
  }).default({ autoReversible: true, tools: {} }),
  regional: z.object({
    timeZone: z.string().max(64).default('UTC'),
    locale: z.string().max(20).default('en-GB'),
    hour12: z.boolean().default(false),
  }).default({ timeZone: 'UTC', locale: 'en-GB', hour12: false }),
  appearance: z.object({
    theme: z.enum(['system', 'light', 'dark']).default('system'),
    textSize: z.enum(['normal', 'large']).default('normal'),
    reduceMotion: z.boolean().default(false),
    /** classic = the original Carino colours; midnight = navy surfaces with emerald/cyan accents. */
    palette: z.enum(['classic', 'midnight']).default('classic'),
  }).default({ theme: 'system', textSize: 'normal', reduceMotion: false, palette: 'classic' }),
  voice: z.object({
    enabled: z.boolean().default(true),
    language: z.string().max(20).default('en-US'),
    speakReplies: z.boolean().default(false),
    voiceName: z.string().max(120).default(''),
    /** Read the day's brief aloud the first time Carino is opened each day (off unless chosen). */
    speakBrief: z.boolean().default(false),
  }).default({ enabled: true, language: 'en-US', speakReplies: false, voiceName: '', speakBrief: false }),
  money: z.object({
    /** ISO 4217 code; empty = from the region setting (services/money.ts → currencyFor). */
    currency: z.string().regex(/^([A-Z]{3})?$/).default(''),
  }).default({ currency: '' }),
  notifications: z.object({
    push: z.boolean().default(true),
    quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  }).default({ push: true }),
  dashboard: z.object({
    widgets: z.array(z.object({ id: z.string().max(40), visible: z.boolean() })).max(20).default(() => DEFAULT_WIDGETS.map((w) => ({ ...w }))),
  }).default(() => ({ widgets: DEFAULT_WIDGETS.map((w) => ({ ...w })) })),
  onboarded: z.boolean().default(false),
});

export type Settings = z.infer<typeof settingsSchema>;

export function getSettings(db: Db, userId: string): Settings {
  const row = db.get('SELECT data FROM settings WHERE user_id = ?', userId);
  const parsed = settingsSchema.safeParse(parseJson(row?.data, {}));
  const s = parsed.success ? parsed.data : settingsSchema.parse({});
  if (!s.dashboard.widgets.length) s.dashboard.widgets = DEFAULT_WIDGETS.map((w) => ({ ...w }));
  return s;
}

/** Deep-merges a partial update, validates the result and stores it. */
export function updateSettings(db: Db, userId: string, patch: unknown): Settings {
  const current = getSettings(db, userId);
  const merged = deepMerge(current, patch);
  const next = settingsSchema.parse(merged);
  for (const [tool, mode] of Object.entries(next.permissions.tools)) {
    if (mode === 'auto' && CONSEQUENTIAL_GUARD.has(tool)) next.permissions.tools[tool] = 'ask';
  }
  db.run(
    `INSERT INTO settings (user_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    userId, JSON.stringify(next), nowIso(),
  );
  return next;
}

/** Filled in by the tool registry so settings can refuse "auto" for consequential tools. */
export const CONSEQUENTIAL_GUARD = new Set<string>();

function deepMerge(base: any, patch: any): any {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out: any = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' ? deepMerge(base[k], v) : v;
  }
  return out;
}
