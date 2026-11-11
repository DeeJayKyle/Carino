import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, type TestCtx } from './helpers.ts';
import { executeTool, makeContext, approveAction, toolSpecs, TOOLS, CORE_TOOLS } from '../server/tools/registry.ts';
import { sensitivityOf, retrieveMemories, expireMemories } from '../server/services/memory.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

describe('memory', () => {
  it('creates, edits, lists, exports and deletes memories', async () => {
    const c = await signup(ctx);
    const m = (await c.post('/api/memories', { content: 'Prefers briefings at 7am', category: 'preference' })).data.memory;
    expect(m.status).toBe('active');
    await c.patch(`/api/memories/${m.id}`, { content: 'Prefers briefings at 6:30am' });
    const list = (await c.get('/api/memories')).data.memories;
    expect(list[0].content).toBe('Prefers briefings at 6:30am');
    expect((await c.get('/api/export')).data.memories[0].content).toContain('6:30');
    await c.del(`/api/memories/${m.id}`);
    expect((await c.get('/api/memories')).data.memories).toHaveLength(0);
  });

  it('does not store duplicates', async () => {
    const c = await signup(ctx);
    await c.post('/api/memories', { content: 'Runs a pharmacy in Kampala' });
    const r = (await c.post('/api/memories', { content: 'runs a pharmacy in kampala' })).data;
    expect(r.duplicate).toBe(true);
  });

  it('clears selected categories or everything, only with confirmation', async () => {
    const c = await signup(ctx);
    await c.post('/api/memories', { content: 'Goal: open a second branch', category: 'goal' });
    await c.post('/api/memories', { content: 'Likes concise answers', category: 'preference' });
    expect((await c.post('/api/memories/clear', {})).status).toBe(400);
    expect((await c.post('/api/memories/clear', { categories: ['goal'], confirm: true })).data.deleted).toBe(1);
    expect((await c.get('/api/memories')).data.memories).toHaveLength(1);
    await c.post('/api/memories/clear', { confirm: true });
    expect((await c.get('/api/memories')).data.memories).toHaveLength(0);
  });

  it('flags sensitive information', () => {
    expect(sensitivityOf('My bank account number is 0123456789')).toBeTruthy();
    expect(sensitivityOf('I was diagnosed with diabetes')).toBe('health');
    expect(sensitivityOf('My passport expires in May')).toBe('government ID');
    expect(sensitivityOf('I prefer tea to coffee')).toBeNull();
  });

  it('retrieves only approved, relevant memories, plus core preferences', async () => {
    const c = await signup(ctx);
    await c.post('/api/memories', { content: 'Likes concise answers', category: 'preference' });
    await c.post('/api/memories', { content: 'The pharmacy supplier is Quality Chemicals', category: 'fact' });
    await c.post('/api/memories', { content: 'Daughter’s birthday is 3 March', category: 'date' });
    const ctxTool = makeContext(ctx.services, c.user.id, null);
    await executeTool('save_memory', { content: 'Supplier contact prefers WhatsApp', inferred: true }, ctxTool);
    const got = retrieveMemories(ctx.services.db, c.user.id, 'who is our supplier?').map((m) => m.content);
    expect(got).toContain('The pharmacy supplier is Quality Chemicals');
    expect(got).toContain('Likes concise answers');
    expect(got).not.toContain('Supplier contact prefers WhatsApp'); // still proposed
    expect(got).not.toContain('Daughter’s birthday is 3 March');
  });

  it('expires memories after their retention date', async () => {
    const c = await signup(ctx);
    await c.post('/api/memories', { content: 'Temporary: parking spot B4', expires_at: '2026-10-17T00:00:00Z' });
    expect(expireMemories(ctx.services.db, new Date('2026-10-18T00:00:00Z'))).toBe(1);
    expect((await c.get('/api/memories')).data.memories).toHaveLength(0);
  });
});

