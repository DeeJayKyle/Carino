import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, type TestCtx } from './helpers.ts';
import { executeTool, makeContext } from '../server/tools/registry.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

const TODOIST_KEY = 'a'.repeat(40);

describe('work and life apps', () => {
  it('connects Todoist with a pasted token, checks it, and never shows it back', async () => {
    const c = await signup(ctx);
    const seen: string[] = [];
    ctx.services.netFetch = (async (url: string, init: any) => {
      seen.push(`${init?.method ?? 'GET'} ${url} ${init?.headers?.authorization ?? ''}`);
      if (url.endsWith('/api/v1/user')) return new Response(JSON.stringify({ id: '7', email: 'me@example.com' }));
      if (url.includes('/api/v1/tasks/filter')) return new Response(JSON.stringify({ results: [{ id: 'T1', content: 'Pay rent', due: { string: 'today' }, priority: 4 }] }));
      if (url.endsWith('/api/v1/tasks')) return new Response(JSON.stringify({ id: 'T2', due: { string: 'tomorrow' } }));
      return new Response('{}', { status: 404 });
    }) as any;
    expect((await c.post('/api/apps/todoist/key', { token: 'nope' })).status).toBe(400);
    const r = await c.post('/api/apps/todoist/key', { token: TODOIST_KEY });
    expect(r.data.account.label).toBe('me@example.com');
    const list = (await c.get('/api/apps')).data.apps.find((a: any) => a.id === 'todoist');
    expect(list.key.url).toContain('todoist.com');
    expect(JSON.stringify(list)).not.toContain(TODOIST_KEY);

    const tasks: any = await executeTool('todoist_tasks', { filter: 'today' }, makeContext(ctx.services, c.user.id, null));
    expect(tasks.status).toBe('executed');
    expect(JSON.stringify(tasks.result)).toContain('Pay rent');
    expect(seen.some((s) => s.includes(`Bearer ${TODOIST_KEY}`))).toBe(true);
    // Adding asks first by default.
    const add: any = await executeTool('todoist_add_task', { content: 'Call mum', due: 'tomorrow' }, makeContext(ctx.services, c.user.id, null));
    expect(add.status).toBe('pending_approval');
  });

  it('sends Linear keys without "Bearer" and reports GraphQL errors plainly', async () => {
    const c = await signup(ctx);
    const auths: string[] = [];
    ctx.services.netFetch = (async (_url: string, init: any) => {
      auths.push(init.headers.authorization);
      const q = JSON.parse(init.body).query as string;
      if (q.includes('viewer { id email name }')) return new Response(JSON.stringify({ data: { viewer: { id: 'u1', email: 'dev@example.com' } } }));
      return new Response(JSON.stringify({ errors: [{ message: 'Rate limited' }] }));
    }) as any;
    const key = `lin_api_${'b'.repeat(30)}`;
    expect((await c.post('/api/apps/linear/key', { token: key })).status).toBe(200);
    const r: any = await executeTool('linear_my_issues', {}, makeContext(ctx.services, c.user.id, null));
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/Rate limited/);
    expect(auths.every((a) => a === key)).toBe(true);
  });

  it('turns Slack’s ok:false replies into readable errors', async () => {
    const c = await signup(ctx);
    ctx.services.netFetch = (async (url: string) => {
      if (url.includes('auth.test')) return new Response(JSON.stringify({ ok: true, team_id: 'T', user_id: 'U', user: 'me', team: 'Home' }));
      return new Response(JSON.stringify({ ok: false, error: 'missing_scope', needed: 'search:read' }));
    }) as any;
    expect((await c.post('/api/apps/slack/key', { token: `xoxp-${'1'.repeat(30)}` })).data.account.label).toBe('me @ Home');
    const r: any = await executeTool('slack_search', { query: 'budget' }, makeContext(ctx.services, c.user.id, null));
    expect(r.error).toMatch(/search:read/);
  });

  it('keeps the new tools out until the app is connected', async () => {
    const c = await signup(ctx);
    const r: any = await executeTool('github_inbox', {}, makeContext(ctx.services, c.user.id, null));
    expect(r.status).toBe('error');
  });
});
