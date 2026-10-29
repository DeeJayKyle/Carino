import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, type TestCtx } from './helpers.ts';
import { nextOccurrence } from '../server/services/tasks.ts';
import { parseWhen } from '../server/services/time.ts';
import { deliverDueReminders, runRoutines } from '../server/services/scheduler.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

describe('tasks', () => {
  it('creates, edits, completes, reopens and deletes a task with history', async () => {
    const c = await signup(ctx);
    const t = (await c.post('/api/tasks', { title: 'Review budget', priority: 1, tags: ['finance'], due_at: '2026-10-16T12:00:00Z' })).data;
    expect(t.status).toBe('open');
    expect(t.tags).toEqual(['finance']);
    await c.patch(`/api/tasks/${t.id}`, { description: 'Q4 numbers' });
    const done = (await c.post(`/api/tasks/${t.id}/complete`)).data;
    expect(done.task.status).toBe('done');
    expect(done.task.completed_at).toBeTruthy();
    const reopened = (await c.post(`/api/tasks/${t.id}/reopen`)).data;
    expect(reopened.status).toBe('open');
    const detail = (await c.get(`/api/tasks/${t.id}`)).data;
    expect(detail.history.map((h: any) => h.change)).toEqual(expect.arrayContaining(['created', 'completed', 'reopened']));
    expect((await c.del(`/api/tasks/${t.id}`)).status).toBe(200);
    expect((await c.get(`/api/tasks/${t.id}`)).status).toBe(404);
  });

  it('supports subtasks, which are deleted with their parent', async () => {
    const c = await signup(ctx);
    const parent = (await c.post('/api/tasks', { title: 'Launch' })).data;
    await c.post('/api/tasks', { title: 'Step 1', parent_id: parent.id });
    await c.post('/api/tasks', { title: 'Step 2', parent_id: parent.id });
    expect((await c.get(`/api/tasks/${parent.id}`)).data.subtasks).toHaveLength(2);
    await c.del(`/api/tasks/${parent.id}`);
    expect((await c.get('/api/tasks?view=all')).data.tasks).toHaveLength(0);
  });

  it('puts tasks in the right views for the user’s timezone', async () => {
    const c = await signup(ctx); // Africa/Kampala, UTC+3; clock = 2026-10-16 11:00 local
    await c.post('/api/tasks', { title: 'Overdue', due_at: '2026-10-15T09:00:00Z' });
    await c.post('/api/tasks', { title: 'Later today', due_at: '2026-10-16T17:00:00Z' });
    await c.post('/api/tasks', { title: 'Next week', due_at: '2026-10-22T09:00:00Z' });
    await c.post('/api/tasks', { title: 'Someday' });
    const titles = async (v: string) => (await c.get(`/api/tasks?view=${v}`)).data.tasks.map((t: any) => t.title);
    expect(await titles('today')).toEqual(['Overdue', 'Later today']);
    expect(await titles('overdue')).toEqual(['Overdue']);
    expect(await titles('upcoming')).toEqual(['Next week']);
    expect(await titles('inbox')).toEqual(['Someday']);
  });

  it('filters by search, priority and tag', async () => {
    const c = await signup(ctx);
    await c.post('/api/tasks', { title: 'Order stock', priority: 1, tags: ['supplies'] });
    await c.post('/api/tasks', { title: 'Call mum', priority: 3 });
    expect((await c.get('/api/tasks?priority=3')).data.tasks[0].title).toBe('Call mum');
    expect((await c.get('/api/tasks?tag=supplies')).data.tasks[0].title).toBe('Order stock');
    expect((await c.get('/api/tasks?q=stock')).data.tasks).toHaveLength(1);
  });

  it('completing a recurring task creates the next occurrence and shifts its reminder', async () => {
    const c = await signup(ctx);
    const t = (await c.post('/api/tasks', {
      title: 'Weekly stock count', due_at: '2026-10-16T14:00:00Z', recurrence: { freq: 'weekly', interval: 1 }, remind_at: '2026-10-16T13:30:00Z',
    })).data;
    const r = (await c.post(`/api/tasks/${t.id}/complete`)).data;
    expect(r.next.due_at).toBe('2026-10-23T14:00:00.000Z');
    const next = (await c.get(`/api/tasks/${r.next.id}`)).data;
    expect(next.reminders[0].remind_at).toBe('2026-10-23T13:30:00.000Z');
    // The completed task's pending reminder was cancelled.
    expect((await c.get(`/api/tasks/${t.id}`)).data.reminders[0].status).toBe('cancelled');
  });
});

