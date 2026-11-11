import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, text, toolCall, type TestCtx } from './helpers.ts';
import { deliverDueReminders } from '../server/services/scheduler.ts';
import { nextReminderTime, repeatLabel, repeatRule } from '../server/services/tasks.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

async function chat(c: Awaited<ReturnType<typeof signup>>, message: string) {
  const conv = (await c.post('/api/conversations', {})).data;
  await c.post(`/api/conversations/${conv.id}/messages`, { text: message });
  return conv.id as string;
}

describe('repeating reminders', () => {
  it('turns plain-words repeats into rules and labels', () => {
    const fri = new Date('2026-10-16T09:00:00Z'); // a Friday
    expect(repeatRule('daily', fri)).toEqual({ freq: 'daily', interval: 1 });
    expect(repeatRule('weekdays', fri)).toEqual({ freq: 'weekly', interval: 1, byweekday: [1, 2, 3, 4, 5] });
    expect(repeatRule('weekly', fri)).toEqual({ freq: 'weekly', interval: 1, byweekday: [5] });
    expect(repeatRule(undefined, fri)).toBeNull();
    expect(repeatLabel(repeatRule('weekdays', fri))).toBe('Weekdays');
    expect(repeatLabel(repeatRule('daily', fri))).toBe('Every day');
    expect(repeatLabel(null)).toBe('');
  });

  it('skips occurrences missed while the phone was off', () => {
    const rule = repeatRule('daily', new Date())!;
    const next = nextReminderTime(new Date('2026-10-10T06:00:00Z'), rule, new Date('2026-10-16T07:00:00Z'));
    expect(next.toISOString()).toBe('2026-10-17T06:00:00.000Z');
  });

  it('rings, then moves on to the next weekday instead of finishing', async () => {
    const c = await signup(ctx);
    // Friday 09:00 UTC, weekdays: the next one is Monday
    await c.post('/api/reminders', { title: 'Open the shop', remind_at: '2026-10-16T09:00:00Z', recurrence: { freq: 'weekly', interval: 1, byweekday: [1, 2, 3, 4, 5] } });
    ctx.clock.now = new Date('2026-10-16T09:00:30Z');
    expect(await deliverDueReminders(ctx.services)).toBe(1);
    const r = (await c.get('/api/reminders')).data.reminders[0];
    expect(r.status).toBe('scheduled');
    expect(r.remind_at).toBe('2026-10-19T09:00:00.000Z');
    expect(r.sent_at).toBeTruthy();
    expect(await deliverDueReminders(ctx.services)).toBe(0); // not again until Monday
    ctx.clock.now = new Date('2026-10-19T09:01:00Z');
    expect(await deliverDueReminders(ctx.services)).toBe(1);
    expect((await c.get('/api/reminders')).data.reminders[0].remind_at).toBe('2026-10-20T09:00:00.000Z');
    const notes = (await c.get('/api/notifications')).data.notifications.filter((n: any) => n.kind === 'reminder');
    expect(notes).toHaveLength(2);
  });

  it('a cancelled repeating reminder stops', async () => {
    const c = await signup(ctx);
    const r = (await c.post('/api/reminders', { title: 'Water plants', remind_at: '2026-10-16T09:00:00Z', recurrence: { freq: 'daily', interval: 1 } })).data;
    await c.del(`/api/reminders/${r.id}`);
    ctx.clock.now = new Date('2026-10-17T10:00:00Z');
    expect(await deliverDueReminders(ctx.services)).toBe(0);
  });
});

describe('snooze', () => {
  it('rings a delivered reminder again after the snooze', async () => {
    const c = await signup(ctx);
    const r = (await c.post('/api/reminders', { title: 'Call the bank', remind_at: '2026-10-16T09:00:00Z' })).data;
    ctx.clock.now = new Date('2026-10-16T09:00:30Z');
    await deliverDueReminders(ctx.services);
    const s = (await c.post(`/api/reminders/${r.id}/snooze`, { minutes: 10 })).data;
    expect(s.status).toBe('scheduled');
    expect(s.remind_at).toBe('2026-10-16T09:10:30.000Z');
    ctx.clock.now = new Date('2026-10-16T09:11:00Z');
    expect(await deliverDueReminders(ctx.services)).toBe(1);
  });

  it('snoozing a repeating reminder adds a one-off and keeps the series', async () => {
    const c = await signup(ctx);
    const r = (await c.post('/api/reminders', { title: 'Medicine', remind_at: '2026-10-16T09:00:00Z', recurrence: { freq: 'daily', interval: 1 } })).data;
    ctx.clock.now = new Date('2026-10-16T09:00:30Z');
    await deliverDueReminders(ctx.services); // moved on to tomorrow
    const s = (await c.post(`/api/reminders/${r.id}/snooze`, { minutes: 15 })).data;
    expect(s.id).not.toBe(r.id);
    const list = (await c.get('/api/reminders')).data.reminders;
    expect(list.map((x: any) => x.remind_at).sort()).toEqual(['2026-10-16T09:15:30.000Z', '2026-10-17T09:00:00.000Z']);
  });

  it('only the owner can snooze', async () => {
    const c = await signup(ctx);
    const other = await signup(ctx, 'Other');
    const r = (await c.post('/api/reminders', { title: 'Mine', remind_at: '2026-10-16T09:00:00Z' })).data;
    expect((await other.post(`/api/reminders/${r.id}/snooze`, { minutes: 10 })).status).toBe(404);
  });
});

