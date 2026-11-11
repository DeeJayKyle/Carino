import type { Services } from '../context.ts';
import type { Db, Row } from '../db/index.ts';
import { nowIso, parseJson } from '../db/index.ts';
import { ANTHROPIC_PRICING } from './anthropic.ts';
import { modelRef, type ConnectionSpec } from './providers.ts';
import { ProviderError, textOf, type ToolSpec } from './types.ts';
import { recordUsage } from './agent.ts';

/**
 * The model catalog: every model of every connection, whether it's free, what it costs, what it
 * can do (tested, not assumed), and how well and fast it did on a short fixed test.
 */

export interface Caps { chat?: boolean; responses?: boolean; streaming?: boolean; tools?: boolean; vision?: boolean; json?: boolean; api?: 'chat' | 'responses' }
export interface Scores { basic?: number; tools?: number; extract?: number; reason?: number; vision?: number }

export interface CatalogModel {
  ref: string;
  conn_id: string;
  model: string;
  label: string | null;
  connection: string;
  local: boolean;
  /** true paid, false free, null unknown (treated as paid). */
  paid: boolean | null;
  price_in: number | null;
  price_out: number | null;
  caps: Caps;
  scores: Scores;
  quality: number | null;
  latency_ms: number | null;
  status: string;
  last_error: string | null;
  tested_at: string | null;
}

export function present(r: Row, conns: Map<string, ConnectionSpec>): CatalogModel {
  const scores = parseJson<Scores>(r.scores, {});
  const vals = Object.values(scores).filter((x): x is number => typeof x === 'number');
  return {
    ref: modelRef(r.conn_id, r.model), conn_id: r.conn_id, model: r.model, label: r.label, connection: conns.get(r.conn_id)?.label ?? r.conn_id,
    local: !!r.local, paid: r.paid === null || r.paid === undefined ? null : !!r.paid, price_in: r.price_in, price_out: r.price_out,
    caps: parseJson<Caps>(r.caps, {}), scores, quality: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
    latency_ms: r.latency_ms, status: r.status, last_error: r.last_error, tested_at: r.tested_at,
  };
}

export function listCatalog(services: Services): CatalogModel[] {
  const conns = new Map(services.providers.connections().map((c) => [c.id, c]));
  return services.db.all('SELECT * FROM ai_models ORDER BY conn_id, model')
    .filter((r) => conns.has(r.conn_id))
    .map((r) => present(r, conns));
}

function pricingFor(c: ConnectionSpec, model: string): { paid: number | null; price_in: number | null; price_out: number | null; source: string | null } {
  if (c.local) return { paid: 0, price_in: 0, price_out: 0, source: 'list' };
  if (c.api === 'anthropic') {
    const p = ANTHROPIC_PRICING[model];
    return { paid: 1, price_in: p?.input ?? null, price_out: p?.output ?? null, source: p ? 'list' : null };
  }
  if (c.billing === 'free' && c.models.some((m) => m.id === model)) return { paid: 0, price_in: 0, price_out: 0, source: 'list' };
  if (c.billing === 'paid') return { paid: 1, price_in: null, price_out: null, source: null };
  return { paid: null, price_in: null, price_out: null, source: null };
}

/** Makes sure every known model of every connection has a row (without touching test results). */
export function syncCatalog(services: Services) {
  const { db } = services;
  for (const c of services.providers.connections()) {
    for (const m of c.models) upsertSeen(db, c, m.id, { label: m.label, vision: m.vision });
  }
}

