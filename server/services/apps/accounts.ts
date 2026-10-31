import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Services } from '../../context.ts';
import { HttpError, badRequest } from '../../context.ts';
import type { Row } from '../../db/index.ts';
import { nowIso, parseJson } from '../../db/index.ts';
import { encryptSecret, decryptSecret } from '../secrets.ts';
import { OAUTH_STATE_TTL_MS } from '../mcp-oauth.ts';
import { helperConfig, helperPost, helperUrl } from '../helper.ts';
import { PROVIDERS, PROVIDER_IDS, LOOPBACK_PORT, isProvider, type ProviderId, type ClientGroup, type TokenSet } from './providers.ts';

/** An app problem the model and the user should see as-is (expired sign-in, missing permission…). */
export class AppError extends Error {
  override name = 'AppError';
}

export const STATE_PREFIX = 'app:';
export const MAX_ACCOUNTS_PER_PROVIDER = 5;

const fetcher = (services: Services) => services.netFetch ?? fetch;
const b64url = (b: Buffer) => b.toString('base64url');

/** On the phone the browser hands the sign-in back to a loopback address the app listens on. */
export function redirectFor(services: Services, provider: ProviderId) {
  if (services.deviceSession) return `http://${PROVIDERS[provider].loopbackHost}:${LOOPBACK_PORT}/callback`;
  return `${services.config.PUBLIC_URL.replace(/\/$/, '')}/api/apps/callback`;
}

// ---- Developer app credentials -------------------------------------------------------------

const clientInput = z.object({
  client_id: z.string().trim().min(4).max(300),
  client_secret: z.string().trim().max(500).optional(),
});

export function saveClient(services: Services, userId: string, group: ClientGroup, raw: unknown) {
  const i = clientInput.parse(raw);
  const needsSecret = PROVIDER_IDS.some((p) => PROVIDERS[p].group === group && PROVIDERS[p].secret === 'required');
  const existing = services.db.get('SELECT client_secret FROM app_clients WHERE user_id = ? AND provider = ?', userId, group);
  // A masked secret means "keep the saved one".
  const secret = i.client_secret && !i.client_secret.startsWith('••••') ? encryptSecret(services.config.DATA_DIR, i.client_secret) : i.client_secret ? existing?.client_secret ?? null : null;
  if (needsSecret && !secret) throw badRequest('Paste the client secret too — this app needs it.');
  services.db.run(
    `INSERT INTO app_clients (user_id, provider, client_id, client_secret, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET client_id = excluded.client_id, client_secret = excluded.client_secret, updated_at = excluded.updated_at`,
    userId, group, i.client_id, secret, nowIso(),
  );
  return { saved: true };
}

export function deleteClient(services: Services, userId: string, group: ClientGroup) {
  services.db.run('DELETE FROM app_clients WHERE user_id = ? AND provider = ?', userId, group);
  return { deleted: true };
}

function client(services: Services, userId: string, group: ClientGroup) {
  const row = services.db.get('SELECT * FROM app_clients WHERE user_id = ? AND provider = ?', userId, group);
  if (!row) return null;
  return { id: row.client_id as string, secret: decryptSecret(services.config.DATA_DIR, row.client_secret) ?? undefined };
}

// ---- What the My apps screen shows ---------------------------------------------------------

export async function presentApps(services: Services, userId: string) {
  const accounts = services.db.all('SELECT * FROM app_accounts WHERE user_id = ? ORDER BY created_at', userId);
  const clients = new Map(services.db.all('SELECT provider, client_id, client_secret FROM app_clients WHERE user_id = ?', userId).map((r) => [r.provider, r]));
  const helper = await helperConfig(services);
  return PROVIDER_IDS.map((id) => {
    const p = PROVIDERS[id];
    const c = clients.get(p.group);
    return {
      id, label: p.label, group: p.group, redirect_uri: redirectFor(services, id),
      client: c ? { client_id: c.client_id, has_secret: !!c.client_secret } : null,
      needs_secret: p.secret === 'required',
      // One tap: Carino's own app at this provider, through the sign-in helper.
      one_tap: !!helper?.providers[id],
      accounts: accounts.filter((a) => a.provider === id).map((a) => ({ id: a.id, label: a.label, last_error: a.last_error, created_at: a.created_at })),
    };
  });
}

/** The accounts the model may use, for its tools and system prompt. */
export function connectedProviders(services: Services, userId: string): Set<ProviderId> {
  return new Set(services.db.all('SELECT DISTINCT provider FROM app_accounts WHERE user_id = ?', userId).map((r) => r.provider as ProviderId));
}