describe('assistant memory saving policy', () => {
  it('saves explicit non-sensitive facts, holds sensitive or inferred ones for approval', async () => {
    const c = await signup(ctx);
    const t = makeContext(ctx.services, c.user.id, null);
    const a = await executeTool('save_memory', { content: 'Prefers short morning briefings', category: 'preference', user_requested: true }, t);
    expect(a.status === 'executed' && (a.result as any).status).toBe('saved');
    const b = await executeTool('save_memory', { content: 'Takes metformin medication daily', category: 'fact', user_requested: true }, t);
    expect(b.status === 'executed' && (b.result as any).status).toBe('awaiting_user_approval');
    const d = await executeTool('save_memory', { content: 'Seems to work late on Fridays', inferred: true }, t);
    expect(d.status === 'executed' && (d.result as any).status).toBe('awaiting_user_approval');
    const proposed = (await c.get('/api/memories?status=proposed')).data.memories;
    expect(proposed).toHaveLength(2);
    await c.post(`/api/memories/${proposed[0].id}/approve`);
    expect((await c.get('/api/memories?status=proposed')).data.memories).toHaveLength(1);
  });

  it('respects "explicit only", "always ask" and memory-off settings', async () => {
    const c = await signup(ctx);
    await c.patch('/api/settings', { memory: { saveMode: 'explicit' } });
    let r = await executeTool('save_memory', { content: 'Likes jazz' }, makeContext(ctx.services, c.user.id, null));
    expect(r.status).toBe('error');
    await c.patch('/api/settings', { memory: { saveMode: 'ask' } });
    r = await executeTool('save_memory', { content: 'Likes jazz', user_requested: true }, makeContext(ctx.services, c.user.id, null));
    expect(r.status === 'executed' && (r.result as any).status).toBe('awaiting_user_approval');
    await c.patch('/api/settings', { memory: { enabled: false } });
    r = await executeTool('save_memory', { content: 'Likes blues', user_requested: true }, makeContext(ctx.services, c.user.id, null));
    expect(r.status).toBe('error');
  });
});

