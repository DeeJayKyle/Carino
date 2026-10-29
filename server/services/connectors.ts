import { z } from 'zod';
import type { Services } from '../context.ts';
import { HttpError, badRequest } from '../context.ts';
import type { Db, Row } from '../db/index.ts';
import { parseJson, nowIso } from '../db/index.ts';
import type { ToolSpec } from '../ai/types.ts';
import { McpClient, McpError, checkConnectorUrl, resultText, type McpTool } from './mcp.ts';
import { encryptSecret, decryptSecret } from './secrets.ts';
import { freshAccessToken, type OAuthTokens } from './mcp-oauth.ts';
import { getSettings, updateSettings } from './settings.ts';

export const MAX_CONNECTORS = 10;
const MAX_TOOLS_PER_CONNECTOR = 40;
export const TOOL_PREFIX = 'mcp_';

export type ConnectorRisk = 'read' | 'reversible' | 'consequential';

/** What Carino keeps about each tool a connector offers. */
export interface CachedTool {
  /** Name the model sees: mcp_<slug>_<tool>, within providers' 64-character limit. */
  key: string;
  name: string;
  title?: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** From the server's own hints: read-only tools run freely, destructive ones always need approval. */
  risk: ConnectorRisk;
}

const addInput = z.object({
  name: z.string().trim().min(1).max(40),
  url: z.string().trim().min(8).max(500),
  /** Sent as the Authorization header. A bare token becomes "Bearer <token>". */
  token: z.string().trim().max(4000).optional(),
});

const updateInput = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  enabled: z.boolean().optional(),
  token: z.string().trim().max(4000).nullable().optional(),
  tool_modes: z.record(z.string().max(200), z.enum(['auto', 'ask', 'off'])).optional(),
});

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'app';
}

function uniqueSlug(db: Db, userId: string, name: string) {
  const base = slugify(name);
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base.slice(0, 10)}${n}`;
    if (!db.get('SELECT 1 FROM connectors WHERE user_id = ? AND slug = ?', userId, slug)) return slug;
  }
}

function authHeader(token?: string | null) {
  if (!token) return undefined;
  return /^(bearer|basic|token)\s/i.test(token) ? token : `Bearer ${token}`;
}

export function riskOf(t: McpTool): ConnectorRisk {
  if (t.annotations?.destructiveHint === true) return 'consequential';
  if (t.annotations?.readOnlyHint === true) return 'read';
  return 'reversible';
}

export function toolKey(slug: string, name: string) {
  const clean = name.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${TOOL_PREFIX}${slug}_${clean}`.slice(0, 64);
}

