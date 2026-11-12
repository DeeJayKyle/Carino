import type { Sheet, Cell } from './spreadsheet.ts';

/**
 * Bank and mobile-money statements (CSV or Excel exports): finds the date, description and amount
 * columns whatever the bank calls them, so the rows can go into Money. Works with any bank,
 * without an open-banking provider.
 */
export interface StatementRow { date: string; description: string; amount: number }

const find = (headers: string[], re: RegExp) => headers.findIndex((h) => re.test(h.toLowerCase()));

export function parseAmount(v: Cell): number | null {
  if (v === null || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).trim();
  const neg = /^\(.*\)$/.test(s) || /(^|[^\d])-\s*\d/.test(s) || /\bdr\b/i.test(s);
  s = s.replace(/[^\d.,]/g, '');
  // "1.234,56" (comma decimals) vs "1,234.56".
  if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) && s ? (neg ? -Math.abs(n) : n) : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** A statement date as YYYY-MM-DD (day-first for slashes, as most banks outside the US write). */
export function parseDate(v: Cell, dayFirst = true): string | null {
  if (v === null || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86400_000).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const [a, b] = dayFirst ? [m[2], m[1]] : [m[1], m[2]];
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (Number(a) > 12) return `${y}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    return `${y}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
  }
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s-,]+(\d{2,4})/);
  if (m && MONTHS.includes(m[2].toLowerCase())) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${String(MONTHS.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

/** Statement rows: money out is negative, money in positive. */
export function readStatement(sheet: Sheet): { rows: StatementRow[]; skipped: number } {
  const h = sheet.headers.map((x) => String(x ?? ''));
  const date = find(h, /date|posted|value/);
  const desc = find(h, /desc|detail|narrat|particular|memo|payee|reference|transaction|remark/);
  const debit = find(h, /debit|withdraw|paid out|money out|\bout\b|dr\b/);
  const credit = find(h, /credit|deposit|paid in|money in|\bin\b|cr\b/);
  const amount = find(h, /amount|value \(|sum/);
  if (date < 0 || (amount < 0 && debit < 0 && credit < 0)) {
    throw new Error('Couldn’t find the date and amount columns in this statement. Export it as CSV with a header row (Date, Description, Amount or Debit/Credit).');
  }
  const rows: StatementRow[] = [];
  let skipped = 0;
  for (const r of sheet.rows) {
    const d = parseDate(r[date]);
    let amt: number | null = null;
    if (debit >= 0 || credit >= 0) {
      const out = debit >= 0 ? parseAmount(r[debit]) : null;
      const inn = credit >= 0 ? parseAmount(r[credit]) : null;
      if (out) amt = -Math.abs(out);
      else if (inn) amt = Math.abs(inn);
    }
    if (amt === null && amount >= 0) amt = parseAmount(r[amount]);
    if (!d || amt === null || amt === 0) { skipped++; continue; }
    rows.push({ date: d, description: String(desc >= 0 ? r[desc] ?? '' : '').trim().slice(0, 300), amount: Math.round(amt * 100) / 100 });
  }
  return { rows, skipped };
}

const GUESS: [RegExp, string][] = [
  [/supermarket|grocer|market|carrefour|shoprite|tesco|walmart|quality|capital shoppers/i, 'groceries'],
  [/restaurant|cafe|coffee|pizza|kfc|java|chicken|bar\b|food|glovo|uber ?eats|jumia food/i, 'food'],
  [/uber|bolt|safeboda|taxi|boda|fuel|petrol|shell|total|stanbic fuel|bus|airline|flight/i, 'transport'],
  [/umeme|yaka|power|electric|water|nwsc|airtime|data|bundle|internet|mtn|airtel|netflix|spotify|subscription|rent|dstv|gotv/i, 'bills'],
  [/pharm|clinic|hospital|doctor|medic|lab\b/i, 'health'],
  [/school|fees|tuition|university|course|books/i, 'education'],
  [/cinema|movie|game|concert|ticket/i, 'fun'],
];
export const guessCategory = (description: string) => GUESS.find(([re]) => re.test(description))?.[1] ?? 'other';
