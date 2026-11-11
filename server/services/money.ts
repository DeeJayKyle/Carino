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

export const expensePatch = expenseInput.omit({ source: true }).partial();

/** What a budget check found after spending was added: warnings sent at 80% and when it goes over. */
export interface BudgetAlert { category: Category | 'total'; level: 80 | 100; spent: number; amount: number; currency: string; title: string; body: string }

export function addExpense(db: Db, userId: string, raw: unknown, ctx: { today: string; currency: string; locale?: string }) {
  const i = expenseInput.parse(raw);
  const row = db.insert('expenses', {
    user_id: userId, amount: i.amount, currency: i.currency ?? ctx.currency, category: i.category,
    note: i.note ?? '', merchant: i.merchant ?? '', spent_on: i.spent_on ?? ctx.today, source: i.source,
  });
  const alerts = checkBudgets(db, userId, String(row.spent_on).slice(0, 7), ctx.today, ctx.locale);
  return { expense: row, alerts };
}

export function updateExpense(db: Db, userId: string, id: string, raw: unknown) {
  const i = expensePatch.parse(raw);
  return db.updateOwned('expenses', userId, id, { ...i }, false);
}

export function deleteExpense(db: Db, userId: string, id: string) {
  return Number(db.run('DELETE FROM expenses WHERE id = ? AND user_id = ?', id, userId).changes) > 0;
}

export const budgetInput = z.object({
  category: z.enum([...CATEGORIES, 'total']),
  amount: z.number().min(0).max(1e12), // 0 removes the budget
  currency: currency.optional(),
});

export function setBudget(db: Db, userId: string, raw: unknown, mainCurrency: string): Row | null {
  const i = budgetInput.parse(raw);
  if (i.amount === 0) {
    db.run('DELETE FROM budgets WHERE user_id = ? AND category = ?', userId, i.category);
    return null;
  }
  const cur = i.currency ?? mainCurrency;
  const existing = db.get('SELECT id FROM budgets WHERE user_id = ? AND category = ?', userId, i.category);
  if (existing) {
    // A new amount gets fresh warnings.
    db.run("UPDATE budgets SET amount = ?, currency = ?, alerted = '', updated_at = ? WHERE id = ?", i.amount, cur, nowIso(), existing.id);
    return db.get('SELECT * FROM budgets WHERE id = ?', existing.id)!;
  }
  return db.insert('budgets', { user_id: userId, category: i.category, amount: i.amount, currency: cur });
}

const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** Totals per currency and category for spending between two local dates (inclusive). */
function totals(db: Db, userId: string, from: string, to: string) {
  return db.all(
    `SELECT currency, category, SUM(amount) AS total, COUNT(*) AS n FROM expenses
     WHERE user_id = ? AND spent_on >= ? AND spent_on <= ? GROUP BY currency, category`,
    userId, from, to,
  ).map((r) => ({ currency: String(r.currency), category: String(r.category) as Category, total: Number(r.total), n: Number(r.n) }));
}

/**
 * A month of spending in the main currency, with each budget's progress. Spending in other
 * currencies is listed separately rather than converted (no exchange rates are guessed).
 */
export function monthSummary(db: Db, userId: string, month: string, today: string, mainCurrency: string) {
  const from = `${month}-01`;
  const to = monthEnd(month);
  const rows = totals(db, userId, from, to);
  const main = rows.filter((r) => r.currency === mainCurrency);
  const byCategory = CATEGORIES.map((c) => ({ category: c, label: CATEGORY_LABELS[c], total: main.find((r) => r.category === c)?.total ?? 0 }))
    .filter((c) => c.total > 0).sort((a, b) => b.total - a.total);
  const total = main.reduce((a, r) => a + r.total, 0);
  const other = Object.entries(rows.filter((r) => r.currency !== mainCurrency).reduce<Record<string, number>>((a, r) => ({ ...a, [r.currency]: (a[r.currency] ?? 0) + r.total }), {}))
    .map(([cur, t]) => ({ currency: cur, total: t }));
  const daysInMonth = Number(to.slice(8));
  const isCurrent = today.slice(0, 7) === month;
  const daysLeft = isCurrent ? daysInMonth - Number(today.slice(8)) + 1 : 0;
  const budgets = db.all('SELECT * FROM budgets WHERE user_id = ? ORDER BY category = \'total\' DESC, category', userId).map((b) => {
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
  return { month, currency: mainCurrency, total, count: main.reduce((a, r) => a + r.n, 0), byCategory, other, budgets, daysLeft };
}

/** The last 7 days (ending today) against the 7 before, in the main currency. */
export function weekSummary(db: Db, userId: string, today: string, mainCurrency: string) {
  const sum = (from: string, to: string) => totals(db, userId, from, to).filter((r) => r.currency === mainCurrency);
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
export function checkBudgets(db: Db, userId: string, month: string, today: string, locale = 'en-GB'): BudgetAlert[] {
  if (today.slice(0, 7) !== month) return [];
  const out: BudgetAlert[] = [];
  for (const b of db.all('SELECT * FROM budgets WHERE user_id = ?', userId)) {
    const cat = String(b.category) as Category | 'total';
    const spent = Number(db.get(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE user_id = ? AND currency = ? AND spent_on >= ? AND spent_on <= ?${cat === 'total' ? '' : ' AND category = ?'}`,
      userId, b.currency, `${month}-01`, monthEnd(month), ...(cat === 'total' ? [] : [cat]),
    )!.s);
    const amount = Number(b.amount);
    const level: 0 | 80 | 100 = spent > amount ? 100 : spent >= amount * 0.8 ? 80 : 0;
    if (!level) continue;
    const [m, done] = String(b.alerted).split(':');
    if (m === month && Number(done) >= level) continue;
    db.run('UPDATE budgets SET alerted = ? WHERE id = ?', `${month}:${level}`, b.id);
    const label = CATEGORY_LABELS[cat] ?? cat;
    const money = (n: number) => formatMoney(n, String(b.currency), locale);
    const n = level === 100
      ? { title: `Over budget: ${label}`, body: `${money(spent)} spent this month, ${money(spent - amount)} over the ${money(amount)} budget.` }
      : { title: `${label}: ${Math.round((spent / amount) * 100)}% of budget used`, body: `${money(amount - spent)} left of ${money(amount)} this month.` };
    notify(db, userId, { kind: 'budget', ...n, link: '/money' });
    out.push({ category: cat, level, spent, amount, currency: String(b.currency), ...n });
  }
  return out;
}

export function listExpenses(db: Db, userId: string, opts: { from: string; to: string; limit?: number }) {
  return db.all(
    'SELECT * FROM expenses WHERE user_id = ? AND spent_on >= ? AND spent_on <= ? ORDER BY spent_on DESC, created_at DESC LIMIT ?',
    userId, opts.from, opts.to, opts.limit ?? 200,
  );
}

export { monthEnd };

/** Rings the phone (or sends a push) for budget warnings; they are already in the app's notifications. */
export async function pushAlerts(services: Services, userId: string, alerts: BudgetAlert[]) {
  for (const a of alerts) {
    await services.push.sendToUser(userId, { title: a.title, body: a.body, url: '/money', tag: `budget-${a.category}` }).catch(() => undefined);
  }
}
