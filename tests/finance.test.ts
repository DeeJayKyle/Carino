import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, text, toolCall, type TestCtx } from './helpers.ts';
import { nextDue } from '../server/services/finance.ts';

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

describe('books keep personal and business money apart', () => {
  it('a Pharmacy book has its own spending, budgets and totals', async () => {
    const c = await user();
    const ph = (await c.post('/api/money/books', { name: 'Pharmacy' })).data;
    expect((await c.post('/api/money/books', { name: 'pharmacy' })).status).toBe(400);
    expect((await c.post('/api/money/books', { name: 'Personal' })).status).toBe(400);
    await c.post('/api/expenses', { amount: 15000, category: 'food' });
    await c.post('/api/expenses', { amount: 500000, category: 'shopping', note: 'Paracetamol stock', book: ph.id });
    await c.put('/api/budgets', { category: 'food', amount: 100000 });
    await c.put('/api/budgets', { category: 'food', amount: 50000, book: 'Pharmacy' }); // same category, other book
    const personal = (await c.get('/api/money')).data;
    const pharmacy = (await c.get(`/api/money?book=${ph.id}`)).data;
    expect(personal).toMatchObject({ total: 15000, book: null });
    expect(personal.budgets.map((b: any) => b.amount)).toEqual([100000]);
    expect(pharmacy).toMatchObject({ total: 500000, book: ph.id });
    expect(pharmacy.budgets.map((b: any) => b.amount)).toEqual([50000]);
    expect(personal.books.map((b: any) => b.name)).toEqual(['Personal', 'Pharmacy']);
    // The brief and Your stuff count personal money only.
    expect((await c.get('/api/stuff')).data.money.spent).toBe(15000);
    expect((await c.get('/api/money?book=Nope')).status).toBe(400);
  });

  it('a book’s budget warnings name the book', async () => {
    const c = await user();
    const ph = (await c.post('/api/money/books', { name: 'Pharmacy' })).data;
    await c.put('/api/budgets', { category: 'total', amount: 1000, book: ph.id });
    const r = (await c.post('/api/expenses', { amount: 2000, category: 'other', book: ph.id })).data;
    expect(r.alerts[0].title).toBe('Over budget: Pharmacy: Everything');
    expect((await c.post('/api/expenses', { amount: 2000, category: 'other' })).data.alerts).toEqual([]);
  });

  it('deleting a book removes only what was in it', async () => {
    const c = await user();
    const ph = (await c.post('/api/money/books', { name: 'Pharmacy' })).data;
    await c.post('/api/expenses', { amount: 1, category: 'food' });
    await c.post('/api/expenses', { amount: 2, category: 'food', book: ph.id });
    await c.post('/api/bills', { name: 'Shop rent', amount: 300000, next_due: '2026-11-01', book: ph.id });
    await c.del(`/api/money/books/${ph.id}`);
    expect((await c.get('/api/money')).data.total).toBe(1);
    expect((await c.get('/api/reminders')).data.reminders.filter((r: any) => r.status === 'scheduled')).toHaveLength(0);
  });
});

