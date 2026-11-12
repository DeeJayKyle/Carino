import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, parseSSE, toolCall, type TestCtx } from './helpers.ts';
import { executeTool, makeContext } from '../server/tools/registry.ts';

async function send(c: any, convId: string, body: any) {
  const r = await c.post(`/api/conversations/${convId}/messages`, body);
  return { status: r.status, events: r.status === 200 ? parseSSE(r.data) : [] };
}

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

describe('chat cards', () => {
  it('a question with answers ends the turn and is shown with its options', async () => {
    const c = await signup(ctx);
    const conv = (await c.post('/api/conversations', {})).data;
    ctx.provider.steps.push(() => toolCall('ask_user', { question: 'Which evening suits you?', options: ['Friday', 'Saturday'], allow_other: true }, 'tu_q'));
    await send(c, conv.id, { text: 'Book me a dinner this weekend' });
    // Only one model call: the turn stopped to wait for the answer.
    expect(ctx.provider.calls).toHaveLength(1);
    const msgs = (await c.get(`/api/conversations/${conv.id}`)).data.messages;
    const tool = msgs.at(-1).meta.tools[0];
    expect(tool).toMatchObject({ name: 'ask_user', status: 'executed' });
    expect(tool.result.options).toEqual(['Friday', 'Saturday']);
  });

  it('a queued action’s text can be edited before approval, and only its existing text', async () => {
    const c = await signup(ctx);
    const task = (await c.post('/api/tasks', { title: 'Old task' })).data;
    const r = await executeTool('delete_task', { task_id: task.id }, makeContext(ctx.services, c.user.id, null));
    expect(r.status).toBe('pending_approval');
    // delete_task has no free text: its id can't be swapped for another task's.
    expect((await c.patch(`/api/actions/${r.actionId}`, { input: { task_id: 'someone-else' } })).status).toBe(400);
    expect((await c.patch(`/api/actions/${r.actionId}`, { input: { extra: 'x' } })).status).toBe(400);
    expect((await c.post(`/api/actions/${r.actionId}/approve`)).data.status).toBe('executed');
  });
});
