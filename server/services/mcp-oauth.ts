import { createHash, randomBytes } from 'node:crypto';
import type { Services } from '../context.ts';
import { badRequest } from '../context.ts';
import { parseJson } from '../db/index.ts';
import { checkConnectorUrl, McpError } from './mcp.ts';
import { encryptSecret, decryptSecret } from './secrets.ts';
import { LOOPBACK_PORT } from './apps/providers.ts';

/**
 * "Sign in with the app" for connected apps, following the MCP authorization spec: protected
 * resource metadata → authorization server metadata → dynamic client registration → browser
 * sign-in with PKCE (S256) → code exchange, with refresh. Every server-side request goes
 * through the same address checks as the MCP connection itself.
 */
export const OAUTH_STATE_TTL_MS = 15 * 60_000;

export interface OAuthTokens {
  type: 'oauth';
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_endpoint: string;
  client_id: string;
  client_secret?: string;
  resource: string;
}

const b64url = (b: Buffer) => b.toString('base64url');

async function getJson(services: Services, url: string, allowPrivate: boolean): Promise<any | null> {
  await checkConnectorUrl(url, allowPrivate);
  const f = services.mcpFetch ?? fetch;
  try {
    const res = await f(url, { headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Finds the app's authorization server, starting from the MCP server's 401 answer. */
async function discover(services: Services, mcpUrl: URL, allowPrivate: boolean) {
  const f = services.mcpFetch ?? fetch;
  let resourceMeta: string | null = null;
  try {
    const probe = await f(mcpUrl.href, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Carino', version: '1.3.0' } } }),
    });
    resourceMeta = probe.headers.get('www-authenticate')?.match(/resource_metadata="([^"]+)"/)?.[1] ?? null;
    await probe.body?.cancel().catch(() => undefined);
  } catch {
    throw badRequest('Could not reach that app.');
  }
  const prm = await getJson(services, resourceMeta ?? `${mcpUrl.origin}/.well-known/oauth-protected-resource${mcpUrl.pathname === '/' ? '' : mcpUrl.pathname}`, allowPrivate)
    ?? (resourceMeta ? null : await getJson(services, `${mcpUrl.origin}/.well-known/oauth-protected-resource`, allowPrivate));
  const issuer: string = prm?.authorization_servers?.[0] ?? mcpUrl.origin;
  const iss = new URL(issuer);
  const suffix = iss.pathname === '/' ? '' : iss.pathname;
  const as = await getJson(services, `${iss.origin}/.well-known/oauth-authorization-server${suffix}`, allowPrivate)
    ?? await getJson(services, `${iss.origin}/.well-known/openid-configuration${suffix}`, allowPrivate);
  if (!as?.authorization_endpoint || !as?.token_endpoint) throw badRequest('This app doesn’t offer sign-in that Carino can use. Try an access token instead.');
  if (as.code_challenge_methods_supported && !as.code_challenge_methods_supported.includes('S256')) throw badRequest('This app’s sign-in doesn’t support secure PKCE, so Carino won’t use it.');
  return { as, resource: prm?.resource ?? mcpUrl.href, scopes: (prm?.scopes_supported ?? as.scopes_supported) as string[] | undefined };
}

/** On the phone the browser brings sign-in back to the app's loopback listener (see My apps). */
export const redirectUri = (services: Services) => services.deviceSession
  ? `http://127.0.0.1:${LOOPBACK_PORT}/callback`
  : `${services.config.PUBLIC_URL.replace(/\/$/, '')}/api/connectors/oauth/callback`;

/** Starts sign-in: returns the app's authorization page to send the browser to. */
export async function startOAuth(services: Services, userId: string, name: string, rawUrl: string) {
  const allowPrivate = services.config.MCP_ALLOW_PRIVATE_NETWORK === 'true';
  const url = await checkConnectorUrl(rawUrl, allowPrivate).catch((e: McpError) => { throw badRequest(e.message); });
  const { as, resource, scopes } = await discover(services, url, allowPrivate);
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  if (as.registration_endpoint) {
    await checkConnectorUrl(as.registration_endpoint, allowPrivate).catch((e: McpError) => { throw badRequest(e.message); });
    const f = services.mcpFetch ?? fetch;
    const res = await f(as.registration_endpoint, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Carino', redirect_uris: [redirectUri(services)], grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'none',
      }),
    }).catch(() => null);
    const reg = res?.ok ? await res.json().catch(() => null) : null;
    clientId = reg?.client_id;
    clientSecret = reg?.client_secret;
  }
  if (!clientId) throw badRequest('This app requires a pre-registered client, which Carino can’t do automatically. Use a connector service or an access token instead.');
  await checkConnectorUrl(as.token_endpoint, allowPrivate).catch((e: McpError) => { throw badRequest(e.message); });
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(24));
  services.db.run('DELETE FROM oauth_states WHERE created_at < ?', new Date(services.now().getTime() - OAUTH_STATE_TTL_MS).toISOString());
  services.db.run(
    'INSERT INTO oauth_states (state, user_id, name, url, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    state, userId, name, url.href,
    encryptSecret(services.config.DATA_DIR, JSON.stringify({ verifier, clientId, clientSecret, token_endpoint: as.token_endpoint, resource })),
    services.now().toISOString(),
  );
  const auth = new URL(as.authorization_endpoint);
  if (auth.protocol !== 'https:' && !allowPrivate) throw badRequest('The app’s sign-in page isn’t on https.');
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', clientId);
  auth.searchParams.set('redirect_uri', redirectUri(services));
  auth.searchParams.set('state', state);
  auth.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
  auth.searchParams.set('code_challenge_method', 'S256');
  auth.searchParams.set('resource', resource);
  if (scopes?.length) auth.searchParams.set('scope', scopes.join(' '));
  return { authorize_url: auth.href, loopback: !!services.deviceSession };
}

