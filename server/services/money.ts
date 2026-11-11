import { z } from 'zod';
import type { Db, Row } from '../db/index.ts';
import type { Services } from '../context.ts';
import { nowIso } from '../db/index.ts';
import type { Settings } from './settings.ts';
import { addDays } from './time.ts';
import { notify } from './activity.ts';

/** Spending categories, in the order the app shows them. */
export const CATEGORIES = ['food', 'groceries', 'transport', 'bills', 'home', 'health', 'shopping', 'fun', 'family', 'education', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABELS: Record<Category | 'total', string> = {
  food: 'Eating out', groceries: 'Groceries', transport: 'Transport', bills: 'Bills', home: 'Home', health: 'Health',
  shopping: 'Shopping', fun: 'Fun', family: 'Family & gifts', education: 'Education', other: 'Other', total: 'Everything',
};

const REGION_CURRENCY: Record<string, string> = {
  UG: 'UGX', KE: 'KES', TZ: 'TZS', RW: 'RWF', BI: 'BIF', SS: 'SSP', ET: 'ETB', NG: 'NGN', GH: 'GHS', ZA: 'ZAR', ZM: 'ZMW', MW: 'MWK',
  CD: 'CDF', EG: 'EGP', MA: 'MAD', US: 'USD', GB: 'GBP', IE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR',
  PT: 'EUR', AT: 'EUR', FI: 'EUR', GR: 'EUR', CA: 'CAD', AU: 'AUD', NZ: 'NZD', IN: 'INR', PK: 'PKR', JP: 'JPY', CN: 'CNY', BR: 'BRL',
  MX: 'MXN', AE: 'AED', SA: 'SAR', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', TR: 'TRY', SG: 'SGD', PH: 'PHP',
};

/** The user's main currency: chosen in Settings, else guessed from the region in their locale (en-UG → UGX). */
export function currencyFor(s: Settings): string {
  if (s.money?.currency) return s.money.currency;
  const region = s.regional.locale.split('-')[1]?.toUpperCase();
  return (region && REGION_CURRENCY[region]) || 'USD';
}

export function formatMoney(amount: number, currency: string, locale = 'en-GB'): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'code', maximumFractionDigits: amount % 1 ? 2 : 0 }).format(amount).replace(/ /g, ' ');
  } catch {
    return `${currency} ${Math.round(amount * 100) / 100}`;
  }
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-11');
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code like UGX');

export const expenseInput = z.object({
  amount: z.number().positive().max(1e12),
  currency: currency.optional(),
  category: z.enum(CATEGORIES).default('other'),
  note: z.string().trim().max(300).optional(),
  merchant: z.string().trim().max(120).optional(),
  spent_on: day.optional(),
  source: z.enum(['manual', 'chat', 'receipt']).default('manual'),
});

/**
 * An edit changes only the fields sent. (No defaults here: a default would quietly overwrite the
 * stored value, e.g. reset the category when only the amount changes.) The source — chat, receipt
 * or manual — is never changed by an edit.
 */
export const expensePatch = z.object({
  amount: z.number().positive().max(1e12),
  currency,
  category: z.enum(CATEGORIES),
  note: z.string().trim().max(300),
  merchant: z.string().trim().max(120),
  spent_on: day,
}).partial().strict();

/** What a budget check found after spending was added: warnings sent at 80% and when it goes over. */
export interface BudgetAlert { category: Category | 'total'; level: 80 | 100; spent: number; amount: number; currency: string; title: string; body: string }

export class MoneyError extends Error {}

/** Which book: null is the Personal book (where everything from before books lives). */
export type Book = string | null;
const inBook = (book: Book): [string, (string)[]] => (book ? ['book_id = ?', [book]] : ['book_id IS NULL', []]);

function notFuture(day: string | undefined, today: string) {
  if (day && day > today) throw new MoneyError('That date is in the future. Spending is logged on the day it happened.');
}

/** Same amount, category and day logged in the last 10 minutes: probably the same purchase twice. */
export function findDuplicate(db: Db, userId: string, e: { amount: number; currency: string; category: string; spent_on: string }, now: Date, exceptId?: string, book: Book = null) {
  const [bw, bp] = inBook(book);
  return db.get(
    `SELECT * FROM expenses WHERE user_id = ? AND ${bw} AND amount = ? AND currency = ? AND category = ? AND spent_on = ? AND created_at >= ?${exceptId ? ' AND id <> ?' : ''} ORDER BY created_at DESC LIMIT 1`,
    userId, ...bp, e.amount, e.currency, e.category, e.spent_on, new Date(now.getTime() - 10 * 60_000).toISOString(), ...(exceptId ? [exceptId] : []),
  ) ?? null;
}

