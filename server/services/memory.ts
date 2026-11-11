import { z } from 'zod';
import type { Db, Row } from '../db/index.ts';
import { nowIso } from '../db/index.ts';
import { indexEntity, unindexEntity, searchIndex } from './indexer.ts';
import { notFound } from '../context.ts';

export const MEMORY_CATEGORIES = ['profile', 'preference', 'goal', 'routine', 'project', 'date', 'fact', 'summary'] as const;

export const MEMORY_CONTEXTS = ['personal', 'work'] as const;

export const memoryInput = z.object({
  content: z.string().trim().min(2).max(2000),
  category: z.enum(MEMORY_CATEGORIES).default('fact'),
  context: z.enum(MEMORY_CONTEXTS).default('personal'),
  project_id: z.string().max(64).nullable().optional(),
  expires_at: z.string().nullable().optional(),
  sensitive: z.boolean().optional(),
});

/** An edit changes only what's sent (no defaults: they would reset the category or context). */
const memoryPatch = z.object({
  content: z.string().trim().min(2).max(2000),
  category: z.enum(MEMORY_CATEGORIES),
  context: z.enum(MEMORY_CONTEXTS),
  project_id: z.string().max(64).nullable(),
  expires_at: z.string().nullable(),
  sensitive: z.boolean(),
  status: z.enum(['active', 'proposed']),
  /** Never sent to an online AI. */
  local_only: z.boolean(),
}).partial();

