import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, text, toolCall, type TestCtx } from './helpers.ts';
import { currencyFor, formatMoney } from '../server/services/money.ts';
import { settingsSchema } from '../server/services/settings.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

async function user() {
  const c = await signup(ctx);
  await c.patch('/api/settings', { money: { currency: 'UGX' } });
  return c;
}
async function chat(c: Awaited<ReturnType<typeof signup>>, message: string) {
  const conv = (await c.post('/api/conversations', {})).data;
  await c.post(`/api/conversations/${conv.id}/messages`, { text: message });
}

describe('currency', () => {
  it('comes from Settings, else from the region', () => {
    const s = settingsSchema.parse({});
    expect(currencyFor({ ...s, regional: { ...s.regional, locale: 'en-UG' } })).toBe('UGX');
    expect(currencyFor({ ...s, regional: { ...s.regional, locale: 'sw-KE' } })).toBe('KES');
    expect(currencyFor({ ...s, regional: { ...s.regional, locale: 'en' } })).toBe('USD');
    expect(currencyFor({ ...s, money: { currency: 'EUR' } })).toBe('EUR');
    expect(formatMoney(15000, 'UGX', 'en-GB')).toBe('UGX 15,000');
    expect(formatMoney(12.5, 'USD', 'en-GB')).toBe('USD 12.50');
  });
});

describe('expenses and budgets', () => {
  it('adds, totals by category, and deletes', async () => {
    const c = await user();
    // 2026-10-16 in Kampala
    await c.post('/api/expenses', { amount: 15000, category: 'food', note: 'Lunch' });
    await c.post('/api/expenses', { amount: 5000, category: 'transport', spent_on: '2026-10-14' });
    const e = (await c.post('/api/expenses', { amount: 40000, category: 'food' })).data.expense;
    let m = (await c.get('/api/money')).data;
    expect(m).toMatchObject({ month: '2026-10', currency: 'UGX', total: 60000, count: 3, today: '2026-10-16' });
    expect(m.byCategory.map((x: any) => [x.category, x.total])).toEqual([['food', 55000], ['transport', 5000]]);
    expect(m.week).toMatchObject({ total: 60000, top: { category: 'food', total: 55000 } });
    expect(m.expenses).toHaveLength(3);
    await c.del(`/api/expenses/${e.id}`);
    m = (await c.get('/api/money')).data;
    expect(m.total).toBe(20000);
    expect((await c.get('/api/money?month=2026-09')).data.total).toBe(0);
  });

  it('keeps other currencies apart instead of guessing a rate', async () => {
    const c = await user();
    await c.post('/api/expenses', { amount: 10000, category: 'food' });
    await c.post('/api/expenses', { amount: 20, currency: 'usd', category: 'bills' });
    const m = (await c.get('/api/money')).data;
    expect(m.total).toBe(10000);
    expect(m.other).toEqual([{ currency: 'USD', total: 20 }]);
  });

  it('rejects bad input and other people\'s expenses', async () => {
    const c = await user();
    const other = await signup(ctx, 'Other');
    expect((await c.post('/api/expenses', { amount: -5, category: 'food' })).status).toBe(400);
    expect((await c.post('/api/expenses', { amount: 5, category: 'yachts' })).status).toBe(400);
    const e = (await c.post('/api/expenses', { amount: 5000, category: 'food' })).data.expense;
    expect((await other.del(`/api/expenses/${e.id}`)).status).toBe(404);
    expect((await other.patch(`/api/expenses/${e.id}`, { amount: 1 })).status).toBe(404);
    expect((await other.get('/api/money')).data.total).toBe(0);
    expect((await c.patch(`/api/expenses/${e.id}`, { category: 'groceries' })).data.category).toBe('groceries');
  });

  it('warns once at 80% and again when over, with a phone notification', async () => {
    const c = await user();
    await c.put('/api/budgets', { category: 'food', amount: 100000 });
    expect((await c.post('/api/expenses', { amount: 50000, category: 'food' })).data.alerts).toEqual([]);
    const near = (await c.post('/api/expenses', { amount: 30000, category: 'food' })).data.alerts;
    expect(near).toMatchObject([{ category: 'food', level: 80 }]);
    expect((await c.post('/api/expenses', { amount: 5000, category: 'food' })).data.alerts).toEqual([]); // 85%: already warned
    const over = (await c.post('/api/expenses', { amount: 20000, category: 'food' })).data.alerts;
    expect(over).toMatchObject([{ level: 100, title: 'Over budget: Eating out' }]);
    expect(over[0].body).toContain('UGX 5,000 over');
    const notes = (await c.get('/api/notifications')).data.notifications.filter((n: any) => n.kind === 'budget');
    expect(notes).toHaveLength(2);
    const b = (await c.get('/api/money')).data.budgets[0];
    expect(b).toMatchObject({ category: 'food', spent: 105000, left: -5000, percent: 105 });
    // other categories don't count towards it
    expect((await c.post('/api/expenses', { amount: 999999, category: 'bills' })).data.alerts).toEqual([]);
  });

  it('a total budget counts everything; 0 removes a budget', async () => {
    const c = await user();
    await c.put('/api/budgets', { category: 'total', amount: 50000 });
    await c.post('/api/expenses', { amount: 30000, category: 'food' });
    await c.post('/api/expenses', { amount: 15000, category: 'transport' });
    let b = (await c.get('/api/money')).data.budgets;
    expect(b[0]).toMatchObject({ category: 'total', spent: 45000, percent: 90 });
    expect(b[0].perDayLeft).toBeCloseTo(5000 / 16); // 16 days left in October, today included
    await c.put('/api/budgets', { category: 'total', amount: 0 });
    b = (await c.get('/api/money')).data.budgets;
    expect(b).toEqual([]);
  });

  it('shows in Your stuff and the daily brief', async () => {
    const c = await user();
    await c.put('/api/budgets', { category: 'fun', amount: 10000 });
    await c.post('/api/expenses', { amount: 25000, category: 'fun', note: 'Concert' });
    expect((await c.get('/api/stuff')).data.money).toEqual({ spent: 25000, currency: 'UGX', budgets: 1, over: 1 });
    const brief = (await c.get('/api/dashboard')).data.briefing as string;
    expect(brief).toContain('In the last 7 days you spent UGX 25,000, most on Fun (UGX 25,000).');
    expect(brief).toContain('Over budget this month: Fun.');
    const data = (await c.get('/api/export')).data;
    expect(data.expenses).toHaveLength(1);
    expect(data.budgets).toHaveLength(1);
  });

  it('the brief says nothing about money when there is none', async () => {
    const c = await user();
    expect((await c.get('/api/dashboard')).data.briefing).not.toContain('spent');
  });
});