// ---- Sign-in -------------------------------------------------------------------------------

/**
 * PKCE through the helper: its web-app registrations take PKCE alongside the secret for these;
 * TikTok's web flow and Meta's and LinkedIn's don't use it.
 */
const HELPER_PKCE: Partial<Record<ProviderId, 'S256'>> = { google: 'S256', microsoft: 'S256', x: 'S256' };

export async function startSignIn(services: Services, userId: string, provider: string) {
  if (!isProvider(provider)) throw new HttpError(404, 'Unknown app', 'not_found');
  const p = PROVIDERS[provider];
  // The user's own developer app wins if they set one up; otherwise Carino's (one tap).
  let c = client(services, userId, p.group);
  const helper = c ? null : await helperConfig(services);
  const managed = !!helper?.providers[provider];
  if (managed) c = { id: helper!.providers[provider].client_id, secret: undefined };
  if (!c) throw badRequest(`Add your ${p.label} developer app’s client ID first (see the steps on this page).`);
  if (!managed && p.secret === 'required' && !c.secret) throw badRequest(`Add your ${p.label} client secret first.`);
  const n = Number(services.db.get('SELECT COUNT(*) AS n FROM app_accounts WHERE user_id = ? AND provider = ?', userId, provider)!.n);
  if (n >= MAX_ACCOUNTS_PER_PROVIDER) throw badRequest(`You can connect up to ${MAX_ACCOUNTS_PER_PROVIDER} ${p.label} accounts.`);

  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(24));
  const redirect = managed ? `${helperUrl(services)}/callback/${provider}` : redirectFor(services, provider);
  const pkce = managed ? HELPER_PKCE[provider] ?? 'none' : p.pkce;
  services.db.run('DELETE FROM oauth_states WHERE created_at < ?', new Date(services.now().getTime() - OAUTH_STATE_TTL_MS).toISOString());
  services.db.run(
    'INSERT INTO oauth_states (state, user_id, name, url, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    state, userId, `${STATE_PREFIX}${provider}`, provider,
    encryptSecret(services.config.DATA_DIR, JSON.stringify({ verifier, redirect, managed, pkce })), services.now().toISOString(),
  );
  const auth = new URL(p.authorize);
  const q = auth.searchParams;
  q.set(p.clientParam ?? 'client_id', c.id);
  q.set('response_type', 'code');
  q.set('redirect_uri', redirect);
  q.set('scope', p.scopes.join(p.scopeSeparator ?? ' '));
  q.set('state', state);
  if (pkce !== 'none') {
    const digest = createHash('sha256').update(verifier).digest();
    q.set('code_challenge', pkce === 'S256-hex' ? digest.toString('hex') : b64url(digest));
    q.set('code_challenge_method', 'S256');
  }
  for (const [k, v] of Object.entries(p.extraAuth ?? {})) q.set(k, v);
  return { authorize_url: auth.href, loopback: !!services.deviceSession, one_tap: managed };
}

/** Sign-in through Carino's helper, which holds the app's client secret. */
async function helperTokens(services: Services, provider: ProviderId, body: Record<string, string | undefined>): Promise<TokenSet> {
  let d: { access_token: string; refresh_token?: string; expires_in?: number };
  try {
    d = await helperPost(services, body.code ? '/token' : '/refresh', { provider, ...body });
  } catch (e: any) {
    throw new AppError(`${PROVIDERS[provider].label} sign-in failed: ${String(e?.message ?? e).slice(0, 240)}`);
  }
  return {
    access_token: String(d.access_token), refresh_token: d.refresh_token ? String(d.refresh_token) : undefined,
    expires_at: d.expires_in ? services.now().getTime() + Number(d.expires_in) * 1000 : undefined, managed: true,
  };
}