/** Heuristics for information that needs explicit consent before Carino stores it long-term. */
const SENSITIVE_PATTERNS: [RegExp, string][] = [
  [/\b(password|passcode|pin|otp|secret|api[ -]?key|token)\b/i, 'credentials'],
  [/\b(diagnos\w*|illness|disease|medication|prescri\w*|hiv|pregnan\w*|mental health|depress\w*|anxiety|therapy|surgery|allerg\w*)\b/i, 'health'],
  [/\b(salary|income|debt|loan|bank|account number|credit card|card number|iban|swift|mobile money|net worth)\b/i, 'finances'],
  [/\b(passport|national id|nin\b|ssn|social security|driver'?s licen[cs]e|tax id|tin\b)\b/i, 'government ID'],
  [/\b(religio\w*|church|mosque|political|party member|sexual\w*|gay|lesbian|transgender|ethnic\w*|tribe)\b/i, 'personal beliefs or identity'],
  [/\b\d{9,}\b/, 'long number (possibly an account or ID)'],
  [/\b(home address|lives at|my address)\b/i, 'address'],
];

export function sensitivityOf(text: string): string | null {
  for (const [re, label] of SENSITIVE_PATTERNS) if (re.test(text)) return label;
  return null;
}

function reindex(db: Db, userId: string, m: Row) {
  if (m.status === 'active') indexEntity(db, userId, 'memory', m.id, m.category, m.content);
  else unindexEntity(db, userId, 'memory', m.id);
}

/**
 * Saves a memory. `status: 'proposed'` means it waits for the user's approval and is
 * not used in answers until approved.
 */
export function saveMemory(db: Db, userId: string, raw: unknown, opts: { status?: 'active' | 'proposed'; source?: string; sourceRef?: string } = {}) {
  const input = memoryInput.parse(raw);
  if (input.project_id && !db.getOwned('projects', userId, input.project_id)) throw notFound('Project');
  const sensitive = input.sensitive ?? !!sensitivityOf(input.content);
  const dup = db.get(
    "SELECT * FROM memories WHERE user_id = ? AND lower(content) = lower(?) AND status = 'active'", userId, input.content,
  );
  if (dup) return { memory: dup, duplicate: true };
  const m = db.insert('memories', {
    user_id: userId,
    content: input.content,
    category: input.category,
    context: input.context,
    project_id: input.project_id ?? null,
    expires_at: input.expires_at ?? null,
    sensitive: sensitive ? 1 : 0,
    status: opts.status ?? 'active',
    source: opts.source ?? 'user',
    source_ref: opts.sourceRef ?? null,
  });
  reindex(db, userId, m);
  return { memory: m, duplicate: false };
}

export function updateMemory(db: Db, userId: string, id: string, raw: unknown) {
  const input = memoryPatch.parse(raw);
  const m = db.updateOwned('memories', userId, id, {
    content: input.content,
    category: input.category,
    context: input.context,
    project_id: input.project_id,
    expires_at: input.expires_at,
    sensitive: input.sensitive === undefined ? undefined : input.sensitive ? 1 : 0,
    status: input.status,
    local_only: input.local_only === undefined ? undefined : input.local_only ? 1 : 0,
  });
  if (!m) throw notFound('Memory');
  reindex(db, userId, m);
  return m;
}

export function deleteMemory(db: Db, userId: string, id: string) {
  const ok = db.deleteOwned('memories', userId, id);
  if (!ok) throw notFound('Memory');
  unindexEntity(db, userId, 'memory', id);
  return { deleted: true };
}

export function clearMemories(db: Db, userId: string, categories?: string[]) {
  return db.tx(() => {
    const rows = categories?.length
      ? db.all(`SELECT id FROM memories WHERE user_id = ? AND category IN (${categories.map(() => '?').join(',')})`, userId, ...categories)
      : db.all('SELECT id FROM memories WHERE user_id = ?', userId);
    for (const r of rows) {
      unindexEntity(db, userId, 'memory', r.id);
      db.run('DELETE FROM memories WHERE id = ?', r.id);
    }
    return { deleted: rows.length };
  });
}

/** Removes memories past their retention date. Returns how many were removed. */
export function expireMemories(db: Db, now: Date) {
  const rows = db.all('SELECT id, user_id FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?', now.toISOString());
  for (const r of rows) {
    unindexEntity(db, r.user_id, 'memory', r.id);
    db.run('DELETE FROM memories WHERE id = ?', r.id);
  }
  return rows.length;
}

/**
 * Finds the memories relevant to a message: always the core profile/preferences,
 * plus full-text matches. Only active (approved) memories are returned.
 */
export function retrieveMemories(db: Db, userId: string, query: string, opts: { projectId?: string | null; limit?: number; disabledCategories?: string[] } = {}) {
  const limit = opts.limit ?? 12;
  const disabled = new Set(opts.disabledCategories ?? []);
  const picked = new Map<string, Row>();
  const core = db.all(
    `SELECT * FROM memories WHERE user_id = ? AND status = 'active' AND category IN ('profile','preference')
     ORDER BY updated_at DESC LIMIT 8`, userId,
  );
  for (const m of core) if (!disabled.has(m.category)) picked.set(m.id, m);
  if (opts.projectId) {
    for (const m of db.all("SELECT * FROM memories WHERE user_id = ? AND status = 'active' AND project_id = ? ORDER BY updated_at DESC LIMIT 6", userId, opts.projectId))
      if (!disabled.has(m.category)) picked.set(m.id, m);
  }
  for (const hit of searchIndex(db, userId, query, { entities: ['memory'], limit: limit * 2 })) {
    if (picked.size >= limit) break;
    const m = db.getOwned('memories', userId, hit.id);
    if (m && m.status === 'active' && !disabled.has(m.category)) picked.set(m.id, m);
  }
  const list = [...picked.values()].slice(0, limit);
  if (list.length) {
    const ts = nowIso();
    for (const m of list) db.run('UPDATE memories SET last_used_at = ? WHERE id = ?', ts, m.id);
  }
  return list;
}

/** Deletes the given memories (only the user's own); returns how many went. */
export function deleteMemories(db: Db, userId: string, ids: string[]) {
  let n = 0;
  for (const id of ids) {
    if (!db.getOwned('memories', userId, id)) continue;
    deleteMemory(db, userId, id);
    n++;
  }
  return { deleted: n };
}