export function addExpense(db: Db, userId: string, raw: unknown, ctx: { today: string; currency: string; locale?: string; now?: Date; book?: Book; source?: string }) {
  const i = expenseInput.parse(raw);
  notFuture(i.spent_on, ctx.today);
  const book = ctx.book ?? null;
  const values = { amount: i.amount, currency: i.currency ?? ctx.currency, category: i.category, spent_on: i.spent_on ?? ctx.today };
  const duplicate = ctx.now ? findDuplicate(db, userId, values, ctx.now, undefined, book) : null;
  const row = db.insert('expenses', {
    user_id: userId, book_id: book, ...values, note: i.note ?? '', merchant: i.merchant ?? '', source: ctx.source ?? i.source, updated_at: nowIso(),
  });
  const alerts = checkBudgets(db, userId, String(row.spent_on).slice(0, 7), ctx.today, ctx.locale, book);
  return { expense: row, alerts, possible_duplicate: duplicate ? { id: String(duplicate.id), created_at: String(duplicate.created_at) } : null };
}

export function updateExpense(db: Db, userId: string, id: string, raw: unknown, ctx: { today: string; locale?: string }) {
  const i = expensePatch.parse(raw);
  notFuture(i.spent_on, ctx.today);
  const before = db.getOwned('expenses', userId, id);
  if (!before) return null;
  const row = db.updateOwned('expenses', userId, id, { ...i }, true);
  // A bigger amount (or a move to another category or month) can cross a budget line.
  const alerts = row ? checkBudgets(db, userId, String(row.spent_on).slice(0, 7), ctx.today, ctx.locale, (row.book_id as string | null) ?? null) : [];
  return row ? { expense: row, alerts } : null;
}

export function deleteExpense(db: Db, userId: string, id: string) {
  return Number(db.run('DELETE FROM expenses WHERE id = ? AND user_id = ?', id, userId).changes) > 0;
}

export const budgetInput = z.object({
  category: z.enum([...CATEGORIES, 'total']),
  amount: z.number().min(0).max(1e12), // 0 removes the budget
  currency: currency.optional(),
});

export function setBudget(db: Db, userId: string, raw: unknown, mainCurrency: string, book: Book = null): Row | null {
  const i = budgetInput.parse(raw);
  const [bw, bp] = inBook(book);
  if (i.amount === 0) {
    db.run(`DELETE FROM budgets WHERE user_id = ? AND ${bw} AND category = ?`, userId, ...bp, i.category);
    return null;
  }
  const cur = i.currency ?? mainCurrency;
  const existing = db.get(`SELECT id FROM budgets WHERE user_id = ? AND ${bw} AND category = ?`, userId, ...bp, i.category);
  if (existing) {
    // A new amount gets fresh warnings.
    db.run("UPDATE budgets SET amount = ?, currency = ?, alerted = '', updated_at = ? WHERE id = ?", i.amount, cur, nowIso(), existing.id);
    return db.get('SELECT * FROM budgets WHERE id = ?', existing.id)!;
  }
  return db.insert('budgets', { user_id: userId, book_id: book, category: i.category, amount: i.amount, currency: cur });
}

const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** Totals per currency and category for spending between two local dates (inclusive). */
function totals(db: Db, userId: string, from: string, to: string, book: Book) {
  const [bw, bp] = inBook(book);
  return db.all(
    `SELECT currency, category, SUM(amount) AS total, COUNT(*) AS n FROM expenses
     WHERE user_id = ? AND ${bw} AND spent_on >= ? AND spent_on <= ? GROUP BY currency, category`,
    userId, ...bp, from, to,
  ).map((r) => ({ currency: String(r.currency), category: String(r.category) as Category, total: Number(r.total), n: Number(r.n) }));
}

/**
 * A month of spending in the main currency, with each budget's progress. Spending in other
 * currencies is listed separately rather than converted (no exchange rates are guessed).
 */
export function monthSummary(db: Db, userId: string, month: string, today: string, mainCurrency: string, book: Book = null) {
  const from = `${month}-01`;
  const to = monthEnd(month);
  const rows = totals(db, userId, from, to, book);
  const [bw, bp] = inBook(book);
  const main = rows.filter((r) => r.currency === mainCurrency);
  const byCategory = CATEGORIES.map((c) => ({ category: c, label: CATEGORY_LABELS[c], total: main.find((r) => r.category === c)?.total ?? 0 }))
    .filter((c) => c.total > 0).sort((a, b) => b.total - a.total);
  const total = main.reduce((a, r) => a + r.total, 0);
  const other = Object.entries(rows.filter((r) => r.currency !== mainCurrency).reduce<Record<string, number>>((a, r) => ({ ...a, [r.currency]: (a[r.currency] ?? 0) + r.total }), {}))
    .map(([cur, t]) => ({ currency: cur, total: t }));
  const daysInMonth = Number(to.slice(8));
  const isCurrent = today.slice(0, 7) === month;
  const daysLeft = isCurrent ? daysInMonth - Number(today.slice(8)) + 1 : 0;
  const budgets = db.all(`SELECT * FROM budgets WHERE user_id = ? AND ${bw} ORDER BY category = 'total' DESC, category`, userId, ...bp).map((b) => {
    const cat = String(b.category) as Category | 'total';
    const spent = b.currency === mainCurrency || rows.some((r) => r.currency === b.currency)
      ? rows.filter((r) => r.currency === b.currency && (cat === 'total' || r.category === cat)).reduce((a, r) => a + r.total, 0)
      : 0;
    const amount = Number(b.amount);
    return {
      id: String(b.id), category: cat, label: CATEGORY_LABELS[cat] ?? cat, amount, currency: String(b.currency), spent,
      left: amount - spent, percent: amount > 0 ? Math.round((spent / amount) * 100) : 0,
      perDayLeft: isCurrent && daysLeft > 0 && amount > spent ? (amount - spent) / daysLeft : null,
    };
  });
  const income = Number(db.get(`SELECT COALESCE(SUM(amount), 0) AS s FROM income WHERE user_id = ? AND ${bw} AND currency = ? AND received_on >= ? AND received_on <= ?`, userId, ...bp, mainCurrency, from, to)!.s);
  return { month, currency: mainCurrency, total, count: main.reduce((a, r) => a + r.n, 0), byCategory, other, budgets, daysLeft, income, net: income - total };
}

