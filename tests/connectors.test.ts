import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { setup, signup, text, toolCall, type TestCtx } from './helpers.ts';
import { isPrivateAddress, checkConnectorUrl, resultText } from '../server/services/mcp.ts';
import { encryptSecret, decryptSecret } from '../server/services/secrets.ts';

/** A small Streamable-HTTP MCP server with one read-only tool and two that change things. */
function fakeMcp(opts: { sse?: boolean; token?: string } = {}) {
  const seen: { method: string; auth?: string; session?: string; body: any }[] = [];
  const server: Server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ method: body.method, auth: req.headers.authorization, session: req.headers['mcp-session-id'] as string, body });
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
      res.writeHead(401).end();
      return;
    }
    if (!('id' in body)) {
      res.writeHead(202).end();
      return;
    }
    let result: any;
    if (body.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Fake Mail', version: '1' } };
    else if (body.method === 'tools/list') {
      result = { tools: [
        { name: 'search_email', description: 'Search the inbox', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } },
        { name: 'send_email', description: 'Send an email', inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } } } },
        { name: 'delete_email', description: 'Delete an email', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { destructiveHint: true } },
      ] };
    } else if (body.method === 'tools/call') {
      const { name, arguments: args } = body.params;
      if (name === 'search_email') result = { content: [{ type: 'text', text: `2 emails match "${args.query}": Invoice from Supplier Ltd; Lunch on Friday` }] };
      else if (name === 'send_email') result = { content: [{ type: 'text', text: `Sent to ${args.to}` }] };
      else result = { content: [{ type: 'text', text: 'No such message' }], isError: true };
    } else {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }));
      return;
    }
    const msg = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    const headers: Record<string, string> = { 'mcp-session-id': 'sess-1' };
    if (opts.sse) res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${msg}\n\n`);
    else res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(msg);
  });
  return new Promise<{ url: string; seen: typeof seen; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, seen, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

let ctx: TestCtx;
let mcp: Awaited<ReturnType<typeof fakeMcp>>;
beforeEach(async () => {
  ctx = setup({ env: { MCP_ALLOW_PRIVATE_NETWORK: 'true' } });
  mcp = await fakeMcp({ token: 'secret-token' });
});
afterEach(async () => {
  await mcp.close();
  ctx.cleanup();
});

async function connect(c: Awaited<ReturnType<typeof signup>>) {
  const r = await c.post('/api/connectors', { name: 'Work Mail', url: mcp.url, token: 'secret-token' });
  expect(r.status).toBe(201);
  return r.data;
}

async function chat(c: Awaited<ReturnType<typeof signup>>, message: string) {
  const conv = (await c.post('/api/conversations', {})).data;
  await c.post(`/api/conversations/${conv.id}/messages`, { text: message });
  return conv.id as string;
}

describe('connected apps (MCP)', () => {
  it('connects, reads the tool list and never returns the token', async () => {
    const c = await signup(ctx);
    const conn = await connect(c);
    expect(conn).toMatchObject({ name: 'Work Mail', server_name: 'Fake Mail', has_token: true, enabled: true });
    expect(conn.tools.map((t: any) => [t.key, t.risk, t.mode])).toEqual([
      ['mcp_workmail_search_email', 'read', 'auto'],
      ['mcp_workmail_send_email', 'reversible', 'ask'],
      ['mcp_workmail_delete_email', 'consequential', 'ask'],
    ]);
    expect(JSON.stringify((await c.get('/api/connectors')).data)).not.toContain('secret-token');
    const stored = ctx.services.db.get('SELECT auth_secret FROM connectors')!.auth_secret;
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain('secret-token');
    // The handshake follows the protocol: initialize, initialized, then tools/list with the session.
    expect(mcp.seen.map((s) => s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(mcp.seen[2].session).toBe('sess-1');
    expect(mcp.seen[0].auth).toBe('Bearer secret-token');
  });

  it('refuses a wrong token or an address that is not an MCP server', async () => {
    const c = await signup(ctx);
    const bad = await c.post('/api/connectors', { name: 'Mail', url: mcp.url, token: 'wrong' });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/refused the access token/);
    const none = await c.post('/api/connectors', { name: 'Mail', url: 'http://127.0.0.1:9/mcp' });
    expect(none.status).toBe(400);
    expect((await c.get('/api/connectors')).data.connectors).toHaveLength(0);
  });

  it('lets Carino use read-only tools straight away', async () => {
    const c = await signup(ctx);
    await connect(c);
    ctx.provider.steps.push((req) => {
      expect(req.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['mcp_workmail_search_email', 'mcp_workmail_send_email']));
      return toolCall('mcp_workmail_search_email', { query: 'invoice' });
    });
    ctx.provider.steps.push(() => text('You have an invoice from Supplier Ltd.'));
    await chat(c, 'Any invoices in my email?');
    const result = JSON.stringify(ctx.provider.calls[1].messages.at(-1));
    expect(result).toContain('Invoice from Supplier Ltd');
    expect(result).toContain('untrusted_content');
    expect(mcp.seen.find((s) => s.method === 'tools/call')!.body.params).toEqual({ name: 'search_email', arguments: { query: 'invoice' } });
  });

  it('queues anything that changes data until the user approves it', async () => {
    const c = await signup(ctx);
    await connect(c);
    ctx.provider.steps.push(() => toolCall('mcp_workmail_send_email', { to: 'supplier@example.com', body: 'Paid, thanks' }));
    ctx.provider.steps.push(() => text('It is waiting for your approval.'));
    await chat(c, 'Email the supplier that we paid');
    expect(mcp.seen.some((s) => s.method === 'tools/call')).toBe(false);
    const pending = (await c.get('/api/actions?status=pending')).data.actions;
    expect(pending).toHaveLength(1);
    expect(pending[0].summary).toContain('Work Mail: send_email');
    const ok = await c.post(`/api/actions/${pending[0].id}/approve`);
    expect(ok.data.status).toBe('executed');
    expect(ok.data.result.result).toBe('Sent to supplier@example.com');
  });

  it('honours per-tool choices, but destructive tools always ask', async () => {
    const c = await signup(ctx);
    const conn = await connect(c);
    const r = await c.patch(`/api/connectors/${conn.id}`, { tool_modes: { mcp_workmail_send_email: 'auto', mcp_workmail_delete_email: 'auto', mcp_workmail_search_email: 'off' } });
    const modes = Object.fromEntries(r.data.tools.map((t: any) => [t.name, t.mode]));
    expect(modes).toEqual({ search_email: 'off', send_email: 'auto', delete_email: 'ask' });
    ctx.provider.steps.push((req) => {
      expect(req.tools.some((t) => t.name === 'mcp_workmail_search_email')).toBe(false);
      return toolCall('mcp_workmail_send_email', { to: 'a@b.c', body: 'hi' });
    });
    ctx.provider.steps.push(() => toolCall('mcp_workmail_delete_email', { id: '42' }));
    ctx.provider.steps.push(() => text('done'));
    await chat(c, 'send then delete');
    const calls = mcp.seen.filter((s) => s.method === 'tools/call').map((s) => s.body.params.name);
    expect(calls).toEqual(['send_email']);
    expect((await c.get('/api/actions?status=pending')).data.actions[0].tool).toBe('mcp_workmail_delete_email');
  });

  it('reports app errors to the model, and switched-off apps disappear', async () => {
    const c = await signup(ctx);
    const conn = await connect(c);
    await c.patch(`/api/connectors/${conn.id}`, { tool_modes: { mcp_workmail_delete_email: 'ask' } });
    ctx.provider.steps.push(() => toolCall('mcp_workmail_delete_email', { id: 'x' }));
    ctx.provider.steps.push(() => text('ok'));
    await chat(c, 'delete x');
    const action = (await c.get('/api/actions?status=pending')).data.actions[0];
    const failed = await c.post(`/api/actions/${action.id}/approve`);
    expect(failed.data.status).toBe('error');
    expect(failed.data.error).toContain('Work Mail reported a problem: No such message');

    await c.patch(`/api/connectors/${conn.id}`, { enabled: false });
    ctx.provider.steps.push((req) => {
      expect(req.tools.some((t) => t.name.startsWith('mcp_'))).toBe(false);
      return toolCall('mcp_workmail_search_email', { query: 'x' });
    });
    ctx.provider.steps.push(() => text('ok'));
    await chat(c, 'search');
    expect(JSON.stringify(ctx.provider.calls.at(-1)!.messages.at(-1))).toContain('switched off or was removed');
  });

  it('works with servers that answer as an event stream, and refreshes the tool list', async () => {
    const sse = await fakeMcp({ sse: true });
    try {
      const c = await signup(ctx);
      const conn = (await c.post('/api/connectors', { name: 'Notes', url: sse.url })).data;
      expect(conn.tools).toHaveLength(3);
      expect(conn.has_token).toBe(false);
      const refreshed = (await c.post(`/api/connectors/${conn.id}/refresh`)).data;
      expect(refreshed.last_error).toBeNull();
      await sse.close().catch(() => undefined);
      const down = (await c.post(`/api/connectors/${conn.id}/refresh`)).data;
      expect(down.last_error).toMatch(/Could not reach/);
      expect(down.tools).toHaveLength(3); // the last good list is kept
    } finally {
      await sse.close().catch(() => undefined);
    }
  });

  it('keeps connectors private, and deleting one removes its tool settings', async () => {
    const a = await signup(ctx, 'A');
    const b = await signup(ctx, 'B');
    const conn = await connect(a);
    expect((await b.patch(`/api/connectors/${conn.id}`, { enabled: false })).status).toBe(404);
    expect((await b.del(`/api/connectors/${conn.id}`)).status).toBe(404);
    expect((await b.get('/api/connectors')).data.connectors).toHaveLength(0);
    await a.patch(`/api/connectors/${conn.id}`, { tool_modes: { mcp_workmail_send_email: 'auto' } });
    expect((await a.del(`/api/connectors/${conn.id}`)).status).toBe(200);
    expect((await a.get('/api/settings')).data.permissions.tools).toEqual({});
  });

  it('blocks private-network addresses unless the server allows them', async () => {
    const strict = setup();
    try {
      const c = await signup(strict);
      const r = await c.post('/api/connectors', { name: 'Local', url: mcp.url });
      expect(r.status).toBe(400);
      expect(r.data.error).toMatch(/private network/);
    } finally {
      strict.cleanup();
    }
    await expect(checkConnectorUrl('http://example.com/mcp', false)).rejects.toThrow(/https/);
    await expect(checkConnectorUrl('https://user:pw@example.com/mcp', false)).rejects.toThrow(/token field/);
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.5', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
  });

  it('refuses redirects from a connected app', async () => {
    const redirect = createServer((_req, res) => res.writeHead(307, { location: 'http://169.254.169.254/' }).end());
    await new Promise<void>((r) => redirect.listen(0, '127.0.0.1', () => r()));
    try {
      const c = await signup(ctx);
      const r = await c.post('/api/connectors', { name: 'Sneaky', url: `http://127.0.0.1:${(redirect.address() as any).port}/mcp` });
      expect(r.status).toBe(400);
      expect(r.data.error).toMatch(/redirect/);
    } finally {
      await new Promise((r) => redirect.close(() => r(undefined)));
    }
  });

  it('encrypts secrets so the database alone does not reveal them', () => {
    const enc = encryptSecret(ctx.dataDir, 'tok');
    expect(decryptSecret(ctx.dataDir, enc)).toBe('tok');
    expect(decryptSecret(ctx.dataDir, `${enc.slice(0, -4)}AAAA`)).toBeNull();
    expect(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }] })).toBe('a\n\n[image content not shown]');
  });
});

