import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * A minimal client for remote MCP (Model Context Protocol) servers over the Streamable HTTP
 * transport: JSON-RPC requests POSTed to one URL, answered with JSON or a short SSE stream.
 * It only lists and calls tools. Everything a server returns — tool names, descriptions and
 * results — is third-party content and is treated as untrusted.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'Carino', version: '2.2.0' };

export class McpError extends Error {}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

type Fetch = typeof fetch;

/** Loopback, private, link-local, CGNAT and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
  }
  return true;
}

/**
 * Checks a connector address before Carino's server connects to it. Public servers must use
 * HTTPS. Addresses on the server's own network are refused unless the owner allowed them,
 * so a connector can't be used to probe machines behind the server.
 */
export async function checkConnectorUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new McpError('That is not a valid web address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new McpError('The address must start with https://');
  if (url.username || url.password) throw new McpError('Put access tokens in the token field, not in the address.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    throw new McpError(`Could not find the server ${host}. Check the address.`);
  }
  const isPrivate = addresses.some(isPrivateAddress);
  if (isPrivate && !allowPrivate) {
    throw new McpError('That address is on a private network. To allow connectors on your own network, set MCP_ALLOW_PRIVATE_NETWORK=true on the server.');
  }
  if (url.protocol === 'http:' && !isPrivate) throw new McpError('Use an https:// address for connectors on the internet.');
  return url;
}

export class McpClient {
  private session: string | null = null;
  private nextId = 1;
  private initialized = false;
  private url: string;
  private headers: Record<string, string>;
  private fetchImpl: Fetch;

  constructor(url: string, headers: Record<string, string> = {}, fetchImpl: Fetch = fetch) {
    this.url = url;
    this.headers = headers;
    this.fetchImpl = fetchImpl;
  }

  private async post(body: unknown, timeoutMs: number) {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        redirect: 'manual', // a redirect could point anywhere, including the server's own network
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.initialized ? { 'mcp-protocol-version': MCP_PROTOCOL_VERSION } : {}),
          ...(this.session ? { 'mcp-session-id': this.session } : {}),
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: any) {
      if (err?.name === 'TimeoutError') throw new McpError('The connected app took too long to answer.');
      throw new McpError('Could not reach the connected app. Check the address and that the server is online.');
    }
    if (res.status >= 300 && res.status < 400) throw new McpError('The connected app tried to redirect Carino elsewhere, which isn’t allowed. Use the final address.');
    if (res.status === 401 || res.status === 403) throw new McpError('The connected app refused the access token. Check or replace it.');
    if (res.status === 404 || res.status === 405) throw new McpError('No MCP server answered at that address. Check you used its “Streamable HTTP” address (often ending in /mcp).');
    return res;
  }

  private async request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs);
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (!res.ok) throw new McpError(`The connected app returned an error (${res.status}).`);
    const type = res.headers.get('content-type') ?? '';
    const text = (await res.text()).slice(0, 5_000_000);
    const messages: any[] = [];
    if (type.includes('text/event-stream')) {
      for (const event of text.split(/\r?\n\r?\n/)) {
        const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        try {
          messages.push(JSON.parse(data));
        } catch {}
      }
    } else {
      try {
        const parsed = JSON.parse(text);
        messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch {
        throw new McpError('The connected app sent a reply Carino could not read.');
      }
    }
    const reply = messages.find((m) => m && m.id === id);
    if (!reply) throw new McpError('The connected app did not answer the request.');
    if (reply.error) throw new McpError(`The connected app reported an error: ${String(reply.error.message ?? 'unknown').slice(0, 300)}`);
    return reply.result;
  }

  async initialize() {
    if (this.initialized) return;
    const result = await this.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
    this.initialized = true;
    // A notification has no reply; servers answer 202. Failures here don't matter.
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, 10_000).then((r) => r.body?.cancel()).catch(() => undefined);
    return result as { serverInfo?: { name?: string; version?: string }; instructions?: string };
  }

  async listTools(maxPages = 5): Promise<McpTool[]> {
    await this.initialize();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(Array.isArray(r?.tools) ? r.tools : []));
      cursor = typeof r?.nextCursor === 'string' ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools.filter((t) => t && typeof t.name === 'string');
  }

  async callTool(name: string, args: Record<string, unknown>) {
    await this.initialize();
    return this.request('tools/call', { name, arguments: args }, 90_000) as Promise<{ content?: any[]; structuredContent?: unknown; isError?: boolean }>;
  }
}

/** Flattens a tool result into text the model can read; images and binary data are only noted. */
export function resultText(r: { content?: any[]; structuredContent?: unknown } | null | undefined, max = 20_000) {
  const parts: string[] = [];
  for (const c of r?.content ?? []) {
    if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c?.type === 'resource' && typeof c.resource?.text === 'string') parts.push(c.resource.text);
    else if (c?.type === 'resource_link') parts.push(`[Link: ${c.name ?? ''} ${c.uri ?? ''}]`);
    else if (c?.type) parts.push(`[${c.type} content not shown]`);
  }
  if (!parts.length && r?.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  const out = parts.join('\n\n');
  return out.length > max ? `${out.slice(0, max)}\n[… truncated]` : out;
}