describe('recurrence rules', () => {
  const d = (s: string) => new Date(s);
  it('computes daily, weekly, monthly and yearly occurrences', () => {
    expect(nextOccurrence(d('2026-10-16T09:00:00Z'), { freq: 'daily', interval: 2 }).toISOString()).toBe('2026-10-18T09:00:00.000Z');
    expect(nextOccurrence(d('2026-01-31T09:00:00Z'), { freq: 'monthly', interval: 1 }).toISOString()).toBe('2026-02-28T09:00:00.000Z');
    expect(nextOccurrence(d('2028-02-29T09:00:00Z'), { freq: 'yearly', interval: 1 }).toISOString().slice(0, 10)).toBe('2029-03-01');
    // Friday 16 Oct → Mon/Wed/Fri rule → Monday 19 Oct
    expect(nextOccurrence(d('2026-10-16T09:00:00Z'), { freq: 'weekly', interval: 1, byweekday: [1, 3, 5] }).toISOString().slice(0, 10)).toBe('2026-10-19');
    // Monday → next Wednesday in the same week
    expect(nextOccurrence(d('2026-10-19T09:00:00Z'), { freq: 'weekly', interval: 2, byweekday: [1, 3] }).toISOString().slice(0, 10)).toBe('2026-10-21');
    // Wednesday, every 2 weeks on Mon/Wed → Monday two weeks later
    expect(nextOccurrence(d('2026-10-21T09:00:00Z'), { freq: 'weekly', interval: 2, byweekday: [1, 3] }).toISOString().slice(0, 10)).toBe('2026-11-02');
  });
});

describe('natural-language scheduling', () => {
  const now = new Date('2026-10-16T08:00:00Z'); // 11:00 in Kampala
  it('interprets "tomorrow morning" in the user’s timezone and flags the assumed time', () => {
    const p = parseWhen('Remind me tomorrow morning to review the project budget', now, 'Africa/Kampala')!;
    expect(p.iso).toBe('2026-10-17T06:00:00.000Z'); // 09:00 local
    expect(p.remainder).toBe('review the project budget');
    expect(p.ambiguities.join(' ')).toMatch(/No exact time/);
  });

  it('parses explicit times without ambiguity', () => {
    const p = parseWhen('call the supplier next friday at 3pm', now, 'Africa/Kampala')!;
    expect(p.iso).toBe('2026-10-23T12:00:00.000Z');
    expect(p.ambiguities).toEqual([]);
  });

  it('asks for confirmation through the parse endpoint and saves nothing', async () => {
    const c = await signup(ctx);
    const r = (await c.post('/api/tasks/parse', { text: 'Remind me tomorrow morning to review the project budget' })).data;
    expect(r.needsConfirmation).toBe(true);
    expect(r.draft.title).toBe('Review the project budget');
    expect(r.draft.remind_at).toBe('2026-10-17T06:00:00.000Z');
    expect(r.interpreted.local).toMatch(/Sat/);
    expect((await c.get('/api/tasks?view=all')).data.tasks).toHaveLength(0);
    const vague = (await c.post('/api/tasks/parse', { text: 'remind me to water the plants' })).data;
    expect(vague.ambiguities[0]).toMatch(/when should I remind you/i);
  });
});

