import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, type TestCtx } from './helpers.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

describe('offline replay', () => {
  it('runs a queued create once even if it is submitted twice', async () => {
    const c = await signup(ctx);
    const op = { 'x-op-id': 'op-create-0001' };
    const first = await c.req('POST', '/api/tasks', { title: 'Offline task' }, op);
    const again = await c.req('POST', '/api/tasks', { title: 'Offline task' }, op);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get('x-op-replayed')).toBe('1');
    expect(again.data.id).toBe(first.data.id);
    expect((await c.get('/api/tasks?view=all')).data.tasks).toHaveLength(1);
  });

  it('keeps op ids per user, so one user cannot read another’s replay', async () => {
    const a = await signup(ctx, 'Ann');
    const b = await signup(ctx, 'Ben');
    await a.req('POST', '/api/tasks', { title: 'Ann private' }, { 'x-op-id': 'shared-op-001' });
    const r = await b.req('POST', '/api/tasks', { title: 'Ben task' }, { 'x-op-id': 'shared-op-001' });
    expect(r.data.title).toBe('Ben task');
  });

  it('applies an edit made against the current version', async () => {
    const c = await signup(ctx);
    const t = (await c.post('/api/tasks', { title: 'Draft' })).data;
    const r = await c.req('PATCH', `/api/tasks/${t.id}`, { title: 'Final' }, { 'x-op-id': 'op-edit-0001', 'x-base-version': t.updated_at });
    expect(r.status).toBe(200);
    expect(r.data.title).toBe('Final');
  });

  it('reports a conflict when the record changed after the offline edit', async () => {
    const c = await signup(ctx);
    const t = (await c.post('/api/tasks', { title: 'Plan', description: 'v1' })).data;
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 1000);
    await c.patch(`/api/tasks/${t.id}`, { description: 'changed on laptop' });
    const r = await c.req('PATCH', `/api/tasks/${t.id}`, { description: 'changed offline on phone' }, { 'x-op-id': 'op-edit-0002', 'x-base-version': t.updated_at });
    expect(r.status).toBe(409);
    expect(r.data.code).toBe('version_conflict');
    expect(r.data.current.description).toBe('changed on laptop');
    expect((await c.get(`/api/tasks/${t.id}`)).data.description).toBe('changed on laptop');
  });

  it('does not record failed writes, so they can be retried, and still validates input', async () => {
    const c = await signup(ctx);
    const op = { 'x-op-id': 'op-bad-00001' };
    expect((await c.req('POST', '/api/tasks', { title: '' }, op)).status).toBe(400);
    expect((await c.req('POST', '/api/tasks', { title: 'Fixed' }, op)).status).toBe(201);
  });

  it('still requires the CSRF header and a session', async () => {
    const c = await signup(ctx);
    const r = await c.req('POST', '/api/tasks', { title: 'x' }, { 'x-op-id': 'op-csrf-0001', 'x-carino': '0' });
    expect(r.status).toBe(403);
    c.cookie = '';
    expect((await c.req('POST', '/api/tasks', { title: 'x' }, { 'x-op-id': 'op-anon-0001' })).status).toBe(401);
  });
});