describe('signing in with the app (MCP OAuth)', () => {
  it('discovers the sign-in server, registers, exchanges the code with PKCE and refreshes tokens', async () => {
    const { createHash } = await import('node:crypto');
    let base = '';
    let challenge = '';
    const valid = new Set<string>();
    const seenTokens: string[] = [];
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const ch of req) raw += ch;
      const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(b));
      const url = new URL(req.url!, base);
      if (url.pathname === '/.well-known/oauth-protected-resource') return json({ resource: `${base}/mcp`, authorization_servers: [base] });
      if (url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, code_challenge_methods_supported: ['S256'] });
      if (url.pathname === '/register') return json({ client_id: 'carino-client' }, 201);
      if (url.pathname === '/token') {
        const p = new URLSearchParams(raw);
        if (p.get('grant_type') === 'authorization_code') {
          const ok = p.get('code') === 'good' && createHash('sha256').update(p.get('code_verifier')!).digest('base64url') === challenge && p.get('client_id') === 'carino-client';
          if (!ok) return json({ error: 'invalid_grant' }, 400);
          valid.add('at1');
          return json({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 });
        }
        if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'rt1') {
          valid.add('at2');
          return json({ access_token: 'at2', expires_in: 3600 });
        }
        return json({ error: 'invalid_grant' }, 400);
      }
      if (url.pathname === '/mcp') {
        const tok = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        if (!valid.has(tok)) return json({}, 401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
        const body = JSON.parse(raw);
        if (!('id' in body)) return res.writeHead(202).end();
        seenTokens.push(tok);
        const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'Notes app' } }
          : body.method === 'tools/list' ? { tools: [{ name: 'search_pages', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
          : { content: [{ type: 'text', text: 'Page: Shop ideas' }] };
        return json({ jsonrpc: '2.0', id: body.id, result });
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      const c = await signup(ctx);
      // Without a token, adding it says sign-in is needed.
      const plain = await c.post('/api/connectors', { name: 'Notes', url: `${base}/mcp` });
      expect(plain.data.code).toBe('needs_sign_in');
      const start = await c.post('/api/connectors/oauth/start', { name: 'Notes', url: `${base}/mcp` });
      expect(start.status).toBe(200);
      const auth = new URL(start.data.authorize_url);
      expect(auth.origin + auth.pathname).toBe(`${base}/authorize`);
      expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
      expect(auth.searchParams.get('redirect_uri')).toBe('http://localhost/api/connectors/oauth/callback');
      expect(auth.searchParams.get('resource')).toBe(`${base}/mcp`);
      challenge = auth.searchParams.get('code_challenge')!;
      const state = auth.searchParams.get('state')!;

      // A wrong state is refused; the right one completes sign-in.
      const bad = await c.get(`/api/connectors/oauth/callback?code=good&state=nope`);
      expect(bad.headers.get('location')).toMatch(/oauth_error=/);
      const done = await c.get(`/api/connectors/oauth/callback?code=good&state=${state}`);
      expect(done.status).toBe(302);
      expect(done.headers.get('location')).toBe('/connectors?connected=Notes');
      const list = (await c.get('/api/connectors')).data.connectors;
      expect(list[0]).toMatchObject({ name: 'Notes', signed_in: true, server_name: 'Notes app' });
      expect(JSON.stringify(list)).not.toContain('at1');
      // The state can't be replayed.
      expect((await c.get(`/api/connectors/oauth/callback?code=good&state=${state}`)).headers.get('location')).toMatch(/expired/);

      // Two hours later the access token has expired: Carino refreshes it before calling the tool.
      ctx.clock.now = new Date(ctx.clock.now.getTime() + 2 * 3600_000);
      ctx.provider.steps.push(() => toolCall('mcp_notes_search_pages', {}));
      ctx.provider.steps.push(() => text('Found it.'));
      await chat(c, 'find my shop ideas page');
      expect(seenTokens.at(-1)).toBe('at2');
      expect(JSON.stringify(ctx.provider.calls[1].messages.at(-1))).toContain('Page: Shop ideas');
    } finally {
      await new Promise((r) => server.close(() => r(undefined)));
    }
  });
});