describe('income, bills, debts and savings', () => {
  it('income shows what is left over this month', async () => {
    const c = await user();
    await c.post('/api/income', { amount: 1500000, source: 'Salary' });
    await c.post('/api/expenses', { amount: 400000, category: 'bills' });
    const m = (await c.get('/api/money')).data;
    expect(m).toMatchObject({ income: 1500000, total: 400000, net: 1100000 });
    expect(m.income_list[0]).toMatchObject({ source: 'Salary', currency: 'UGX' });
    expect((await c.post('/api/income', { amount: 1, received_on: '2027-01-01' })).status).toBe(400);
  });

  it('a monthly bill reminds on the due day, and paying it logs spending and moves it on', async () => {
    const c = await user();
    const b = (await c.post('/api/bills', { name: 'Rent', amount: 600000, next_due: '2026-10-31' })).data;
    expect(b).toMatchObject({ repeat: 'monthly', category: 'bills' });
    const rem = (await c.get('/api/reminders')).data.reminders[0];
    expect(rem.title).toBe('Bill due: Rent');
    expect(JSON.parse(rem.recurrence)).toEqual({ freq: 'monthly', interval: 1 });
    const paid = (await c.post(`/api/bills/${b.id}/pay`, {})).data;
    expect(paid.bill.next_due).toBe('2026-11-30'); // 31st → last day of November
    expect(paid.expense).toMatchObject({ amount: 600000, source: 'bill', note: 'Rent' });
    expect((await c.get('/api/money')).data.total).toBe(600000);
    await c.del(`/api/bills/${b.id}`);
    expect((await c.get('/api/money')).data.bills).toEqual([]);
    expect((await c.get('/api/reminders')).data.reminders.find((r: any) => r.id === rem.id).status).toBe('cancelled');
  });

  it('works out next due dates', () => {
    expect(nextDue('2026-01-31', 'monthly')).toBe('2026-02-28');
    expect(nextDue('2026-12-15', 'monthly')).toBe('2027-01-15');
    expect(nextDue('2028-02-29', 'yearly')).toBe('2029-02-28');
    expect(nextDue('2026-11-11', 'weekly')).toBe('2026-11-18');
  });

  it('debts go down with payments and settle at zero', async () => {
    const c = await user();
    const d = (await c.post('/api/debts', { person: 'Sam', direction: 'owed_to_me', amount: 50000 })).data;
    expect(d.left).toBe(50000);
    expect((await c.post(`/api/debts/${d.id}/pay`, { amount: 60000 })).status).toBe(400);
    expect((await c.post(`/api/debts/${d.id}/pay`, { amount: 20000 })).data).toMatchObject({ left: 30000, status: 'open' });
    expect((await c.post(`/api/debts/${d.id}/pay`, { amount: 30000 })).data).toMatchObject({ left: 0, status: 'settled' });
    expect((await c.get('/api/money')).data.debts).toEqual([]);
  });

  it('savings goals fill up and are marked reached', async () => {
    const c = await user();
    const g = (await c.post('/api/savings', { name: 'Laptop', target: 2000000, deadline: '2027-06-01' })).data;
    expect((await c.post(`/api/savings/${g.id}/move`, { amount: -1 })).status).toBe(400);
    expect((await c.post(`/api/savings/${g.id}/move`, { amount: 500000 })).data).toMatchObject({ saved: 500000, percent: 25 });
    expect((await c.post(`/api/savings/${g.id}/move`, { amount: 1500000 })).data).toMatchObject({ saved: 2000000, status: 'reached' });
  });

  it('nobody else can touch them', async () => {
    const c = await user();
    const other = await signup(ctx, 'Other');
    const b = (await c.post('/api/bills', { name: 'Rent', amount: 1, next_due: '2026-12-01' })).data;
    const d = (await c.post('/api/debts', { person: 'Sam', direction: 'i_owe', amount: 5 })).data;
    const g = (await c.post('/api/savings', { name: 'X', target: 5 })).data;
    const ph = (await c.post('/api/money/books', { name: 'Pharmacy' })).data;
    expect((await other.post(`/api/bills/${b.id}/pay`, {})).status).toBe(404);
    expect((await other.post(`/api/debts/${d.id}/pay`, { amount: 1 })).status).toBe(404);
    expect((await other.post(`/api/savings/${g.id}/move`, { amount: 1 })).status).toBe(404);
    expect((await other.del(`/api/money/books/${ph.id}`)).status).toBe(404);
    expect((await other.post('/api/expenses', { amount: 1, category: 'food', book: ph.id })).status).toBe(400);
  });
});

describe('the assistant handles all of it', () => {
  it('logs to the Pharmacy book, records income, adds and pays a bill', async () => {
    const c = await user();
    await c.post('/api/money/books', { name: 'Pharmacy' });
    ctx.provider.steps.push(
      () => toolCall('log_expense', { amount: 80000, category: 'shopping', note: 'Gloves', book: 'Pharmacy' }),
      () => toolCall('log_income', { amount: 350000, source: 'Sales', book: 'pharmacy' }),
      () => toolCall('add_bill', { name: 'Shop rent', amount: 300000, next_due: '2026-11-05', book: 'Pharmacy' }),
      () => toolCall('pay_bill', { bill: 'shop rent' }),
      () => text('Done.'),
    );
    await chat(c, 'pharmacy: gloves 80k, sales 350k, shop rent 300k monthly from the 5th — and I paid it');
    const ph = (await c.get('/api/money?book=Pharmacy')).data;
    expect(ph).toMatchObject({ income: 350000, total: 380000 });
    expect(ph.bills[0]).toMatchObject({ name: 'Shop rent', next_due: '2026-12-05' });
    expect((await c.get('/api/money')).data.total).toBe(0);
    const last = JSON.stringify(ctx.provider.calls[4].messages.at(-1));
    expect(last).toContain('2026-12-05');
  });

  it('records a debt and a savings goal; says so when a book doesn’t exist', async () => {
    const c = await user();
    ctx.provider.steps.push(
      () => toolCall('record_debt', { person: 'Sam', direction: 'i_owe', amount: 50000, due: '2026-11-30' }),
      () => toolCall('savings_goal', { name: 'Laptop', target: 2000000 }),
      () => toolCall('log_expense', { amount: 1, category: 'food', book: 'Salon' }),
      () => text('ok'),
    );
    await chat(c, 'I owe Sam 50k by the end of the month, and I want to save 2m for a laptop');
    const m = (await c.get('/api/money')).data;
    expect(m.debts[0]).toMatchObject({ person: 'Sam', direction: 'i_owe', left: 50000, due_on: '2026-11-30' });
    expect(m.goals[0]).toMatchObject({ name: 'Laptop', target: 2000000 });
    expect(JSON.stringify(ctx.provider.calls[3].messages.at(-1))).toContain('no book called');
  });
});