function cacheTools(slug: string, connectorName: string, tools: McpTool[]): CachedTool[] {
  const seen = new Set<string>();
  const out: CachedTool[] = [];
  for (const t of tools.slice(0, MAX_TOOLS_PER_CONNECTOR)) {
    const key = toolKey(slug, t.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const schema = t.inputSchema && typeof t.inputSchema === 'object' && (t.inputSchema as any).type === 'object' ? t.inputSchema : { type: 'object', properties: {} };
    out.push({
      key, name: t.name.slice(0, 200), title: (t.title ?? t.annotations?.title)?.slice(0, 120),
      description: `[Connected app “${connectorName}”] ${(t.description ?? t.title ?? t.name).slice(0, 1000)}`,
      input_schema: schema, risk: riskOf(t),
    });
  }
  return out;
}

/** The saved secret is either a token the user pasted or tokens from signing in with the app. */
function readSecret(services: Services, c: Row): { token: string | null; oauth: OAuthTokens | null } {
  if (!c.auth_secret) return { token: null, oauth: null };
  const raw = decryptSecret(services.config.DATA_DIR, c.auth_secret);
  if (raw === null) throw new McpError('The saved access token can no longer be read (the server’s secret key changed, e.g. after a restore). Enter the token or sign in again.');
  if (raw.startsWith('{"type":"oauth"')) return { token: null, oauth: JSON.parse(raw) as OAuthTokens };
  return { token: raw, oauth: null };
}

async function clientFor(services: Services, c: Row) {
  const { token, oauth } = readSecret(services, c);
  let header = authHeader(token);
  if (oauth) {
    const fresh = await freshAccessToken(services, oauth);
    if (fresh.updated) services.db.run('UPDATE connectors SET auth_secret = ? WHERE id = ?', encryptSecret(services.config.DATA_DIR, JSON.stringify(fresh.updated)), c.id);
    header = `Bearer ${fresh.token}`;
  }
  return new McpClient(c.url, header ? { authorization: header } : {}, services.mcpFetch);
}

export function presentConnector(db: Db, userId: string, c: Row) {
  const modes = getSettings(db, userId).permissions.tools;
  return {
    id: c.id, name: c.name, url: c.url, enabled: !!c.enabled, has_token: !!c.auth_secret, signed_in: !!c.auth_secret && (c.auth_kind === 'oauth'), server_name: c.server_name,
    last_error: c.last_error, last_checked_at: c.last_checked_at, created_at: c.created_at,
    tools: parseJson<CachedTool[]>(c.tools, []).map((t) => ({
      key: t.key, name: t.name, title: t.title, description: t.description.replace(/^\[Connected app “[^”]*”\] /, ''), risk: t.risk,
      mode: modes[t.key] ?? (t.risk === 'read' ? 'auto' : 'ask'),
    })),
  };
}

export function listConnectors(db: Db, userId: string) {
  return db.all('SELECT * FROM connectors WHERE user_id = ? ORDER BY created_at', userId).map((c) => presentConnector(db, userId, c));
}

/** Connects once to check the address and token and to read the tool list, then saves it. */
export async function addConnector(services: Services, userId: string, raw: unknown) {
  const i = addInput.parse(raw);
  const { db } = services;
  if (Number(db.get('SELECT COUNT(*) AS n FROM connectors WHERE user_id = ?', userId)!.n) >= MAX_CONNECTORS) {
    throw badRequest(`You can connect up to ${MAX_CONNECTORS} apps. Remove one first.`);
  }
  const url = await checkConnectorUrl(i.url, services.config.MCP_ALLOW_PRIVATE_NETWORK === 'true').catch((e) => { throw badRequest(e.message); });
  const header = authHeader(i.token);
  const client = new McpClient(url.href, header ? { authorization: header } : {}, services.mcpFetch);
  let info: Awaited<ReturnType<McpClient['initialize']>>;
  let tools: McpTool[];
  try {
    info = await client.initialize();
    tools = await client.listTools();
  } catch (e: any) {
    if (e instanceof McpError && /refused the access token/.test(e.message) && !i.token) {
      throw new HttpError(400, 'This app asks you to sign in. Use “Sign in with the app”, or paste an access token.', 'needs_sign_in');
    }
    throw badRequest(e instanceof McpError ? e.message : 'Could not connect to that app.');
  }
  return saveConnector(services, userId, i.name, url.href, i.token ? i.token : null, 'token', info, tools);
}

function saveConnector(services: Services, userId: string, name: string, url: string, secret: string | null, kind: 'token' | 'oauth', info: any, tools: McpTool[]) {
  const { db } = services;
  const slug = uniqueSlug(db, userId, name);
  const row = db.insert('connectors', {
    user_id: userId, name, slug, url,
    auth_secret: secret ? encryptSecret(services.config.DATA_DIR, secret) : null, auth_kind: secret ? kind : null,
    tools: JSON.stringify(cacheTools(slug, name, tools)), server_name: info?.serverInfo?.name?.slice(0, 120) ?? null,
    last_checked_at: nowIso(),
  });
  return presentConnector(db, userId, row);
}

/** Completes "sign in with the app": connects with the new tokens and saves the connector. */
export async function addOAuthConnector(services: Services, userId: string, name: string, url: string, tokens: OAuthTokens) {
  const { db } = services;
  if (Number(db.get('SELECT COUNT(*) AS n FROM connectors WHERE user_id = ?', userId)!.n) >= MAX_CONNECTORS) throw badRequest(`You can connect up to ${MAX_CONNECTORS} apps. Remove one first.`);
  const client = new McpClient(url, { authorization: `Bearer ${tokens.access_token}` }, services.mcpFetch);
  const info = await client.initialize();
  const tools = await client.listTools();
  const existing = db.get('SELECT id FROM connectors WHERE user_id = ? AND url = ?', userId, url);
  if (existing) {
    // Signing in again replaces the tokens of the same app.
    db.run("UPDATE connectors SET auth_secret = ?, auth_kind = 'oauth', last_error = NULL, updated_at = ? WHERE id = ?", encryptSecret(services.config.DATA_DIR, JSON.stringify(tokens)), nowIso(), existing.id);
    return refreshConnector(services, userId, existing.id);
  }
  return saveConnector(services, userId, name, url, JSON.stringify(tokens), 'oauth', info, tools);
}

export async function refreshConnector(services: Services, userId: string, id: string) {
  const { db } = services;
  const c = db.getOwned('connectors', userId, id);
  if (!c) throw new HttpError(404, 'Connector not found', 'not_found');
  try {
    await checkConnectorUrl(c.url, services.config.MCP_ALLOW_PRIVATE_NETWORK === 'true');
    const tools = await (await clientFor(services, c)).listTools();
    db.run('UPDATE connectors SET tools = ?, last_error = NULL, last_checked_at = ?, updated_at = ? WHERE id = ?', JSON.stringify(cacheTools(c.slug, c.name, tools)), nowIso(), nowIso(), c.id);
  } catch (e: any) {
    const msg = e instanceof McpError ? e.message : 'Could not reach the connected app.';
    db.run('UPDATE connectors SET last_error = ?, last_checked_at = ? WHERE id = ?', msg, nowIso(), c.id);
  }
  return presentConnector(db, userId, db.getOwned('connectors', userId, id)!);
}

export function updateConnector(services: Services, userId: string, id: string, raw: unknown) {
  const i = updateInput.parse(raw);
  const { db } = services;
  const c = db.getOwned('connectors', userId, id);
  if (!c) throw new HttpError(404, 'Connector not found', 'not_found');
  const tools = parseJson<CachedTool[]>(c.tools, []);
  if (i.tool_modes) {
    const known = new Map(tools.map((t) => [t.key, t]));
    const patch: Record<string, 'auto' | 'ask' | 'off'> = {};
    for (const [key, mode] of Object.entries(i.tool_modes)) {
      const t = known.get(key);
      if (!t) throw badRequest(`Unknown tool ${key}.`);
      // A tool the app marks as destructive always asks first.
      patch[key] = mode === 'auto' && t.risk === 'consequential' ? 'ask' : mode;
    }
    updateSettings(db, userId, { permissions: { tools: patch } });
  }
  db.updateOwned('connectors', userId, id, {
    name: i.name, enabled: i.enabled === undefined ? undefined : i.enabled ? 1 : 0,
    auth_secret: i.token === undefined ? undefined : i.token ? encryptSecret(services.config.DATA_DIR, i.token) : null,
    auth_kind: i.token === undefined ? undefined : i.token ? 'token' : null,
  });
  if (i.token === null) db.run('UPDATE connectors SET auth_secret = NULL WHERE id = ?', id);
  return presentConnector(db, userId, db.getOwned('connectors', userId, id)!);
}

export function deleteConnector(db: Db, userId: string, id: string) {
  const c = db.getOwned('connectors', userId, id);
  if (!c) throw new HttpError(404, 'Connector not found', 'not_found');
  db.deleteOwned('connectors', userId, id);
  // Drop its per-tool settings so they don't linger in the user's permissions.
  const s = getSettings(db, userId);
  const keys = new Set(parseJson<CachedTool[]>(c.tools, []).map((t) => t.key));
  const tools = Object.fromEntries(Object.entries(s.permissions.tools).filter(([k]) => !keys.has(k)));
  db.run('UPDATE settings SET data = ?, updated_at = ? WHERE user_id = ?', JSON.stringify({ ...s, permissions: { ...s.permissions, tools } }), nowIso(), userId);
  return { deleted: true, name: c.name };
}

/** Tool specs for the model from the user's enabled connectors, minus tools switched off. */
export function connectorToolSpecs(db: Db, userId: string): ToolSpec[] {
  const modes = getSettings(db, userId).permissions.tools;
  const out: ToolSpec[] = [];
  for (const c of db.all('SELECT tools FROM connectors WHERE user_id = ? AND enabled = 1 ORDER BY created_at', userId)) {
    for (const t of parseJson<CachedTool[]>(c.tools, [])) {
      if (modes[t.key] === 'off') continue;
      out.push({ name: t.key, description: `${t.description}${t.risk !== 'read' && modes[t.key] !== 'auto' ? ' (Queued for the user to approve — not executed immediately.)' : ''}`, input_schema: t.input_schema });
    }
  }
  return out;
}

/** Finds a connector tool by the name the model used. */
export function findConnectorTool(db: Db, userId: string, key: string): { connector: Row; tool: CachedTool } | null {
  if (!key.startsWith(TOOL_PREFIX)) return null;
  for (const c of db.all('SELECT * FROM connectors WHERE user_id = ? AND enabled = 1', userId)) {
    const tool = parseJson<CachedTool[]>(c.tools, []).find((t) => t.key === key);
    if (tool) return { connector: c, tool };
  }
  return null;
}

export async function callConnectorTool(services: Services, connector: Row, tool: CachedTool, args: Record<string, unknown>) {
  await checkConnectorUrl(connector.url, services.config.MCP_ALLOW_PRIVATE_NETWORK === 'true');
  const r = await (await clientFor(services, connector)).callTool(tool.name, args);
  const text = resultText(r);
  if (r?.isError) throw new McpError(`${connector.name} reported a problem: ${text.slice(0, 600) || 'no details'}`);
  return { app: connector.name, tool: tool.name, untrusted_content: true, result: text || '(no content)' };
}