describe('the assistant sets smarter reminders', () => {
  it('creates a repeating reminder from chat', async () => {
    const c = await signup(ctx);
    ctx.provider.steps.push(() => toolCall('create_reminder', { title: 'Take vitamins', when: '2026-10-17T05:00:00Z', repeat: 'daily' }));
    ctx.provider.steps.push(() => text('Done: every day at 8.'));
    await chat(c, 'remind me to take vitamins every day at 8');
    const r = (await c.get('/api/reminders')).data.reminders[0];
    expect(JSON.parse(r.recurrence)).toEqual({ freq: 'daily', interval: 1 });
    const result = JSON.stringify(ctx.provider.calls[1].messages.at(-1));
    expect(result).toContain('Every day');
  });

  it('creates a place reminder found on OpenStreetMap, and it rings once on arrival', async () => {
    const c = await signup(ctx);
    let asked = '';
    ctx.services.netFetch = (async (url: any) => {
      asked = String(url);
      return new Response(JSON.stringify([{ name: 'Capital Shoppers', display_name: 'Capital Shoppers, Ntinda, Kampala', lat: '0.352', lon: '32.614', category: 'shop', type: 'supermarket' }]), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    ctx.provider.steps.push(() => toolCall('create_place_reminder', { title: 'Buy milk', place: 'Capital Shoppers', near: 'Ntinda, Kampala' }));
    ctx.provider.steps.push(() => text('I will remind you when you get there.'));
    await chat(c, 'remind me to buy milk when I get to Capital Shoppers in Ntinda');
    expect(asked).toContain('nominatim.openstreetmap.org/search');
    const places = (await c.get('/api/place-reminders')).data.places;
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ title: 'Buy milk', place_name: 'Capital Shoppers', lat: 0.352, lon: 32.614, radius_m: 150, status: 'active' });

    expect((await c.post(`/api/place-reminders/${places[0].id}/arrived`)).data.fired).toBe(true);
    expect((await c.post(`/api/place-reminders/${places[0].id}/arrived`)).data.fired).toBe(false); // once
    const notes = (await c.get('/api/notifications')).data.notifications;
    expect(notes[0]).toMatchObject({ kind: 'reminder', title: '📍 Buy milk' });
    expect((await c.get('/api/place-reminders')).data.places[0].status).toBe('fired');
  });

  it('says so when a place is not found', async () => {
    const c = await signup(ctx);
    ctx.services.netFetch = (async () => new Response('[]', { headers: { 'content-type': 'application/json' } })) as typeof fetch;
    ctx.provider.steps.push(() => toolCall('create_place_reminder', { title: 'Buy milk', place: 'Nowhere Shop' }));
    ctx.provider.steps.push(() => text('I could not find it.'));
    await chat(c, 'remind me at Nowhere Shop');
    expect(JSON.stringify(ctx.provider.calls[1].messages.at(-1))).toContain('was not found on OpenStreetMap');
    expect((await c.get('/api/place-reminders')).data.places).toHaveLength(0);
  });

  it('place reminders can be cancelled, and only by their owner', async () => {
    const c = await signup(ctx);
    const other = await signup(ctx, 'Other');
    const p = (await c.post('/api/place-reminders', { title: 'Pick up parcel', place_name: 'Post office', lat: 0.3, lon: 32.5 })).data;
    expect((await other.del(`/api/place-reminders/${p.id}`)).status).toBe(404);
    expect((await c.del(`/api/place-reminders/${p.id}`)).status).toBe(200);
    expect((await c.get('/api/place-reminders')).data.places).toHaveLength(0);
  });
});
