import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, text, toolCall, type TestCtx } from './helpers.ts';
import { runRoutines } from '../server/services/scheduler.ts';
import { previewText } from '../server/services/routines.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

describe('custom routines', () => {
  it('offers ready-made ideas and refuses ones with blanks left to fill', async () => {
    const c = await signup(ctx);
    const { ideas } = (await c.get('/api/routines/ideas')).data;
    expect(ideas.length).toBeGreaterThan(10);
    const price = ideas.find((i: any) => i.id === 'price-watch');
    expect(price.needs).toContain('web_search');
    const r = await c.post('/api/routines', { title: price.title, prompt: price.prompt, time_local: price.time, days: price.days, catalog_id: price.id });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/square brackets/);
    const ok = await c.post('/api/routines', { title: price.title, prompt: price.prompt.replace('[item]', 'a kettle').replace('[shop or website]', 'Jumia').replace('[target price]', 'UGX 90,000'), time_local: '09:00', catalog_id: price.id });
    expect(ok.status).toBe(201);
    expect(ok.data).toMatchObject({ kind: 'custom', custom: true, enabled: true, days: [1, 2, 3, 4, 5, 6, 0], catalog_id: 'price-watch' });
  });

  it('runs a routine as an agent turn at its time, once, and notifies with the result', async () => {
    const c = await signup(ctx);
    const r = (await c.post('/api/routines', { title: 'Friday wins', prompt: 'List what I completed this week.', time_local: '11:00', days: EVERY_DAY })).data;
    ctx.provider.steps.push(() => text('You finished **3 tasks** this week, including the stock audit.'));
    ctx.clock.now = new Date('2026-10-16T08:05:00Z'); // 11:05 in Kampala
    expect(await runRoutines(ctx.services)).toBe(1);
    expect(await runRoutines(ctx.services)).toBe(0);
    // The model saw the routine's instruction, framed as a scheduled run.
    const sent = JSON.stringify(ctx.provider.calls[0].messages);
    expect(sent).toContain('Scheduled routine \\"Friday wins\\"');
    expect(sent).toContain('List what I completed this week.');
    const n = (await c.get('/api/notifications')).data.notifications.find((x: any) => x.kind === 'routine');
    expect(n.title).toBe('Friday wins');
    expect(n.body).toBe('You finished 3 tasks this week, including the stock audit.');
    const after = (await c.get('/api/routines')).data.routines.find((x: any) => x.id === r.id);
    expect(after.last_status).toBe('ok');
    expect(after.last_result).toContain('3 tasks');
    expect(n.link).toBe(`/chat/${after.conversation_id}`);
    // The routine keeps one conversation, so later runs build on earlier ones.
    const conv = (await c.get(`/api/conversations/${after.conversation_id}`)).data;
    expect(conv.title ?? conv.conversation?.title).toBe('Routine: Friday wins');
  });

  it('does not run before its time, on other days, or when switched off', async () => {
    const c = await signup(ctx);
    const r = (await c.post('/api/routines', { title: 'Later', prompt: 'Say hello.', time_local: '18:00', days: EVERY_DAY })).data;
    ctx.clock.now = new Date('2026-10-16T08:05:00Z'); // 11:05 local
    expect(await runRoutines(ctx.services)).toBe(0);
    await c.patch(`/api/routines/${r.id}`, { time_local: '11:00', enabled: false });
    expect(await runRoutines(ctx.services)).toBe(0);
    const weekday = new Date('2026-10-16T08:05:00Z').getUTCDay();
    await c.patch(`/api/routines/${r.id}`, { enabled: true, days: [(weekday + 1) % 7] });
    expect(await runRoutines(ctx.services)).toBe(0);
    expect(ctx.provider.calls.length).toBe(0);
  });

  it('records a failure and tells the user when no AI model can run it', async () => {
    const c = await signup(ctx);
    ctx.provider.configured = false;
    const r = (await c.post('/api/routines', { title: 'News', prompt: 'Summarise the news.', time_local: '11:00', days: EVERY_DAY })).data;
    ctx.clock.now = new Date('2026-10-16T08:05:00Z');
    expect(await runRoutines(ctx.services)).toBe(0);
    const after = (await c.get('/api/routines')).data.routines.find((x: any) => x.id === r.id);
    expect(after.last_status).toBe('failed');
    expect(after.last_error).toMatch(/No AI provider/);
    const n = (await c.get('/api/notifications')).data.notifications.find((x: any) => x.kind === 'action_failed');
    expect(n.title).toBe('Routine "News" failed');
  });

  it('can be run on demand, edited and deleted; built-ins cannot be deleted', async () => {
    const c = await signup(ctx);
    const r = (await c.post('/api/routines', { title: 'Lesson', prompt: 'Teach me one Luganda word.', time_local: '07:30' })).data;
    ctx.provider.steps.push(() => text('Today\'s word: **webale** — thank you.'));
    const run = await c.post(`/api/routines/${r.id}/run`);
    expect(run.status).toBe(200);
    expect(run.data.reply).toContain('webale');
    expect((await c.patch(`/api/routines/${r.id}`, { title: 'Luganda lesson' })).data.title).toBe('Luganda lesson');
    const builtIn = (await c.get('/api/routines')).data.routines.find((x: any) => x.kind === 'morning_briefing');
    expect((await c.patch(`/api/routines/${builtIn.id}`, { title: 'Nope' })).status).toBe(400);
    expect((await c.del(`/api/routines/${builtIn.id}`)).status).toBe(400);
    expect((await c.post(`/api/routines/${builtIn.id}/run`)).status).toBe(400);
    expect((await c.del(`/api/routines/${r.id}`)).status).toBe(200);
    expect((await c.get('/api/routines')).data.routines.some((x: any) => x.id === r.id)).toBe(false);
  });

  it('lets Carino create a routine from chat', async () => {
    const c = await signup(ctx);
    const conv = (await c.post('/api/conversations', {})).data;
    ctx.provider.steps.push(() => toolCall('create_routine', { title: 'Water reminder', prompt: 'Remind me to drink water.', time: '15:00', days: [1, 2, 3, 4, 5] }));
    ctx.provider.steps.push(() => text('Done — every weekday at 15:00.'));
    await c.post(`/api/conversations/${conv.id ?? conv.conversation?.id}/messages`, { text: 'Remind me to drink water every weekday afternoon at 3' });
    const mine = (await c.get('/api/routines')).data.routines.filter((x: any) => x.custom);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: 'Water reminder', time_local: '15:00', days: [1, 2, 3, 4, 5] });
  });

  it('keeps routines private to their owner', async () => {
    const a = await signup(ctx, 'A');
    const b = await signup(ctx, 'B');
    const r = (await a.post('/api/routines', { title: 'Mine', prompt: 'Say hi.', time_local: '07:00' })).data;
    expect((await b.patch(`/api/routines/${r.id}`, { enabled: false })).status).toBe(404);
    expect((await b.del(`/api/routines/${r.id}`)).status).toBe(404);
    expect((await b.post(`/api/routines/${r.id}/run`)).status).toBe(404);
  });

  it('builds a routine from steps and limits it to what the user picked', async () => {
    const c = await signup(ctx);
    const groups = (await c.get('/api/routines/access')).data.groups;
    expect(groups.map((g: any) => g.id)).toEqual(expect.arrayContaining(['tasks', 'money', 'email', 'files']));
    expect(JSON.stringify(groups)).not.toContain('gmail_'); // plain words only, no tool names
    expect((await c.post('/api/routines', { title: 'Bad', prompt: 'Do things please.', time_local: '09:00', access: ['root'] })).status).toBe(400);
    const r = (await c.post('/api/routines', {
      title: 'Bills check', prompt: 'Look after my bills.', time_local: '09:00',
      steps: ['Check bills due this week', 'Add a to-do for each'], access: ['money', 'tasks'],
    })).data;
    expect(r).toMatchObject({ steps: ['Check bills due this week', 'Add a to-do for each'], access: ['money', 'tasks'] });
    expect(r.access_summary.everything).toBe(false);
    expect(r.access_summary.asks).toContain('deleting a to-do');
    // The model tries a tool outside the routine's access, then one inside it.
    ctx.provider.steps.push(() => toolCall('web_search', { query: 'anything' }));
    ctx.provider.steps.push(() => toolCall('create_task', { title: 'Pay water bill' }));
    ctx.provider.steps.push(() => toolCall('delete_task', { task_id: 'x' }));
    ctx.provider.steps.push(() => text('Added a to-do for the water bill.'));
    expect((await c.post(`/api/routines/${r.id}/run`)).status).toBe(200);
    const first = ctx.provider.calls[0];
    const offered = (first.tools ?? []).map((t: any) => t.name);
    expect(offered).toContain('create_task');
    expect(offered).toContain('log_expense');
    expect(offered).not.toContain('web_search');
    expect(offered).not.toContain('save_memory');
    const sent = JSON.stringify(first.messages);
    expect(sent).toContain('1. Check bills due this week');
    const later = JSON.stringify(ctx.provider.calls.at(-1)!.messages);
    expect(later).toContain('isn’t allowed to use that');
    expect((await c.get('/api/tasks')).data.tasks.some((t: any) => t.title === 'Pay water bill')).toBe(true);
    // Allowed but consequential: still waits for approval.
    const pending = (await c.get('/api/actions?status=pending')).data;
    expect(JSON.stringify(pending)).toContain('delete_task');
    // Back to everything.
    const back = (await c.patch(`/api/routines/${r.id}`, { access: null, steps: [] })).data;
    expect(back).toMatchObject({ access: null, steps: [] });
    expect(back.access_summary.everything).toBe(true);
  });

  it('turns a Markdown reply into a short plain notification', () => {
    expect(previewText('## Today\n\n**Three** things: [link](https://x.y)\n\n> note', 100)).toBe('Today\nThree things: link');
    expect(previewText('a'.repeat(300), 20)).toHaveLength(20);
  });
});