describe('tool registry and approvals', () => {
  it('exposes every tool with a JSON schema and a risk level', () => {
    const specs = toolSpecs();
    expect(specs.length).toBe(TOOLS.length);
    for (const s of specs) {
      expect(s.input_schema.type).toBe('object');
      expect(s.description.length).toBeGreaterThan(20);
    }
    // Built-in tools that need the user's approval: deletions, and changing or adding files in their own folders.
    expect(TOOLS.filter((t) => t.risk === 'consequential').map((t) => t.name).filter((n) => !n.startsWith('delete_')).sort()).toEqual(['change_local_files', 'save_spreadsheet_to_folder']);
  });

  it('offers a smaller core tool set for local models', () => {
    const core = toolSpecs('core');
    expect(core.map((t) => t.name).sort()).toEqual([...CORE_TOOLS].sort());
    expect(JSON.stringify(core).length).toBeLessThan(JSON.stringify(toolSpecs()).length * 0.8);
  });

  it('rejects invalid or unknown tool input without side effects', async () => {
    const c = await signup(ctx);
    const t = makeContext(ctx.services, c.user.id, null);
    expect((await executeTool('create_task', { title: '' }, t)).status).toBe('error');
    expect((await executeTool('create_task', { title: 'x', priority: 9 }, t)).status).toBe('error');
    expect((await executeTool('format_hard_drive', {}, t)).status).toBe('error');
    expect((await c.get('/api/tasks?view=all')).data.tasks).toHaveLength(0);
  });

  it('runs reversible tools directly and logs them', async () => {
    const c = await signup(ctx);
    const r = await executeTool('create_task', { title: 'Call supplier', due: 'tomorrow at 10am', remind: 'tomorrow at 9:45am' }, makeContext(ctx.services, c.user.id, null));
    expect(r.status).toBe('executed');
    const tasks = (await c.get('/api/tasks?view=all')).data.tasks;
    expect(tasks[0].title).toBe('Call supplier');
    expect(tasks[0].due_at).toBe('2026-10-17T07:00:00.000Z');
    expect(tasks[0].next_reminder).toBe('2026-10-17T06:45:00.000Z');
    const actions = (await c.get('/api/actions')).data.actions;
    expect(actions[0]).toMatchObject({ tool: 'create_task', status: 'executed', risk: 'reversible' });
  });

  it('queues consequential tools and only runs them after approval, exactly once', async () => {
    const c = await signup(ctx);
    const task = (await c.post('/api/tasks', { title: 'Old task' })).data;
    const r = await executeTool('delete_task', { task_id: task.id }, makeContext(ctx.services, c.user.id, null));
    expect(r.status).toBe('pending_approval');
    expect((await c.get(`/api/tasks/${task.id}`)).status).toBe(200); // not deleted yet
    const pending = (await c.get('/api/actions?status=pending')).data;
    expect(pending.pending).toBe(1);
    expect(pending.actions[0].summary).toContain('Old task');

    const ok = await c.post(`/api/actions/${r.actionId}/approve`);
    expect(ok.data.status).toBe('executed');
    expect((await c.get(`/api/tasks/${task.id}`)).status).toBe(404);
    expect((await c.post(`/api/actions/${r.actionId}/approve`)).status).toBe(409);
  });

  it('declining a queued action changes nothing', async () => {
    const c = await signup(ctx);
    const note = (await c.post('/api/memories', { content: 'Keep me in memory' })).data.memory;
    const r = await executeTool('delete_memory', { memory_id: note.id }, makeContext(ctx.services, c.user.id, null));
    await c.post(`/api/actions/${r.actionId}/reject`);
    expect((await c.get('/api/memories')).data.memories.some((m: any) => m.id === note.id)).toBe(true);
    expect((await c.post(`/api/actions/${r.actionId}/approve`)).status).toBe(409);
  });

  it('another user cannot approve someone else’s action', async () => {
    const alice = await signup(ctx, 'Alice');
    const bob = await signup(ctx, 'Bob');
    const note = (await alice.post('/api/memories', { content: 'Alice keeps this' })).data.memory;
    const r = await executeTool('delete_memory', { memory_id: note.id }, makeContext(ctx.services, alice.user.id, null));
    expect((await bob.post(`/api/actions/${r.actionId}/approve`)).status).toBe(404);
    await expect(approveAction(ctx.services, bob.user.id, r.actionId!)).rejects.toThrow();
    expect((await alice.get('/api/memories')).data.memories.some((m: any) => m.id === note.id)).toBe(true);
  });

  it('binds approvals to the exact payload and refuses tampered ones', async () => {
    const c = await signup(ctx);
    const note = (await c.post('/api/memories', { content: 'Keep me in memory' })).data.memory;
    const r = await executeTool('delete_memory', { memory_id: note.id }, makeContext(ctx.services, c.user.id, null));
    const row = ctx.services.db.get('SELECT payload_hash, expires_at FROM actions WHERE id = ?', r.actionId!)!;
    expect(row.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.expires_at).toBeTruthy();
    ctx.services.db.run('UPDATE actions SET input = ? WHERE id = ?', JSON.stringify({ memory_id: 'someone-else' }), r.actionId!);
    expect((await c.post(`/api/actions/${r.actionId}/approve`)).status).toBe(409);
    expect((await c.get('/api/memories')).data.memories.some((m: any) => m.id === note.id)).toBe(true);
  });

  it('expires stale approvals instead of running them', async () => {
    const c = await signup(ctx);
    const note = (await c.post('/api/memories', { content: 'Old memory request' })).data.memory;
    const r = await executeTool('delete_memory', { memory_id: note.id }, makeContext(ctx.services, c.user.id, null));
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 8 * 86400_000);
    expect((await c.post(`/api/actions/${r.actionId}/approve`)).status).toBe(410);
    expect((await c.get('/api/memories')).data.memories.some((m: any) => m.id === note.id)).toBe(true);
    expect((await c.post(`/api/actions/${r.actionId}/approve`)).status).toBe(409);
  });

  it('honours permission settings: ask, off, and never auto for consequential tools', async () => {
    const c = await signup(ctx);
    await c.patch('/api/settings', { permissions: { autoReversible: false } });
    let r = await executeTool('create_task', { title: 'Needs OK' }, makeContext(ctx.services, c.user.id, null));
    expect(r.status).toBe('pending_approval');

    await c.patch('/api/settings', { permissions: { autoReversible: true, tools: { create_note: 'off', delete_task: 'auto' } } });
    r = await executeTool('create_note', { title: 'x', body: 'y' }, makeContext(ctx.services, c.user.id, null));
    expect(r.status).toBe('error');
    const s = (await c.get('/api/settings')).data;
    expect(s.permissions.tools.delete_task).toBe('ask'); // "auto" is refused for consequential tools
    const t = (await c.post('/api/tasks', { title: 't' })).data;
    r = await executeTool('delete_task', { task_id: t.id }, makeContext(ctx.services, c.user.id, null));
    expect(r.status).toBe('pending_approval');
  });

  it('tools cannot touch another user’s data even with a valid id', async () => {
    const alice = await signup(ctx, 'Alice');
    const bob = await signup(ctx, 'Bob');
    const task = (await alice.post('/api/tasks', { title: 'Alice task' })).data;
    const r = await executeTool('complete_task', { task_id: task.id }, makeContext(ctx.services, bob.user.id, null));
    expect(r.status).toBe('error');
    expect((await alice.get(`/api/tasks/${task.id}`)).data.status).toBe('open');
  });

  it('reports web search as unavailable instead of pretending', async () => {
    const c = await signup(ctx);
    const r = await executeTool('web_search', { query: 'latest news' }, makeContext(ctx.services, c.user.id, null));
    expect(r.status).toBe('error');
    expect(r.status === 'error' && r.error).toMatch(/not configured.*no search was performed/i);
  });
});