describe('memory controls', () => {
  it('editing the text keeps the category; personal and work are kept apart', async () => {
    const c = await signup(ctx);
    const m = (await c.post('/api/memories', { content: 'Prefers tea', category: 'preference' })).data.memory;
    expect(m.context).toBe('personal');
    expect((await c.patch(`/api/memories/${m.id}`, { content: 'Prefers green tea' })).data).toMatchObject({ content: 'Prefers green tea', category: 'preference', context: 'personal' });
    const w = (await c.post('/api/memories', { content: 'Pharmacy opens at 8', category: 'fact', context: 'work' })).data.memory;
    expect((await c.get('/api/memories?status=active&context=work')).data.memories.map((x: any) => x.id)).toEqual([w.id]);
    expect((await c.get('/api/memories?status=active&context=personal')).data.memories.map((x: any) => x.id)).toEqual([m.id]);
  });

  it('several can be deleted at once, only the user’s own', async () => {
    const c = await signup(ctx);
    const other = await signup(ctx, 'Other');
    const a = (await c.post('/api/memories', { content: 'A fact one' })).data.memory;
    const b = (await c.post('/api/memories', { content: 'A fact two' })).data.memory;
    const o = (await other.post('/api/memories', { content: 'Not yours' })).data.memory;
    expect((await c.post('/api/memories/delete', { ids: [a.id, b.id, o.id] })).data.deleted).toBe(2);
    expect((await other.get('/api/memories?status=active')).data.memories).toHaveLength(1);
  });

  it('the assistant files work memories as work, and sees which is which', async () => {
    const c = await signup(ctx);
    ctx.provider.steps.push(() => toolCall('save_memory', { content: 'The pharmacy supplier is Abacus', category: 'fact', context: 'work', user_requested: true }), () => text('Saved.'));
    await chat(c, 'remember that our pharmacy supplier is Abacus');
    ctx.provider.steps.push(() => text('Abacus.'));
    await chat(c, 'who is the pharmacy supplier?');
    expect(JSON.stringify(ctx.provider.calls.at(-1)!.messages)).toContain('[work · fact] The pharmacy supplier is Abacus');
  });
});

describe('upgrading money data', () => {
  it('budgets and expenses from before books land in Personal, unchanged', async () => {
    const { Db } = await import('../server/db/index.ts');
    const { mkdtempSync, readdirSync, copyFileSync, mkdirSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'carino-mig-'));
    const src = join(process.cwd(), 'server/db/migrations');
    const old = join(dir, 'old');
    mkdirSync(old);
    for (const f of readdirSync(src)) if (f < '017') copyFileSync(join(src, f), join(old, f));
    let db = new Db(join(dir, 'c.db'), old);
    db.run("INSERT INTO users (id, email, name, password_hash) VALUES ('u1', 'a@example.com', 'A', 'x')");
    db.run("INSERT INTO budgets (id, user_id, category, amount, currency, alerted) VALUES ('b1', 'u1', 'food', 200000, 'UGX', '2026-10:80'), ('b2', 'u1', 'total', 900, 'USD', '')");
    db.run("INSERT INTO expenses (id, user_id, amount, currency, category, spent_on, source) VALUES ('e1', 'u1', 5000, 'UGX', 'food', '2026-10-01', 'receipt')");
    db.close();
    db = new Db(join(dir, 'c.db'), src);
    expect(db.all('SELECT id, book_id, category, amount, currency, alerted FROM budgets ORDER BY id')).toEqual([
      { id: 'b1', book_id: null, category: 'food', amount: 200000, currency: 'UGX', alerted: '2026-10:80' },
      { id: 'b2', book_id: null, category: 'total', amount: 900, currency: 'USD', alerted: '' },
    ]);
    expect(db.get('SELECT book_id, source, amount FROM expenses')).toEqual({ book_id: null, source: 'receipt', amount: 5000 });
    expect(db.get("SELECT context FROM memories LIMIT 1")).toBeUndefined();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
