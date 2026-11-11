import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../server/db/index.ts';
import { loadConfig } from '../server/config.ts';
import { ProviderRegistry } from '../server/ai/providers.ts';
import type { AIProvider, ChatRequest, ChatResult, ProviderInfo } from '../server/ai/types.ts';
import { createSearchService, type SearchResult, type SearchService } from '../server/services/search.ts';
import { createPushService } from '../server/services/push.ts';
import { createApp } from '../server/app.ts';
import type { Services } from '../server/context.ts';

/** A scripted AI provider: each call pops the next step and records the request it saw. */
export class FakeProvider implements AIProvider {
  calls: ChatRequest[] = [];
  steps: ((req: ChatRequest) => ChatResult | Promise<ChatResult>)[] = [];
  configured = true;
  tools = true;
  vision = false;
  toolset: 'core' | 'full' | 'phone' | undefined;

  info(): ProviderInfo {
    return {
      id: 'fake', label: 'Fake model', model: 'fake-1', configured: this.configured,
      capabilities: { tools: this.tools, streaming: true, local: this.toolset === 'phone', vision: this.vision, ...(this.toolset ? { toolset: this.toolset } : {}) }, pricing: { input: 1, output: 2 },
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    this.calls.push(structuredClone({ ...req, signal: undefined, onText: undefined }));
    const step = this.steps.shift();
    if (!step) return text('(no scripted reply)');
    const res = await step(req);
    for (const b of res.content) if (b.type === 'text') req.onText?.((b as any).text);
    return res;
  }
}

export const text = (t: string): ChatResult => ({ content: [{ type: 'text', text: t }], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 }, model: 'fake-1' });
export const toolCall = (name: string, input: unknown, id = `tu_${Math.random().toString(36).slice(2, 8)}`, preface = ''): ChatResult => ({
  content: [...(preface ? [{ type: 'text', text: preface }] : []), { type: 'tool_use', id, name, input }] as any,
  stopReason: 'tool_use', usage: { inputTokens: 120, outputTokens: 30 }, model: 'fake-1',
});

export interface TestCtx {
  services: Services;
  app: ReturnType<typeof createApp>;
  provider: FakeProvider;
  clock: { now: Date };
  pushed: { endpoint: string; body: any }[];
  pushFail: { status?: number } ;
  searchResults: SearchResult[];
  dataDir: string;
  cleanup: () => void;
}

export function setup(opts: { env?: Record<string, string>; search?: boolean; push?: boolean } = {}): TestCtx {
  const dataDir = mkdtempSync(join(tmpdir(), 'carino-test-'));
  const config = loadConfig({
    NODE_ENV: 'test', DATA_DIR: dataDir, PUBLIC_URL: 'http://localhost', MAX_USERS: '10', DAILY_TOKEN_LIMIT: '1000000',
    ...(opts.push !== false ? { VAPID_PUBLIC_KEY: 'BAg8Tq0SsKkDxw2ib6nA0KXkJ7wNaG1nWj0fZ8Y8kRm7oJ2_jyp2qkS4cP1Qf8z0bQ1y8k8vXl2m6Qe8gOq0Kg0', VAPID_PRIVATE_KEY: 'x'.repeat(43) } : {}),
    ...opts.env,
  });
  const db = new Db(':memory:');
  const provider = new FakeProvider();
  const providers = new ProviderRegistry();
  providers.register('fake', provider);
  const clock = { now: new Date('2026-10-16T08:00:00Z') };
  const pushed: TestCtx['pushed'] = [];
  const pushFail: TestCtx['pushFail'] = {};
  const searchResults: SearchResult[] = [];
  const search: SearchService = opts.search
    ? {
        available: () => ({ configured: true, provider: 'FakeSearch' }),
        search: async () => searchResults,
      }
    : createSearchService({});
  const push = createPushService(db, { publicKey: config.VAPID_PUBLIC_KEY, privateKey: undefined, subject: 'mailto:test@example.com' }, async (sub, body) => {
    if (pushFail.status) throw Object.assign(new Error('push failed'), { statusCode: pushFail.status });
    pushed.push({ endpoint: sub.endpoint, body: JSON.parse(body) });
  });
  const services: Services = { db, config, providers, search, push, now: () => clock.now };
  const app = createApp(services);
  return {
    services, app, provider, clock, pushed, pushFail, searchResults, dataDir,
    cleanup: () => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/** A tiny cookie-keeping client around app.request. */
export class Client {
  cookie = '';
  private app: TestCtx['app'];
  constructor(app: TestCtx['app']) {
    this.app = app;
  }

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { 'x-carino': '1', ...headers };
    if (this.cookie) h.cookie = this.cookie;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await this.app.request(`http://localhost${path}`, { method, headers: h, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = set.match(/carino_session=([^;]*)/);
      if (m) this.cookie = m[1] ? `carino_session=${m[1]}` : '';
    }
    const type = res.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await res.json() : type.includes('event-stream') ? await res.text() : await res.arrayBuffer();
    return { status: res.status, data: data as any, headers: res.headers };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
  put = (p: string, b: unknown) => this.req('PUT', p, b);
  del = (p: string) => this.req('DELETE', p);
}

let n = 0;
export async function signup(ctx: TestCtx, name = 'Herbert') {
  const c = new Client(ctx.app);
  const email = `user${++n}@example.com`;
  const r = await c.post('/api/auth/signup', { name, email, password: 'correct horse battery', timeZone: 'Africa/Kampala' });
  if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.data)}`);
  return Object.assign(c, { user: r.data.user, email });
}

/** Parses an SSE body into [{event, data}]. */
export function parseSSE(body: string) {
  return body.split('\n\n').filter(Boolean).map((block) => {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    return { event, data: data ? JSON.parse(data) : null };
  });
}