async function tokenRequest(services: Services, endpoint: string, params: Record<string, string | undefined>) {
  await checkConnectorUrl(endpoint, services.config.MCP_ALLOW_PRIVATE_NETWORK === 'true');
  const body = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1]));
  const f = services.mcpFetch ?? fetch;
  const res = await f(endpoint, {
    method: 'POST', redirect: 'manual', body, signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
  }).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) as any : {};
  if (!res?.ok || !data.access_token) throw new McpError(`Sign-in with the app failed${data.error_description ? `: ${String(data.error_description).slice(0, 200)}` : data.error ? `: ${data.error}` : ''}.`);
  return data as { access_token: string; refresh_token?: string; expires_in?: number };
}

/** Finishes sign-in after the app redirects back; returns what to save as the connector's secret. */
export async function finishOAuth(services: Services, userId: string, state: string, code: string) {
  const row = services.db.get('SELECT * FROM oauth_states WHERE state = ? AND user_id = ?', state, userId);
  services.db.run('DELETE FROM oauth_states WHERE state = ?', state);
  if (!row || row.created_at < new Date(services.now().getTime() - OAUTH_STATE_TTL_MS).toISOString()) throw new McpError('That sign-in link has expired. Start again.');
  const d = parseJson<any>(decryptSecret(services.config.DATA_DIR, row.data), null);
  if (!d) throw new McpError('That sign-in can no longer be completed. Start again.');
  const t = await tokenRequest(services, d.token_endpoint, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri(services), client_id: d.clientId,
    client_secret: d.clientSecret, code_verifier: d.verifier, resource: d.resource,
  });
  const tokens: OAuthTokens = {
    type: 'oauth', access_token: t.access_token, refresh_token: t.refresh_token,
    expires_at: t.expires_in ? services.now().getTime() + t.expires_in * 1000 : undefined,
    token_endpoint: d.token_endpoint, client_id: d.clientId, client_secret: d.clientSecret, resource: d.resource,
  };
  return { name: row.name as string, url: row.url as string, tokens };
}

/** A usable access token, refreshed when it's about to expire. Returns new tokens to save, if any. */
export async function freshAccessToken(services: Services, t: OAuthTokens): Promise<{ token: string; updated?: OAuthTokens }> {
  if (!t.expires_at || t.expires_at - 60_000 > services.now().getTime() || !t.refresh_token) return { token: t.access_token };
  const r = await tokenRequest(services, t.token_endpoint, {
    grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id, client_secret: t.client_secret, resource: t.resource,
  }).catch(() => {
    throw new McpError('The app sign-in has expired. Use “Sign in again” on the Connected apps page.');
  });
  const updated: OAuthTokens = { ...t, access_token: r.access_token, refresh_token: r.refresh_token ?? t.refresh_token, expires_at: r.expires_in ? services.now().getTime() + r.expires_in * 1000 : undefined };
  return { token: updated.access_token, updated };
}
