import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, text, toolCall, type TestCtx } from './helpers.ts';
import { executeTool, makeContext } from '../server/tools/registry.ts';
import { runCode } from '../server/services/sandbox.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

const run = async (c: any, name: string, input: unknown, conv: string | null = null) => executeTool(name, input, makeContext(ctx.services, c.user.id, conv));

describe('skills', () => {
  it('saves, lists, reads, improves and (with approval) deletes a skill', async () => {
    const c = await signup(ctx);
    const saved: any = await run(c, 'skill_save', { name: 'Weekly report', description: 'Every Friday work summary', instructions: '1. List finished tasks. 2. Group by project. 3. Draft a short email for my manager and ask before sending.' });
    // Saving a skill is a reversible change: it waits for approval unless the user allows it.
    const done: any = saved.status === 'pending_approval' ? await c.post(`/api/actions/${saved.actionId}/approve`).then((r: any) => r.data) : saved;
    expect(done.status).toBe('executed');
    const list: any = await run(c, 'skill_list', {});
    expect(list.result.skills.map((s: any) => s.name)).toEqual(['Weekly report']);
    const view: any = await run(c, 'skill_view', { name: 'weekly REPORT' });
    expect(view.result.instructions).toContain('Group by project');
    expect((await run(c, 'skill_list', {}) as any).result.skills[0].uses).toBe(1);
    const del: any = await run(c, 'skill_delete', { name: 'Weekly report' });
    expect(del.status).toBe('pending_approval');
  });
});

describe('searching earlier chats', () => {
  it('finds what was said before, and keeps private chats from online AI', async () => {
    const c = await signup(ctx);
    const a = (await c.post('/api/conversations', {})).data;
    const b = (await c.post('/api/conversations', {})).data;
    ctx.provider.steps.push(() => text('The plumber is called Musa, number in your notes.'));
    await c.post(`/api/conversations/${a.id}/messages`, { text: 'Who was the plumber we found?' });
    ctx.provider.steps.push(() => text('Noted the plumber quote for the secret project.'));
    await c.post(`/api/conversations/${b.id}/messages`, { text: 'plumber quote for the secret project' });
    await c.patch(`/api/conversations/${b.id}/local-only`, { local_only: true });
    const cloud = { ...makeContext(ctx.services, c.user.id, null), cloud: true };
    const out: any = await executeTool('search_past_chats', { query: 'plumber' }, cloud);
    const ids = out.result.results.map((r: any) => r.conversation_id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });
});

describe('code runner', () => {
  it('calculates exactly, sees only the data it is given, and stops endless loops', async () => {
    expect((await runCode('input.reduce((a, b) => a + b, 0)', [0.1, 0.2, 0.3])).result).toBeCloseTo(0.6);
    expect((await runCode('console.log("hi"); return 6 * 7')).result).toBe(42);
    expect((await runCode('typeof fetch + typeof require + typeof process')).result).toBe('undefinedundefinedundefined');
    const loop = await runCode('while (true) {}');
    expect(loop.ok).toBe(false);
    expect(loop.error).toMatch(/Stopped/);
  }, 15_000);
});

describe('helper', () => {
  it('does a lookup job with read-only tools and reports back', async () => {
    const c = await signup(ctx);
    await c.post('/api/memories', { content: 'Prefers phones with a big battery' });
    ctx.provider.steps.push(
      () => toolCall('recall_memories', { query: 'phone' }, 'h1'),
      () => text('Report: pick the one with the biggest battery.'),
    );
    const out: any = await run(c, 'delegate', { task: 'Compare two phones for the user and recommend one.' });
    expect(out.status).toBe('executed');
    expect(out.result.report).toContain('biggest battery');
    expect(out.result.steps[0]).toMatch(/recall_memories/);
  });
});
