import type { Services } from '../context.ts';
import { refreshModels, setStatus } from '../ai/catalog.ts';
import { accessToken, MANAGE_ACCESS_URL } from './apps/accounts.ts';
import { PROVIDERS, type ProviderId } from './apps/providers.ts';
import { refreshConnector } from './connectors.ts';

/**
 * Keeps authorised connections working: refreshes sign-ins before they lapse, re-reads what each
 * AI service and connected tool offers, and records the result so the Connections page can show
 * it. Only connections the user already set up are touched; nothing new is signed into.
 */

const STALE_MS = 6 * 3600_000;

export async function refreshAll(services: Services, userId: string, opts: { force?: boolean } = {}) {
  const { db } = services;
  const now = services.now().getTime();
  const fresh = (kind: string, ref: string) => {
    if (opts.force) return false;
    const r = db.get('SELECT checked_at FROM connection_status WHERE kind = ? AND ref = ?', kind, ref);
    return !!r && now - Date.parse(r.checked_at) < STALE_MS;
  };
  const out = { ai: 0, accounts: 0, connectors: 0, problems: [] as string[] };

  await Promise.all(services.providers.connections().map(async (c) => {
    if (fresh('ai', c.id)) return;
    const r = await refreshModels(services, c.id).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    out.ai++;
    if (!r.ok) out.problems.push(`${c.label}: ${r.error}`);
  }));

  for (const a of db.all('SELECT * FROM app_accounts WHERE user_id = ?', userId)) {
    if (fresh('account', a.id)) continue;
    out.accounts++;
    try {
      // Refreshes the sign-in when it's close to expiring, using the saved refresh token.
      await accessToken(services, a);
      setStatus(db, 'account', a.id, userId, 'ok');
      db.run('UPDATE app_accounts SET last_error = NULL WHERE id = ?', a.id);
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 300);
      setStatus(db, 'account', a.id, userId, 'needs_sign_in', msg);
      out.problems.push(`${PROVIDERS[a.provider as ProviderId]?.label ?? a.provider}: ${msg}`);
    }
  }

  for (const c of db.all('SELECT id, name FROM connectors WHERE user_id = ? AND enabled = 1', userId)) {
    if (fresh('connector', c.id)) continue;
    out.connectors++;
    const r = await refreshConnector(services, userId, c.id).catch(() => null);
    const err = r?.last_error ?? (r ? null : 'Could not check it.');
    setStatus(db, 'connector', c.id, userId, err ? (/sign|auth|token|401|403/i.test(err) ? 'needs_sign_in' : 'error') : 'ok', err);
    if (err) out.problems.push(`${c.name}: ${err}`);
  }
  return out;
}

/** Everything connected, with its last check, for the Connections page. */
export function connectionList(services: Services, userId: string) {
  const { db } = services;
  const status = new Map(db.all('SELECT * FROM connection_status WHERE user_id = ? OR user_id IS NULL', userId).map((r) => [`${r.kind}:${r.ref}`, r]));
  const st = (kind: string, ref: string) => {
    const r = status.get(`${kind}:${ref}`);
    return r ? { status: r.status, detail: r.detail, checked_at: r.checked_at } : { status: 'unchecked', detail: null, checked_at: null };
  };
  return {
    ai: services.providers.connections().map((c) => ({
      id: c.id, label: c.label, api: c.api, local: c.local, billing: c.billing, main: !!c.main, preset: c.preset ?? null,
      models: Number(db.get("SELECT COUNT(*) AS n FROM ai_models WHERE conn_id = ? AND status != 'unavailable'", c.id)!.n),
      ...st('ai', c.id),
    })),
    accounts: db.all('SELECT id, provider, label, last_error, created_at FROM app_accounts WHERE user_id = ? ORDER BY created_at', userId).map((a) => ({
      id: a.id, provider: a.provider, provider_label: PROVIDERS[a.provider as ProviderId]?.label ?? a.provider, label: a.label,
      manage_url: MANAGE_ACCESS_URL[a.provider as ProviderId] ?? null, ...st('account', a.id),
      ...(a.last_error && !status.has(`account:${a.id}`) ? { status: 'needs_sign_in', detail: a.last_error } : {}),
    })),
    connectors: db.all('SELECT id, name, url, enabled, last_error, last_checked_at FROM connectors WHERE user_id = ? ORDER BY created_at', userId).map((c) => ({
      id: c.id, name: c.name, url: c.url, enabled: !!c.enabled, ...st('connector', c.id),
      ...(c.last_error && !status.has(`connector:${c.id}`) ? { status: 'error', detail: c.last_error, checked_at: c.last_checked_at } : {}),
    })),
  };
}