function upsertSeen(db: Db, c: ConnectionSpec, model: string, hint: { label?: string; vision?: boolean; price?: { input: number; output: number } } = {}) {
  const existing = db.get('SELECT * FROM ai_models WHERE conn_id = ? AND model = ?', c.id, model);
  const price = hint.price ? { paid: hint.price.input + hint.price.output > 0 ? 1 : 0, price_in: hint.price.input, price_out: hint.price.output, source: 'provider' } : pricingFor(c, model);
  if (!existing) {
    db.run(
      'INSERT INTO ai_models (conn_id, model, label, local, paid, price_in, price_out, price_source, caps, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      c.id, model, hint.label ?? null, c.local ? 1 : 0, price.paid, price.price_in, price.price_out, price.source,
      JSON.stringify(hint.vision !== undefined ? { vision: hint.vision } : {}), nowIso(),
    );
    return;
  }
  // A price the user typed in wins over the list; otherwise keep what the service or list says.
  const keepUser = existing.price_source === 'user';
  db.run(
    `UPDATE ai_models SET seen_at = ?, local = ?, label = COALESCE(?, label),
       paid = CASE WHEN ? THEN paid ELSE ? END, price_in = CASE WHEN ? THEN price_in ELSE ? END,
       price_out = CASE WHEN ? THEN price_out ELSE ? END, price_source = CASE WHEN ? THEN price_source ELSE ? END,
       status = CASE WHEN status = 'unavailable' AND last_error = 'gone' THEN 'untested' ELSE status END
     WHERE conn_id = ? AND model = ?`,
    nowIso(), c.local ? 1 : 0, hint.label ?? null,
    keepUser ? 1 : 0, price.paid, keepUser ? 1 : 0, price.price_in, keepUser ? 1 : 0, price.price_out, keepUser ? 1 : 0, price.source,
    c.id, model,
  );
}

export function setStatus(db: Db, kind: string, ref: string, userId: string | null, status: string, detail?: string | null) {
  db.run(
    `INSERT INTO connection_status (kind, ref, user_id, status, detail, checked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, ref) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at, user_id = excluded.user_id`,
    kind, ref, userId, status, detail ?? null, nowIso(),
  );
}

/** Models that don't chat (embeddings, speech, images, moderation): not offered for conversations. */
const NOT_CHAT = /(embed|whisper|tts|dall-e|moderation|transcribe|realtime|audio|image-|imagen|veo|search-preview|davinci|babbage|rerank|guard)/i;

/**
 * Asks a service which models it offers now. New ones are added (untested); ones it no longer
 * offers are marked unavailable so they're skipped instead of failing mid-conversation.
 */
export async function refreshModels(services: Services, connId: string): Promise<{ ok: boolean; models: number; error?: string }> {
  const c = services.providers.connection(connId);
  if (!c) return { ok: false, models: 0, error: 'Not set up' };
  syncCatalog(services);
  if (c.api === 'anthropic') {
    setStatus(services.db, 'ai', connId, null, 'ok');
    return { ok: true, models: c.models.length };
  }
  let res: Response;
  try {
    res = await services.providers.fetchImpl(`${c.baseUrl.replace(/\/$/, '')}/models`, {
      headers: c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}, signal: AbortSignal.timeout(15_000),
    });
  } catch {
    const detail = c.local ? 'Not running, or not reachable from this device.' : 'Could not reach the service.';
    setStatus(services.db, 'ai', connId, null, 'offline', detail);
    return { ok: false, models: 0, error: detail };
  }
  if (res.status === 401 || res.status === 403) {
    setStatus(services.db, 'ai', connId, null, 'needs_sign_in', 'The key was rejected. Enter a new one.');
    return { ok: false, models: 0, error: 'The key was rejected.' };
  }
  if (!res.ok) {
    setStatus(services.db, 'ai', connId, null, 'error', `The service answered ${res.status}.`);
    return { ok: false, models: 0, error: `HTTP ${res.status}` };
  }
  const data: any = await res.json().catch(() => ({}));
  const list: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const seen = new Set<string>();
  for (const m of list.slice(0, 400)) {
    const id = String(m?.id ?? m?.name ?? '').replace(/^models\//, '');
    if (!id || NOT_CHAT.test(id)) continue;
    seen.add(id);
    // OpenRouter and some others say the price per token and what the model reads.
    const p = m?.pricing && Number.isFinite(Number(m.pricing.prompt)) ? { input: Number(m.pricing.prompt) * 1e6, output: Number(m.pricing.completion ?? 0) * 1e6 } : undefined;
    const vision = Array.isArray(m?.architecture?.input_modalities) ? m.architecture.input_modalities.includes('image') : undefined;
    // Don't flood the catalog with hundreds of paid models from an aggregator: free ones, and ones
    // the setup already lists, are enough to choose from.
    if (p && p.input + p.output > 0 && !c.models.some((x) => x.id === id)) continue;
    upsertSeen(services.db, c, id, { vision, price: p });
  }
  if (seen.size) {
    for (const r of services.db.all("SELECT model FROM ai_models WHERE conn_id = ? AND status != 'unavailable'", connId)) {
      if (!seen.has(r.model)) services.db.run("UPDATE ai_models SET status = 'unavailable', last_error = 'gone' WHERE conn_id = ? AND model = ?", connId, r.model);
    }
  }
  setStatus(services.db, 'ai', connId, null, 'ok', `${seen.size} models`);
  return { ok: true, models: seen.size };
}