describe('the assistant handles money', () => {
  it('logs spending from chat, with "yesterday", and reports the budget', async () => {
    const c = await user();
    await c.put('/api/budgets', { category: 'food', amount: 200000 });
    ctx.provider.steps.push(() => toolCall('log_expense', { amount: 15000, category: 'food', note: 'Lunch', date: 'yesterday' }));
    ctx.provider.steps.push(() => text('Logged.'));
    await chat(c, 'spent 15k on lunch yesterday');
    const e = (await c.get('/api/money')).data.expenses[0];
    expect(e).toMatchObject({ amount: 15000, currency: 'UGX', category: 'food', note: 'Lunch', spent_on: '2026-10-15', source: 'chat' });
    const result = JSON.stringify(ctx.provider.calls[1].messages.at(-1));
    expect(result).toContain('UGX 15,000');
    expect(result).toContain('Eating out: UGX 15,000 of UGX 200,000 (8%)');
  });

  it('logs a receipt total and refuses future dates', async () => {
    const c = await user();
    ctx.provider.steps.push(() => toolCall('log_expense', { amount: 87500, category: 'groceries', merchant: 'Capital Shoppers', source: 'receipt', date: '2026-10-16' }));
    ctx.provider.steps.push(() => toolCall('log_expense', { amount: 100, category: 'food', date: '2026-12-01' }));
    ctx.provider.steps.push(() => text('Done.'));
    await chat(c, '[photo of a receipt]');
    const list = (await c.get('/api/money')).data.expenses;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ merchant: 'Capital Shoppers', source: 'receipt', amount: 87500 });
    expect(JSON.stringify(ctx.provider.calls[2].messages.at(-1))).toContain('in the future');
  });

  it('sets a budget and summarises spending', async () => {
    const c = await user();
    await c.post('/api/expenses', { amount: 12000, category: 'transport', note: 'Boda' });
    ctx.provider.steps.push(() => toolCall('set_budget', { category: 'transport', amount: 100000 }));
    ctx.provider.steps.push(() => toolCall('spending_summary', { period: 'this_month', category: 'transport' }));
    ctx.provider.steps.push(() => text('Here it is.'));
    await chat(c, 'budget 100k for transport, and how much have I spent on it?');
    expect((await c.get('/api/money')).data.budgets[0]).toMatchObject({ category: 'transport', amount: 100000, currency: 'UGX' });
    const summary = JSON.stringify(ctx.provider.calls[2].messages.at(-1));
    expect(summary).toContain('Transport: UGX 12,000 of UGX 100,000 (12%)');
    expect(summary).toContain('Boda');
  });
});
