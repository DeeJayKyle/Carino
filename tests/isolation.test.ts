import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, type TestCtx } from './helpers.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

describe('data isolation between users', () => {
  it('one user cannot read, change or delete another user’s records', async () => {
    const alice = await signup(ctx, 'Alice');
    const bob = await signup(ctx, 'Bob');

    const task = (await alice.post('/api/tasks', { title: 'Alice private task' })).data;
    const mem = (await alice.post('/api/memories', { content: 'Alice likes tea', category: 'preference' })).data.memory;
    const conv = (await alice.post('/api/conversations', {})).data;
    const form = new FormData();
    form.append('file', new File(['zebra document content'], 'a.txt', { type: 'text/plain' }));
    const doc = (await alice.req('POST', '/api/documents', form)).data.document;

    const attempts: [string, string, unknown?][] = [
      ['GET', `/api/tasks/${task.id}`],
      ['PATCH', `/api/tasks/${task.id}`, { title: 'hacked' }],
      ['POST', `/api/tasks/${task.id}/complete`],
      ['DELETE', `/api/tasks/${task.id}`],
      ['PATCH', `/api/memories/${mem.id}`, { content: 'hacked' }],
      ['DELETE', `/api/memories/${mem.id}`],
      ['GET', `/api/conversations/${conv.id}`],
      ['DELETE', `/api/conversations/${conv.id}`],
      ['GET', `/api/documents/${doc.id}`],
      ['GET', `/api/documents/${doc.id}/download`],
      ['DELETE', `/api/documents/${doc.id}`],
    ];
    for (const [m, p, b] of attempts) {
      const r = await bob.req(m, p, b);
      expect(r.status, `${m} ${p}`).toBe(404);
    }

    // Lists and search show nothing of Alice's.
    expect((await bob.get('/api/tasks?view=all')).data.tasks).toHaveLength(0);
    expect((await bob.get('/api/memories')).data.memories).toHaveLength(0);
    expect((await bob.get('/api/search?q=zebra')).data.results).toHaveLength(0);
    expect((await alice.get('/api/search?q=zebra')).data.results.length).toBeGreaterThan(0);

    // Alice's data is untouched.
    expect((await alice.get(`/api/tasks/${task.id}`)).data.title).toBe('Alice private task');
    expect((await alice.get(`/api/memories`)).data.memories[0].content).toBe('Alice likes tea');
  });

  it('a data export only contains the requesting user’s data', async () => {
    const alice = await signup(ctx, 'Alice');
    const bob = await signup(ctx, 'Bob');
    await alice.post('/api/tasks', { title: 'Alice only' });
    await bob.post('/api/tasks', { title: 'Bob only' });
    const exp = await bob.get('/api/export');
    const s = JSON.stringify(exp.data);
    expect(s).toContain('Bob only');
    expect(s).not.toContain('Alice only');
    expect(s).not.toMatch(/password_hash/);
  });
});
