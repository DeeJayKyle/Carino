import { z } from 'zod';
import type { Db, Row } from '../db/index.ts';
import { nowIso } from '../db/index.ts';
import { notFound } from '../context.ts';
import { addDays, startOfLocalDay } from './time.ts';
import { CATEGORIES, MoneyError, addExpense, type Book } from './money.ts';
import { createReminder } from './tasks.ts';

/**
 * Money beyond day-to-day spending: separate books (Personal is the default, with no id; others
 * such as "Pharmacy" are kept fully apart), income, recurring bills, debts and savings goals.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-11');
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code like UGX');
const amount = z.number().positive().max(1e12);
const notFuture = (d: string | undefined, today: string, what: string) => {
  if (d && d > today) throw new MoneyError(`That date is in the future. ${what} are recorded on the day they happened.`);
};
const inBook = (book: Book): [string, string[]] => (book ? ['book_id = ?', [book]] : ['book_id IS NULL', []]);

// ---------- Books ----------

export function listBooks(db: Db, userId: string) {
  return [{ id: null as string | null, name: 'Personal', currency: null as string | null }, ...db.all('SELECT id, name, currency FROM money_books WHERE user_id = ? ORDER BY created_at', userId).map((b) => ({ id: String(b.id), name: String(b.name), currency: (b.currency as string | null) ?? null }))];
}

export function createBook(db: Db, userId: string, raw: unknown) {
  const i = z.object({ name: z.string().trim().min(1).max(40), currency: currency.optional() }).parse(raw);
  if (/^personal$/i.test(i.name)) throw new MoneyError('“Personal” is the main book already.');
  if (db.get('SELECT 1 FROM money_books WHERE user_id = ? AND lower(name) = lower(?)', userId, i.name)) throw new MoneyError(`There is already a book called “${i.name}”.`);
  if (Number(db.get('SELECT COUNT(*) AS n FROM money_books WHERE user_id = ?', userId)!.n) >= 10) throw new MoneyError('Up to 10 books.');
  return db.insert('money_books', { user_id: userId, name: i.name, currency: i.currency ?? null });
}

/** A book id from the app or the assistant: an id, a name ("Pharmacy"), or empty/"personal" for Personal. */
export function resolveBook(db: Db, userId: string, ref: string | null | undefined): Book {
  if (!ref || /^personal$/i.test(ref)) return null;
  const b = db.get('SELECT id FROM money_books WHERE user_id = ? AND (id = ? OR lower(name) = lower(?))', userId, ref, ref);
  if (!b) throw new MoneyError(`There is no book called “${ref}”. Books: ${listBooks(db, userId).map((x) => x.name).join(', ')}.`);
  return String(b.id);
}

/** Deleting a book deletes everything recorded in it (the Personal book can't be deleted). */
export function deleteBook(db: Db, userId: string, id: string) {
  const b = db.getOwned('money_books', userId, id);
  if (!b) throw notFound('Book');
  // Its bills' reminders stop too (reminders live outside the book).
  db.run("UPDATE reminders SET status = 'cancelled' WHERE user_id = ? AND id IN (SELECT reminder_id FROM bills WHERE book_id = ? AND reminder_id IS NOT NULL)", userId, id);
  db.run('DELETE FROM money_books WHERE id = ? AND user_id = ?', id, userId);
  return { deleted: true };
}

// ---------- Income ----------

export const incomeInput = z.object({ amount, currency: currency.optional(), source: z.string().trim().max(120).optional(), note: z.string().trim().max(300).optional(), received_on: day.optional() });

export function addIncome(db: Db, userId: string, raw: unknown, ctx: { today: string; currency: string; book: Book }) {
  const i = incomeInput.parse(raw);
  notFuture(i.received_on, ctx.today, 'Earnings');
  return db.insert('income', {
    user_id: userId, book_id: ctx.book, amount: i.amount, currency: i.currency ?? ctx.currency, source: i.source ?? '', note: i.note ?? '', received_on: i.received_on ?? ctx.today,
  });
}

export function listIncome(db: Db, userId: string, book: Book, from: string, to: string) {
  const [bw, bp] = inBook(book);
  return db.all(`SELECT * FROM income WHERE user_id = ? AND ${bw} AND received_on >= ? AND received_on <= ? ORDER BY received_on DESC, created_at DESC LIMIT 200`, userId, ...bp, from, to);
}

export function deleteIncome(db: Db, userId: string, id: string) {
  return Number(db.run('DELETE FROM income WHERE id = ? AND user_id = ?', id, userId).changes) > 0;
}

// ---------- Recurring bills ----------