async function tokenCall(services: Services, provider: ProviderId, c: { id: string; secret?: string }, params: Record<string, string | undefined>): Promise<TokenSet> {
  const p = PROVIDERS[provider];
  const f = fetcher(services);
  const body: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v) body[k] = v;
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (p.basicAuth && c.secret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(c.id)}:${encodeURIComponent(c.secret)}`).toString('base64')}`;
  else {
    body[p.clientParam ?? 'client_id'] = c.id;
    if (c.secret) body.client_secret = c.secret;
  }
  if (p.basicAuth && c.secret) body.client_id = c.id;
  let res: Response;
  try {
    res = await f(p.token, { method: 'POST', headers, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new AppError(`Could not reach ${p.label}. Check your internet connection.`);
  }
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) {
    const why = d.error_description ?? d.error?.message ?? d.error ?? d.message ?? `error ${res.status}`;
    throw new AppError(`${p.label} sign-in failed: ${String(typeof why === 'string' ? why : JSON.stringify(why)).slice(0, 240)}`);
  }
  return {
    access_token: String(d.access_token),
    refresh_token: d.refresh_token ? String(d.refresh_token) : undefined,
    expires_at: d.expires_in ? services.now().getTime() + Number(d.expires_in) * 1000 : undefined,
  };
}