// ---- Testing -------------------------------------------------------------------------------

const RED_SQUARE = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR42mN4oKBAU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAKWUgD269a5MAAAAAElFTkSuQmCC';
const TIME_TOOL: ToolSpec = {
  name: 'get_time', description: 'Returns the current time in a time zone.',
  input_schema: { type: 'object', properties: { zone: { type: 'string', description: 'IANA time zone, e.g. Africa/Kampala' } }, required: ['zone'] },
};

/** Rough token use of one full test, for the cost estimate shown before testing a paid model. */
export const TEST_TOKENS = { input: 2200, output: 400 };

export function testCostUsd(m: Pick<CatalogModel, 'price_in' | 'price_out'>): number | null {
  if (m.price_in === null || m.price_out === null) return null;
  return (TEST_TOKENS.input * m.price_in + TEST_TOKENS.output * m.price_out) / 1e6;
}

export interface TestResult { ok: boolean; status: string; caps: Caps; scores: Scores; latency_ms: number | null; error?: string }

/**
 * Tests one model for real: a plain reply (and how fast), a tool call, pulling details out as
 * JSON, a small reasoning step and — unless it's known not to — reading a photo. Also checks
 * which APIs the service accepts for it (Chat Completions and the Responses API).
 */
export async function testModel(services: Services, userId: string, connId: string, model: string): Promise<TestResult> {
  const c = services.providers.connection(connId);
  if (!c) throw new ProviderError('not_configured', 'That AI service is no longer set up.');
  const row = services.db.get('SELECT * FROM ai_models WHERE conn_id = ? AND model = ?', connId, model);
  const prior = parseJson<Caps>(row?.caps, {});
  const caps: Caps = { ...prior };
  const scores: Scores = {};
  const pricing = row && row.price_in !== null && row.price_out !== null ? { input: row.price_in, output: row.price_out } : undefined;

  // Which API: try the connection's own; for OpenAI-style services also try the other one.
  let api: 'chat' | 'responses' = c.api === 'responses' ? 'responses' : 'chat';
  if (c.api !== 'anthropic') {
    const other = api === 'chat' ? 'responses' : 'chat';
    caps[api] = await apiWorks(services, c, model, api);
    caps[other] = await apiWorks(services, c, model, other);
    if (!caps[api] && caps[other]) api = other;
    caps.api = api;
    if (!caps.chat && !caps.responses) {
      const status = 'unavailable';
      save(services, connId, model, status, caps, scores, null, 'Neither API answered for this model.');
      return { ok: false, status, caps, scores, latency_ms: null, error: 'This model didn’t answer. It may be retired, or the key can’t use it.' };
    }
  }
  const provider = services.providers.providerFor(connId, model, { api: c.api === 'anthropic' ? undefined : api, pricing, vision: true, tools: true });
  const info = provider.info();
  const run = async (prompt: string, opts: { tools?: ToolSpec[]; image?: boolean } = {}) => {
    const started = Date.now();
    const res = await provider.chat({
      system: 'You are being tested. Follow the instruction exactly and keep the answer short.',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...(opts.image ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_SQUARE } } as any] : [])] }],
      tools: opts.tools ?? [], maxTokens: 300, signal: AbortSignal.timeout(90_000),
    });
    recordUsage(services, userId, info.id, res.model, res.usage, info.pricing, 'model_test');
    return { res, ms: Date.now() - started, text: textOf(res.content).trim() };
  };

  let latency: number | null = null;
  try {
    const basic = await run('Reply with exactly the word: ready');
    latency = basic.ms;
    caps.streaming = true;
    scores.basic = /\bready\b/i.test(basic.text) ? 1 : basic.text ? 0.5 : 0;
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    const status = err instanceof ProviderError && err.kind === 'rate_limited' ? 'limited' : 'unavailable';
    save(services, connId, model, status, caps, scores, null, msg);
    return { ok: false, status, caps, scores, latency_ms: null, error: msg };
  }
  try {
    const t = await run('What time is it in Kampala right now? Use the tool.', { tools: [TIME_TOOL] });
    const call = t.res.content.find((b: any) => b.type === 'tool_use') as any;
    caps.tools = !!call;
    scores.tools = call ? (call.name === 'get_time' && /kampala/i.test(String(call.input?.zone ?? '')) ? 1 : 0.5) : 0;
  } catch {
    caps.tools = false;
    scores.tools = 0;
  }
  try {
    const e = await run('Pull out the person and the amount from this note, as JSON {"person": string, "amount": number} and nothing else: "Paid Sarah 45,000 for lunch on Tuesday."');
    const j = JSON.parse(e.text.replace(/^```(json)?|```$/g, '').trim().match(/\{[\s\S]*\}/)?.[0] ?? 'null');
    caps.json = !!j;
    scores.extract = j ? (/sarah/i.test(String(j.person)) ? 0.5 : 0) + (Number(j.amount) === 45000 ? 0.5 : 0) : 0;
  } catch {
    caps.json = false;
    scores.extract = 0;
  }
  try {
    const r = await run('A pharmacy opens at 08:00 and closes 9 hours and 30 minutes later. When does it close? Answer only with the time as HH:MM.');
    scores.reason = /17[:.]30/.test(r.text) ? 1 : 0;
  } catch {
    scores.reason = 0;
  }
  if (prior.vision !== false || c.api === 'anthropic') {
    try {
      const v = await run('What colour is this square? Answer with one word.', { image: true });
      caps.vision = /\bred\b/i.test(v.text);
      scores.vision = caps.vision ? 1 : 0;
    } catch {
      caps.vision = false;
    }
  }
  if (!caps.vision) delete scores.vision;
  const status = 'ok';
  save(services, connId, model, status, caps, scores, latency, null);
  return { ok: true, status, caps, scores, latency_ms: latency };
}

