import type { Services } from '../context.ts';
import { nowIso } from '../db/index.ts';
import { ProviderError } from './types.ts';
import { parseRef } from './providers.ts';
import { setStatus } from './catalog.ts';
import { notify } from '../services/activity.ts';

/**
 * Carino troubleshoots its AI services by itself. When a model fails it works out why and acts:
 *  - busy or rate-limited: rest it for a while (longer each time) and use another;
 *  - service down or timing out: rest it briefly and use another;
 *  - model retired or renamed: refresh that service's model list so the router stops picking it;
 *  - key rejected or out of credit: stop using that service and tell the user exactly what to fix
 *    (once, not on every message).
 * A success clears the slate. Nothing here ever bends the privacy or spending rules.
 */
export interface Diagnosis {
  cause: 'rate_limit' | 'outage' | 'gone' | 'auth' | 'credit' | 'other';
  /** How long to leave the model alone (ms), before backing off further on repeats. */
  restMs: number;
  /** What Carino tells the user, when they need to act. */
  advice?: string;
}

export function diagnose(err: unknown): Diagnosis {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  const kind = err instanceof ProviderError ? err.kind : null;
  if (/insufficient|quota|credit|billing|payment required|402/.test(msg)) return { cause: 'credit', restMs: 6 * 3600_000, advice: 'is out of credit or over its quota. Top it up, or Carino keeps using your other services.' };
  if (kind === 'auth' || /401|403|invalid api key|unauthori[sz]ed|api key not valid|permission/.test(msg)) return { cause: 'auth', restMs: 12 * 3600_000, advice: 'rejected its key. Paste a new key in Settings → AI & connections; until then Carino uses your other services.' };
  if (/model.*(not found|does not exist|deprecated|decommissioned|no longer)|404|unknown model/.test(msg)) return { cause: 'gone', restMs: 24 * 3600_000 };
  if (kind === 'rate_limited' || /429|rate limit|too many requests|overloaded|capacity/.test(msg)) return { cause: 'rate_limit', restMs: 60_000 };
  if (kind === 'unavailable' || /5\d\d|timeout|timed out|network|fetch failed|econn|unavailable/.test(msg)) return { cause: 'outage', restMs: 30_000 };
  return { cause: 'other', restMs: 15_000 };
}

/** Records a failure, rests the model, and fixes or reports what it can. */
export function recordFailure(services: Services, userId: string, ref: string | null, err: unknown): Diagnosis {
  const d = diagnose(err);
  const p = ref ? parseRef(ref) : null;
  if (!p) return d;
  const db = services.db;
  const row = db.get('SELECT fail_count FROM ai_models WHERE conn_id = ? AND model = ?', p.connId, p.model);
  const fails = Number(row?.fail_count ?? 0) + 1;
  // Back off: each repeat doubles the rest, up to a day.
  const rest = Math.min(d.restMs * 2 ** Math.min(fails - 1, 6), 24 * 3600_000);
  const until = new Date(services.now().getTime() + rest).toISOString();
  db.run(
    "UPDATE ai_models SET retry_after = ?, fail_count = ?, last_error = ?, status = CASE WHEN ? = 'gone' THEN 'unavailable' WHEN status = 'ok' OR status = 'untested' THEN 'limited' ELSE status END WHERE conn_id = ? AND model = ?",
    until, fails, String((err as Error)?.message ?? err).slice(0, 300), d.cause, p.connId, p.model,
  );
  const conn = services.providers.connection(p.connId);
  if (d.cause === 'gone') {
    // The service may have renamed it: ask it what it offers now (in the background).
    void import('./catalog.ts').then((c) => c.refreshModels(services, p.connId)).catch(() => {});
  }
  if (d.cause === 'auth' || d.cause === 'credit') {
    // The whole service is affected: rest all its models and tell the user once.
    db.run('UPDATE ai_models SET retry_after = ? WHERE conn_id = ?', until, p.connId);
    const label = conn?.label ?? p.connId;
    const prev = db.get("SELECT status FROM connection_status WHERE kind = 'ai' AND ref = ?", p.connId);
    setStatus(db, 'ai', p.connId, userId, d.cause === 'auth' ? 'needs_sign_in' : 'error', `${label} ${d.advice}`);
    if (prev?.status !== 'needs_sign_in' && prev?.status !== 'error') {
      notify(db, userId, { kind: 'ai_problem', title: `${label} needs you`, body: `${label} ${d.advice}`, link: '/connections' });
    }
  }
  return d;
}

/** A model answered: it's healthy again. */
export function recordSuccess(services: Services, ref: string | null) {
  const p = ref ? parseRef(ref) : null;
  if (!p) return;
  services.db.run(
    "UPDATE ai_models SET retry_after = NULL, fail_count = 0, status = CASE WHEN status = 'limited' THEN 'ok' ELSE status END WHERE conn_id = ? AND model = ? AND (fail_count > 0 OR retry_after IS NOT NULL OR status = 'limited')",
    p.connId, p.model,
  );
  const st = services.db.get("SELECT status FROM connection_status WHERE kind = 'ai' AND ref = ?", p.connId);
  if (st && st.status !== 'ok') setStatus(services.db, 'ai', p.connId, null, 'ok', null);
}

/** Resting models are skipped until their time is up. */
export const resting = (m: { retry_after?: string | null }, now: Date) => !!m.retry_after && m.retry_after > now.toISOString();

export { nowIso };

/** Remembers the most a model accepts per request, as its service reported. */
export function learnLimit(services: Services, ref: string | null, limit: number | undefined) {
  const p = ref ? parseRef(ref) : null;
  if (!p || !limit) return;
  services.db.run('UPDATE ai_models SET token_limit = ? WHERE conn_id = ? AND model = ?', Math.round(limit), p.connId, p.model);
}

/**
 * The most a model takes per request: what it told Carino before, or, for services whose free
 * plans are known to be tight (Groq), a careful guess until it says.
 */
export function knownLimit(services: Services, ref: string | null): number | null {
  const p = ref ? parseRef(ref) : null;
  if (!p) return null;
  const row = services.db.get('SELECT token_limit FROM ai_models WHERE conn_id = ? AND model = ?', p.connId, p.model);
  if (row?.token_limit) return Number(row.token_limit);
  const conn = services.providers.connection(p.connId);
  if (conn && /api\.groq\.com/.test(conn.baseUrl)) return 6000;
  return null;
}