/** Finishes a My apps sign-in after the provider sends the browser back. */
export async function finishSignIn(services: Services, userId: string, state: string, code: string) {
  const row = services.db.get('SELECT * FROM oauth_states WHERE state = ? AND user_id = ?', state, userId);
  services.db.run('DELETE FROM oauth_states WHERE state = ?', state);
  if (!row || !String(row.name).startsWith(STATE_PREFIX) || row.created_at < new Date(services.now().getTime() - OAUTH_STATE_TTL_MS).toISOString()) {
    throw new AppError('That sign-in link has expired. Start again from My apps.');
  }
  const provider = row.url as string;
  if (!isProvider(provider)) throw new AppError('Unknown app.');
  const p = PROVIDERS[provider];
  const d = parseJson<{ verifier: string; redirect: string; managed?: boolean; pkce?: string } | null>(decryptSecret(services.config.DATA_DIR, row.data), null);
  if (!d) throw new AppError('That sign-in can no longer be completed. Start again.');
  const pkce = d.pkce ?? p.pkce;
  let tokens: TokenSet;
  if (d.managed) {
    // The helper adds the app's secret (and, for Meta, swaps for a 60-day sign-in).
    tokens = await helperTokens(services, provider, { code, code_verifier: pkce === 'none' ? undefined : d.verifier });
  } else {
    const c = client(services, userId, p.group);
    if (!c) throw new AppError('That sign-in can no longer be completed. Start again.');
    tokens = await tokenCall(services, provider, c, {
      grant_type: 'authorization_code', code, redirect_uri: d.redirect, code_verifier: pkce === 'none' ? undefined : d.verifier,
    });
    if (p.afterToken) tokens = await p.afterToken(fetcher(services), tokens, c);
  }
  let who: { id: string; label: string };
  try {
    who = await p.identify(fetcher(services), tokens.access_token);
  } catch (e: any) {
    throw new AppError(`Signed in, but ${p.label} didn’t say which account: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  const secret = encryptSecret(services.config.DATA_DIR, JSON.stringify(tokens));
  const existing = services.db.get('SELECT id FROM app_accounts WHERE user_id = ? AND provider = ? AND external_id = ?', userId, provider, who.id);
  if (existing) {
    services.db.run('UPDATE app_accounts SET secret = ?, label = ?, last_error = NULL, updated_at = ? WHERE id = ?', secret, who.label, nowIso(), existing.id);
    return { provider, account: { id: existing.id as string, label: who.label } };
  }
  const a = services.db.insert('app_accounts', { user_id: userId, provider, external_id: who.id, label: who.label, secret });
  return { provider, account: { id: a.id as string, label: who.label } };
}

export function disconnect(services: Services, userId: string, accountId: string) {
  if (!services.db.deleteOwned('app_accounts', userId, accountId)) throw new HttpError(404, 'Account not found', 'not_found');
  return { deleted: true };
}

// ---- Using an account ----------------------------------------------------------------------

/** Picks the account a tool call means: the one named (email or handle), or the first. */
export function pickAccount(services: Services, userId: string, provider: ProviderId, wanted?: string): Row {
  const rows = services.db.all('SELECT * FROM app_accounts WHERE user_id = ? AND provider = ? ORDER BY created_at', userId, provider);
  if (!rows.length) throw new AppError(`${PROVIDERS[provider].label} isn’t connected. The user can connect it in My apps.`);
  if (!wanted) return rows[0];
  const w = wanted.trim().toLowerCase().replace(/^@/, '');
  const hit = rows.find((r) => String(r.label).toLowerCase().replace(/^@/, '') === w) ?? rows.find((r) => String(r.label).toLowerCase().includes(w));
  if (!hit) throw new AppError(`No connected ${PROVIDERS[provider].label} account matches "${wanted}". Connected: ${rows.map((r) => r.label).join(', ')}.`);
  return hit;
}

/** A usable access token for the account, refreshed when it's about to expire. */
export async function accessToken(services: Services, account: Row): Promise<string> {
  const provider = account.provider as ProviderId;
  const p = PROVIDERS[provider];
  const t = parseJson<TokenSet | null>(decryptSecret(services.config.DATA_DIR, account.secret), null);
  const again = `Sign in to ${p.label} again in My apps.`;
  if (!t) throw new AppError(`The saved ${p.label} sign-in can no longer be read. ${again}`);
  const now = services.now().getTime();
  if (!t.expires_at || t.expires_at - 60_000 > now) return t.access_token;
  if (!t.refresh_token) {
    markError(services, account, `Sign-in expired. ${again}`);
    throw new AppError(`The ${p.label} sign-in for ${account.label} has expired. ${again}`);
  }
  const c = t.managed ? null : client(services, account.user_id, p.group);
  if (!t.managed && !c) throw new AppError(`The ${p.label} developer app was removed from My apps. Add it again, then sign in.`);
  let next: TokenSet;
  try {
    next = t.managed
      ? await helperTokens(services, provider, { refresh_token: t.refresh_token })
      : await tokenCall(services, provider, c!, { grant_type: 'refresh_token', refresh_token: t.refresh_token, scope: p.refreshWithScope ? p.scopes.join(' ') : undefined });
  } catch (e: any) {
    markError(services, account, `Sign-in expired. ${again}`);
    throw new AppError(`The ${p.label} sign-in for ${account.label} has expired or was revoked. ${again}`);
  }
  const merged: TokenSet = { ...next, refresh_token: next.refresh_token ?? t.refresh_token };
  services.db.run('UPDATE app_accounts SET secret = ?, last_error = NULL, updated_at = ? WHERE id = ?', encryptSecret(services.config.DATA_DIR, JSON.stringify(merged)), nowIso(), account.id);
  return merged.access_token;
}

export function markError(services: Services, account: Row, message: string | null) {
  services.db.run('UPDATE app_accounts SET last_error = ? WHERE id = ?', message, account.id);
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  /** Raw body (bytes or form data) instead of JSON. */
  raw?: BodyInit;
  headers?: Record<string, string>;
  /** Return the response's bytes instead of JSON. */
  binary?: boolean;
  timeoutMs?: number;
}

/** Calls a provider API as the account, with errors worded for the user. */
export async function api<T = any>(services: Services, account: Row, url: string, o: ApiOptions = {}): Promise<T> {
  const label = PROVIDERS[account.provider as ProviderId].label;
  const token = await accessToken(services, account);
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: o.binary ? '*/*' : 'application/json', ...o.headers };
  let body: BodyInit | undefined = o.raw;
  if (o.body !== undefined) {
    headers['content-type'] ??= 'application/json';
    body = JSON.stringify(o.body);
  }
  let res: Response;
  try {
    res = await fetcher(services)(url, { method: o.method ?? (body ? 'POST' : 'GET'), headers, body, signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
  } catch {
    throw new AppError(`Could not reach ${label}. Check your internet connection.`);
  }
  if (res.ok && o.binary) return Buffer.from(await res.arrayBuffer()) as T;
  const text = await res.text();
  const data: any = text ? (() => { try { return JSON.parse(text); } catch { return { text }; } })() : {};
  if (res.ok) {
    if (account.last_error) markError(services, account, null);
    return data as T;
  }
  const detail = String(data?.error?.message ?? data?.error_description ?? data?.message ?? data?.detail ?? data?.title ?? data?.error?.code ?? (typeof data?.error === 'string' ? data.error : '') ?? '').slice(0, 300);
  if (res.status === 401) {
    markError(services, account, `Sign-in expired. Sign in to ${label} again.`);
    throw new AppError(`${label} says the sign-in for ${account.label} is no longer valid. The user should sign in again in My apps.`);
  }
  if (res.status === 403) throw new AppError(`${label} refused this for ${account.label}${detail ? `: ${detail}` : ''}. The account or developer app may be missing a permission.`);
  if (res.status === 429) throw new AppError(`${label} is limiting requests right now${detail ? ` (${detail})` : ''}. Try again later.`);
  if (res.status === 404) throw new AppError(`${label} couldn’t find that${detail ? `: ${detail}` : ''}.`);
  throw new AppError(`${label} error ${res.status}${detail ? `: ${detail}` : ''}`);
}