async function apiWorks(services: Services, c: ConnectionSpec, model: string, api: 'chat' | 'responses'): Promise<boolean> {
  const url = `${c.baseUrl.replace(/\/$/, '')}/${api === 'chat' ? 'chat/completions' : 'responses'}`;
  const body = api === 'chat'
    ? { model, messages: [{ role: 'user', content: 'Reply OK' }], max_tokens: 16 }
    : { model, input: 'Reply OK', max_output_tokens: 16, store: false };
  try {
    const res = await services.providers.fetchImpl(url, {
      method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(45_000),
      headers: { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
    });
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

function save(services: Services, connId: string, model: string, status: string, caps: Caps, scores: Scores, latency: number | null, error: string | null) {
  services.db.run(
    'UPDATE ai_models SET status = ?, caps = ?, scores = ?, latency_ms = ?, last_error = ?, tested_at = ? WHERE conn_id = ? AND model = ?',
    status, JSON.stringify(caps), JSON.stringify(scores), latency, error, nowIso(), connId, model,
  );
}

/** A price the user typed for a model the list doesn't price (USD per million tokens). */
export function setPrice(db: Db, ref: { connId: string; model: string }, input: number, output: number) {
  db.run("UPDATE ai_models SET price_in = ?, price_out = ?, paid = ?, price_source = 'user' WHERE conn_id = ? AND model = ?", input, output, input + output > 0 ? 1 : 0, ref.connId, ref.model);
}

// ---- Spending --------------------------------------------------------------------------------

export function spentUsd(db: Db, userId: string, hours: number, now: Date): number {
  const since = new Date(now.getTime() - hours * 3600_000).toISOString();
  return Number(db.get('SELECT COALESCE(SUM(cost_usd), 0) AS n FROM usage WHERE user_id = ? AND created_at >= ?', userId, since)!.n);
}

export function usageSummary(db: Db, userId: string, now: Date) {
  const day = new Date(now.getTime() - 86400_000).toISOString();
  const month = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const byModel = db.all(
    `SELECT COALESCE(conn_id, provider) AS conn_id, provider, model, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd
     FROM usage WHERE user_id = ? AND created_at >= ? GROUP BY COALESCE(conn_id, provider), model ORDER BY cost_usd DESC, calls DESC`, userId, month);
  const byDay = db.all(
    `SELECT substr(created_at, 1, 10) AS day, SUM(cost_usd) AS cost_usd, SUM(input_tokens + output_tokens) AS tokens, COUNT(*) AS calls
     FROM usage WHERE user_id = ? AND created_at >= ? GROUP BY day ORDER BY day`, userId, month);
  return { today: spentUsd(db, userId, 24, now), month: spentUsd(db, userId, 30 * 24, now), since: { day, month }, byModel, byDay };
}