export const BILL_REPEATS = ['weekly', 'monthly', 'yearly'] as const;
export const billInput = z.object({
  name: z.string().trim().min(1).max(120), amount, currency: currency.optional(),
  category: z.enum(CATEGORIES).default('bills'), repeat: z.enum(BILL_REPEATS).default('monthly'), next_due: day,
  remind: z.boolean().default(true),
});

export function nextDue(date: string, repeat: (typeof BILL_REPEATS)[number]) {
  const [y, m, d] = date.split('-').map(Number);
  if (repeat === 'weekly') return addDays(date, 7);
  if (repeat === 'yearly') return new Date(Date.UTC(y + 1, m - 1, Math.min(d, daysIn(y + 1, m)))).toISOString().slice(0, 10);
  // Monthly keeps the day, or the month's last day (a bill due on the 31st is due on 30 April).
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, daysIn(ny, nm))).padStart(2, '0')}`;
}
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** A reminder for the bill at 9:00 on the due day, repeating like the bill (uses the normal reminders). */
function billReminder(db: Db, userId: string, b: { name: string; next_due: string; repeat: string }, timeZone: string) {
  const at = new Date(startOfLocalDay(b.next_due, timeZone).getTime() + 9 * 3600_000).toISOString();
  const rule = b.repeat === 'weekly' ? { freq: 'weekly', interval: 1 } : b.repeat === 'yearly' ? { freq: 'yearly', interval: 1 } : { freq: 'monthly', interval: 1 };
  return createReminder(db, userId, { title: `Bill due: ${b.name}`, remind_at: at, recurrence: rule });
}

export function addBill(db: Db, userId: string, raw: unknown, ctx: { currency: string; book: Book; timeZone: string; now: Date }) {
  const i = billInput.parse(raw);
  const bill = db.insert('bills', {
    user_id: userId, book_id: ctx.book, name: i.name, amount: i.amount, currency: i.currency ?? ctx.currency, category: i.category, repeat: i.repeat, next_due: i.next_due,
  });
  if (i.remind && startOfLocalDay(i.next_due, ctx.timeZone).getTime() + 9 * 3600_000 > ctx.now.getTime()) {
    const r = billReminder(db, userId, { name: i.name, next_due: i.next_due, repeat: i.repeat }, ctx.timeZone);
    db.run('UPDATE bills SET reminder_id = ? WHERE id = ?', r.id, bill.id);
  }
  return db.get('SELECT * FROM bills WHERE id = ?', bill.id)!;
}

export function listBills(db: Db, userId: string, book: Book) {
  const [bw, bp] = inBook(book);
  return db.all(`SELECT * FROM bills WHERE user_id = ? AND ${bw} AND status = 'active' ORDER BY next_due`, userId, ...bp);
}

/** Paying a bill records the spending (in the bill's book) and moves it to its next due date. */
export function payBill(db: Db, userId: string, id: string, ctx: { today: string; locale?: string; now: Date; paidOn?: string; amount?: number }) {
  const b = db.getOwned('bills', userId, id);
  if (!b) throw notFound('Bill');
  const paidOn = ctx.paidOn ?? ctx.today;
  const { expense, alerts } = addExpense(db, userId, { amount: ctx.amount ?? Number(b.amount), currency: b.currency, category: b.category, note: String(b.name), spent_on: paidOn }, {
    today: ctx.today, currency: String(b.currency), locale: ctx.locale, book: (b.book_id as string | null) ?? null, source: 'bill',
  });
  const next = nextDue(String(b.next_due), b.repeat as any);
  db.run('UPDATE bills SET last_paid_on = ?, next_due = ?, updated_at = ? WHERE id = ?', paidOn, next, nowIso(), id);
  return { bill: db.get('SELECT * FROM bills WHERE id = ?', id)!, expense, alerts };
}

export function stopBill(db: Db, userId: string, id: string) {
  const b = db.getOwned('bills', userId, id);
  if (!b) throw notFound('Bill');
  db.run("UPDATE bills SET status = 'paused', updated_at = ? WHERE id = ?", nowIso(), id);
  if (b.reminder_id) db.run("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND user_id = ?", b.reminder_id, userId);
  return { stopped: true };
}

/** Bills due within `days` days (or overdue), across all books, for the brief. */
export function billsDueSoon(db: Db, userId: string, today: string, days = 3) {
  return db.all(
    `SELECT b.*, mb.name AS book_name FROM bills b LEFT JOIN money_books mb ON mb.id = b.book_id
     WHERE b.user_id = ? AND b.status = 'active' AND b.next_due <= ? ORDER BY b.next_due`,
    userId, addDays(today, days),
  );
}

// ---------- Debts ----------

export const debtInput = z.object({
  person: z.string().trim().min(1).max(120), direction: z.enum(['i_owe', 'owed_to_me']), amount, currency: currency.optional(),
  due_on: day.optional(), note: z.string().trim().max(300).optional(),
});

export function addDebt(db: Db, userId: string, raw: unknown, ctx: { currency: string; book: Book }) {
  const i = debtInput.parse(raw);
  return presentDebt(db, db.insert('debts', { user_id: userId, book_id: ctx.book, person: i.person, direction: i.direction, amount: i.amount, currency: i.currency ?? ctx.currency, due_on: i.due_on ?? null, note: i.note ?? '' }));
}

export function presentDebt(db: Db, d: Row): Row & { paid: number; left: number } {
  const paid = Number(db.get('SELECT COALESCE(SUM(amount), 0) AS s FROM debt_payments WHERE debt_id = ?', d.id)!.s);
  return { ...d, paid, left: Math.max(0, Number(d.amount) - paid) };
}

export function listDebts(db: Db, userId: string, book: Book, includeSettled = false) {
  const [bw, bp] = inBook(book);
  return db.all(`SELECT * FROM debts WHERE user_id = ? AND ${bw}${includeSettled ? '' : " AND status = 'open'"} ORDER BY due_on IS NULL, due_on, created_at`, userId, ...bp).map((d) => presentDebt(db, d));
}

/** A payment towards a debt (either way); it's settled when nothing is left. */
export function payDebt(db: Db, userId: string, id: string, raw: unknown, today: string) {
  const d = db.getOwned('debts', userId, id);
  if (!d) throw notFound('Debt');
  const i = z.object({ amount, paid_on: day.optional() }).parse(raw);
  notFuture(i.paid_on, today, 'Payments');
  const left = presentDebt(db, d).left;
  if (i.amount > left + 1e-9) throw new MoneyError(`That's more than what's left (${left}).`);
  db.insert('debt_payments', { user_id: userId, debt_id: id, amount: i.amount, paid_on: i.paid_on ?? today });
  const now = presentDebt(db, d);
  if (now.left <= 1e-9) db.run("UPDATE debts SET status = 'settled', updated_at = ? WHERE id = ?", nowIso(), id);
  return presentDebt(db, db.get('SELECT * FROM debts WHERE id = ?', id)!);
}

// ---------- Savings goals ----------

export const goalInput = z.object({ name: z.string().trim().min(1).max(120), target: amount, currency: currency.optional(), deadline: day.optional() });

export function addGoal(db: Db, userId: string, raw: unknown, ctx: { currency: string; book: Book }) {
  const i = goalInput.parse(raw);
  return presentGoal(db, db.insert('savings_goals', { user_id: userId, book_id: ctx.book, name: i.name, target: i.target, currency: i.currency ?? ctx.currency, deadline: i.deadline ?? null }));
}

export function presentGoal(db: Db, g: Row): Row & { saved: number; percent: number } {
  const saved = Number(db.get('SELECT COALESCE(SUM(amount), 0) AS s FROM savings_moves WHERE goal_id = ?', g.id)!.s);
  return { ...g, saved, percent: Number(g.target) > 0 ? Math.min(100, Math.round((saved / Number(g.target)) * 100)) : 0 };
}

export function listGoals(db: Db, userId: string, book: Book) {
  const [bw, bp] = inBook(book);
  return db.all(`SELECT * FROM savings_goals WHERE user_id = ? AND ${bw} AND status <> 'archived' ORDER BY created_at`, userId, ...bp).map((g) => presentGoal(db, g));
}

/** Money put towards a goal (or taken out, with a negative amount). */
export function moveSavings(db: Db, userId: string, id: string, raw: unknown, today: string) {
  const g = db.getOwned('savings_goals', userId, id);
  if (!g) throw notFound('Savings goal');
  const i = z.object({ amount: z.number().refine((n) => n !== 0 && Math.abs(n) <= 1e12, 'Enter an amount'), moved_on: day.optional() }).parse(raw);
  notFuture(i.moved_on, today, 'Savings');
  if (i.amount < 0 && presentGoal(db, g).saved + i.amount < -1e-9) throw new MoneyError('That’s more than is saved.');
  db.insert('savings_moves', { user_id: userId, goal_id: id, amount: i.amount, moved_on: i.moved_on ?? today });
  const now = presentGoal(db, g);
  db.run('UPDATE savings_goals SET status = ?, updated_at = ? WHERE id = ?', now.saved >= Number(g.target) ? 'reached' : 'active', nowIso(), id);
  return presentGoal(db, db.get('SELECT * FROM savings_goals WHERE id = ?', id)!);
}