/** The last 7 days (ending today) against the 7 before, in the main currency. */
export function weekSummary(db: Db, userId: string, today: string, mainCurrency: string, book: Book = null) {
  const sum = (from: string, to: string) => totals(db, userId, from, to, book).filter((r) => r.currency === mainCurrency);
  const week = sum(addDays(today, -6), today);
  const prev = sum(addDays(today, -13), addDays(today, -7));
  const total = week.reduce((a, r) => a + r.total, 0);
  const before = prev.reduce((a, r) => a + r.total, 0);
  const byCat = new Map<Category, number>();
  for (const r of week) byCat.set(r.category, (byCat.get(r.category) ?? 0) + r.total);
  const top = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0];
  return { currency: mainCurrency, total, previous: before, count: week.reduce((a, r) => a + r.n, 0), top: top ? { category: top[0], label: CATEGORY_LABELS[top[0]], total: top[1] } : null };
}

/**
 * Warns once per month per budget at 80% and again when it goes over. Only the month that the
 * spending landed in is checked, and only while it is the current month.
 */
export function checkBudgets(db: Db, userId: string, month: string, today: string, locale = 'en-GB', book: Book = null): BudgetAlert[] {
  if (today.slice(0, 7) !== month) return [];
  const out: BudgetAlert[] = [];
  const [bw, bp] = inBook(book);
  const bookName = book ? String(db.get('SELECT name FROM money_books WHERE id = ?', book)?.name ?? '') : '';
  for (const b of db.all(`SELECT * FROM budgets WHERE user_id = ? AND ${bw}`, userId, ...bp)) {
    const cat = String(b.category) as Category | 'total';
    const spent = Number(db.get(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE user_id = ? AND ${bw} AND currency = ? AND spent_on >= ? AND spent_on <= ?${cat === 'total' ? '' : ' AND category = ?'}`,
      userId, ...bp, b.currency, `${month}-01`, monthEnd(month), ...(cat === 'total' ? [] : [cat]),
    )!.s);
    const amount = Number(b.amount);
    const level: 0 | 80 | 100 = spent > amount ? 100 : spent >= amount * 0.8 ? 80 : 0;
    if (!level) continue;
    const [m, done] = String(b.alerted).split(':');
    if (m === month && Number(done) >= level) continue;
    db.run('UPDATE budgets SET alerted = ? WHERE id = ?', `${month}:${level}`, b.id);
    const label = `${bookName ? `${bookName}: ` : ''}${CATEGORY_LABELS[cat] ?? cat}`;
    const money = (n: number) => formatMoney(n, String(b.currency), locale);
    const n = level === 100
      ? { title: `Over budget: ${label}`, body: `${money(spent)} spent this month, ${money(spent - amount)} over the ${money(amount)} budget.` }
      : { title: `${label}: ${Math.round((spent / amount) * 100)}% of budget used`, body: `${money(amount - spent)} left of ${money(amount)} this month.` };
    notify(db, userId, { kind: 'budget', ...n, link: '/money' });
    out.push({ category: cat, level, spent, amount, currency: String(b.currency), ...n });
  }
  return out;
}

export function listExpenses(db: Db, userId: string, opts: { from: string; to: string; limit?: number; book?: Book }) {
  const [bw, bp] = inBook(opts.book ?? null);
  return db.all(
    `SELECT * FROM expenses WHERE user_id = ? AND ${bw} AND spent_on >= ? AND spent_on <= ? ORDER BY spent_on DESC, created_at DESC LIMIT ?`,
    userId, ...bp, opts.from, opts.to, opts.limit ?? 200,
  );
}

export { monthEnd };

/** Rings the phone (or sends a push) for budget warnings; they are already in the app's notifications. */
export async function pushAlerts(services: Services, userId: string, alerts: BudgetAlert[]) {
  for (const a of alerts) {
    await services.push.sendToUser(userId, { title: a.title, body: a.body, url: '/money', tag: `budget-${a.category}` }).catch(() => undefined);
  }
}
