import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, text, type TestCtx } from './helpers.ts';
import { parseItemsJson } from '../server/services/ramble.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

describe('ramble it out', () => {
  it('sorts a brain-dump into to-dos, reminders and memories, with dates read by Carino', async () => {
    const c = await signup(ctx);
    ctx.provider.steps.push(() => text(JSON.stringify({ items: [
      { type: 'task', title: 'Order paracetamol stock', when: 'Friday', priority: 1 },
      { type: 'reminder', title: 'Call Mama', when: 'tomorrow at 5pm' },
      { type: 'memory', title: 'Idea: loyalty card for regular customers', details: 'Stamp per visit' },
      { type: 'task', title: 'Fix the shop sign' },
    ] })));
    const r = await c.post('/api/ramble/extract', { text: 'ok so I need to order paracetamol by friday, it is urgent, remind me to call mama tomorrow at 5pm, oh and a loyalty card idea, and the sign needs fixing' });
    expect(r.status).toBe(200);
    const [order, call, idea, sign] = r.data.items;
    expect(order).toMatchObject({ type: 'task', priority: 1, when_text: 'Friday', all_day: true });
    expect(order.when_iso).toBeTruthy();
    expect(call.type).toBe('reminder');
    expect(call.when_iso).toBe('2026-10-17T14:00:00.000Z'); // 17:00 in Kampala
    expect(call.when_label).toContain('17:00');
    expect(idea).toMatchObject({ type: 'memory', details: 'Stamp per visit' });
    expect(sign.when_iso).toBeUndefined();
    // The ramble was sent as untrusted content with today's date for context.
    const prompt = JSON.stringify(ctx.provider.calls[0].messages);
    expect(prompt).toContain('untrusted');
    expect(prompt).toContain('local date 2026-10-16');
    expect(ctx.provider.calls[0].tools).toEqual([]);

    const applied = await c.post('/api/ramble/apply', { items: r.data.items });
    expect(applied.status).toBe(201);
    expect(applied.data).toEqual({ tasks: 2, reminders: 1, memories: 1 });
    const all = (await c.get('/api/tasks?view=all')).data.tasks;
    expect(all.map((t: any) => t.title).sort()).toEqual(['Fix the shop sign', 'Order paracetamol stock']);
    expect(all.find((t: any) => t.title === 'Order paracetamol stock').tags).toContain('ramble');
    const mems = (await c.get('/api/memories')).data.memories;
    expect(mems[0].content).toBe('Idea: loyalty card for regular customers: Stamp per visit');
  });

  it('flags a time it cannot read, and turns a reminder without a time into a task', async () => {
    const c = await signup(ctx);
    ctx.provider.steps.push(() => text('```json\n{"items":[{"type":"reminder","title":"Renew licence"},{"type":"task","title":"Plan trip","when":"whenever the rains stop"}]}\n```'));
    const r = await c.post('/api/ramble/extract', { text: 'remind me to renew my licence, plan the trip whenever the rains stop' });
    const [renew, trip] = r.data.items;
    expect(renew.warning).toMatch(/No time was given/);
    expect(trip.when_iso).toBeNull();
    expect(trip.warning).toMatch(/couldn’t work out a date/);
    expect((await c.post('/api/ramble/apply', { items: [renew] })).data).toEqual({ tasks: 1, reminders: 0, memories: 0 });
  });

  it('explains instead of failing silently when the model reply is not usable', async () => {
    const c = await signup(ctx);
    ctx.provider.steps.push(() => text('Sure! Here is what I found: buy milk.'));
    const r = await c.post('/api/ramble/extract', { text: 'buy milk' });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/could not sort/);
    expect((await c.post('/api/ramble/extract', { text: '   ' })).status).toBe(400);
    expect((await c.post('/api/ramble/apply', { items: [] })).status).toBe(400);
  });

  it('cleans up odd model output', () => {
    const items = parseItemsJson('Here you go: {"items":[{"type":"chore","title":"  Sweep  ","priority":9,"when":""}]} hope that helps');
    expect(items).toEqual([{ type: 'task', title: 'Sweep', details: undefined, when: undefined, priority: undefined }]);
  });
});