describe('reminder scheduler', () => {
  it('delivers due reminders once, by push and in-app, and not before they are due', async () => {
    const c = await signup(ctx);
    await c.post('/api/push/subscribe', { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } });
    await c.post('/api/reminders', { title: 'Take medicine', remind_at: '2026-10-16T09:00:00Z' });

    expect(await deliverDueReminders(ctx.services)).toBe(0);
    expect(ctx.pushed).toHaveLength(0);

    ctx.clock.now = new Date('2026-10-16T09:00:30Z');
    expect(await deliverDueReminders(ctx.services)).toBe(1);
    expect(ctx.pushed).toHaveLength(1);
    expect(ctx.pushed[0].body.title).toContain('Take medicine');
    expect(await deliverDueReminders(ctx.services)).toBe(0); // not sent twice
    const notes = (await c.get('/api/notifications')).data.notifications;
    expect(notes[0]).toMatchObject({ kind: 'reminder', title: 'Take medicine' });
    expect((await c.get('/api/reminders')).data.reminders[0].status).toBe('sent');
  });

  it('retries failed pushes with backoff, then reports the failure', async () => {
    const c = await signup(ctx);
    await c.post('/api/push/subscribe', { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } });
    await c.post('/api/reminders', { title: 'Pay rent', remind_at: '2026-10-16T08:01:00Z' });
    ctx.pushFail.status = 500;
    ctx.clock.now = new Date('2026-10-16T08:02:00Z');
    await deliverDueReminders(ctx.services);
    let r = (await c.get('/api/reminders')).data.reminders[0];
    expect(r.status).toBe('scheduled');
    expect(r.last_error).toMatch(/500/);
    for (let i = 0; i < 6; i++) {
      ctx.clock.now = new Date(ctx.clock.now.getTime() + 60 * 60_000);
      await deliverDueReminders(ctx.services);
    }
    r = (await c.get('/api/reminders')).data.reminders[0];
    expect(r.status).toBe('failed');
    const n = (await c.get('/api/notifications')).data.notifications;
    expect(n.some((x: any) => x.kind === 'action_failed')).toBe(true);
  });

  it('removes subscriptions the browser has revoked', async () => {
    const c = await signup(ctx);
    await c.post('/api/push/subscribe', { endpoint: 'https://push.example/gone', keys: { p256dh: 'k', auth: 'a' } });
    ctx.pushFail.status = 410;
    await ctx.services.push.sendToUser(c.user.id, { title: 't', body: 'b' });
    expect((await c.get('/api/push/devices')).data.devices).toHaveLength(0);
  });

  it('holds reminders during quiet hours', async () => {
    const c = await signup(ctx);
    await c.patch('/api/settings', { notifications: { quietHoursStart: '22:00', quietHoursEnd: '07:00' } });
    await c.post('/api/reminders', { title: 'Night reminder', remind_at: '2026-10-16T20:00:00Z' }); // 23:00 local
    ctx.clock.now = new Date('2026-10-16T20:01:00Z');
    expect(await deliverDueReminders(ctx.services)).toBe(0);
    ctx.clock.now = new Date('2026-10-17T04:05:00Z'); // 07:05 local
    expect(await deliverDueReminders(ctx.services)).toBe(1);
  });

  it('rejects reminders in the past', async () => {
    const c = await signup(ctx);
    expect((await c.post('/api/reminders', { title: 'x', remind_at: '2026-10-15T08:00:00Z' })).status).toBe(400);
  });

  it('runs an enabled morning briefing once per day from real data', async () => {
    const c = await signup(ctx);
    const routines = (await c.get('/api/routines')).data.routines;
    const morning = routines.find((r: any) => r.kind === 'morning_briefing');
    await c.patch(`/api/routines/${morning.id}`, { enabled: true, time_local: '07:00' });
    await c.post('/api/tasks', { title: 'Inventory audit', due_at: '2026-10-16T12:00:00Z', priority: 1 });
    ctx.clock.now = new Date('2026-10-16T04:30:00Z'); // 07:30 local
    expect(await runRoutines(ctx.services)).toBe(1);
    expect(await runRoutines(ctx.services)).toBe(0);
    const n = (await c.get('/api/notifications')).data.notifications.find((x: any) => x.kind === 'routine');
    expect(n.body).toContain('Inventory audit');
    expect(n.body).not.toMatch(/meeting|calendar event/i);
  });

  it('writes an evening review with completed, unfinished and tomorrow’s priorities', async () => {
    const c = await signup(ctx);
    const evening = (await c.get('/api/routines')).data.routines.find((r: any) => r.kind === 'evening_review');
    await c.patch(`/api/routines/${evening.id}`, { enabled: true, time_local: '20:00' });
    const done = (await c.post('/api/tasks', { title: 'Order stock', due_at: '2026-10-16T12:00:00Z' })).data;
    await c.post('/api/tasks', { title: 'Mark exams', due_at: '2026-10-16T13:00:00Z' });
    await c.post('/api/tasks', { title: 'Release v2', due_at: '2026-10-17T09:00:00Z', priority: 1 });
    ctx.clock.now = new Date('2026-10-16T14:00:00Z');
    await c.post(`/api/tasks/${done.id}/complete`);
    ctx.clock.now = new Date('2026-10-16T17:10:00Z'); // 20:10 local
    expect(await runRoutines(ctx.services)).toBe(1);
    const n = (await c.get('/api/notifications')).data.notifications.find((x: any) => x.kind === 'routine');
    expect(n.title).toBe('Evening review');
    expect(n.body).toContain('completed 1 task today: Order stock');
    expect(n.body).toContain('1 task due today is still open');
    expect(n.body).toMatch(/Suggested priorities for tomorrow: Release v2; Mark exams/);
    const r = (await c.get('/api/routines')).data.routines.find((x: any) => x.id === evening.id);
    expect(r.last_status).toBe('ok');
  });

  it('records a failed routine without blocking others', async () => {
    const a = await signup(ctx, 'Ann');
    const b = await signup(ctx, 'Ben');
    for (const c of [a, b]) {
      const m = (await c.get('/api/routines')).data.routines.find((r: any) => r.kind === 'morning_briefing');
      await c.patch(`/api/routines/${m.id}`, { enabled: true, time_local: '07:00' });
    }
    const orig = ctx.services.push.configured;
    let calls = 0;
    ctx.services.push.configured = () => { if (calls++ === 0) throw new Error('boom'); return orig.call(ctx.services.push); };
    ctx.clock.now = new Date('2026-10-16T04:30:00Z');
    expect(await runRoutines(ctx.services)).toBe(1);
    ctx.services.push.configured = orig;
    const statuses = [a, b].map(async (c) => (await c.get('/api/routines')).data.routines.find((r: any) => r.kind === 'morning_briefing'));
    const rows = await Promise.all(statuses);
    expect(rows.map((r) => r.last_status).sort()).toEqual(['failed', 'ok']);
    expect(rows.find((r) => r.last_status === 'failed').last_error).toBe('boom');
  });
});
