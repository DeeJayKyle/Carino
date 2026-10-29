import Papa from 'papaparse';
import ExcelJS from 'exceljs';

export type Cell = string | number | null;
export interface Sheet {
  name: string;
  headers: string[];
  rows: Cell[][];
}

export const MAX_ROWS = 50_000;

/** Parses CSV text into one sheet. The first non-empty row is treated as headers. */
export function parseCsv(text: string): Sheet {
  const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: 'greedy' });
  const data = parsed.data.slice(0, MAX_ROWS + 1);
  const headers = uniqueHeaders((data[0] ?? []).map((h) => String(h ?? '')));
  return { name: 'Sheet1', headers, rows: data.slice(1).map((r) => headers.map((_, i) => normalizeCell(r[i]))) };
}

/** Reads cell values only — formulas are not evaluated and macros are never run. */
export async function parseXlsx(buf: Buffer): Promise<Sheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const sheets: Sheet[] = [];
  wb.eachSheet((ws) => {
    const raw: Cell[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (raw.length > MAX_ROWS) return;
      const vals = (row.values as any[]).slice(1).map(excelValue);
      raw.push(vals);
    });
    if (!raw.length) return;
    const width = Math.max(...raw.map((r) => r.length));
    const headers = uniqueHeaders(Array.from({ length: width }, (_, i) => String(raw[0][i] ?? '')));
    sheets.push({ name: ws.name, headers, rows: raw.slice(1).map((r) => headers.map((_, i) => r[i] ?? null)) });
  });
  return sheets;
}

function excelValue(v: any): Cell {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return excelValue(v.result); // cached formula result
    if ('richText' in v) return v.richText.map((t: any) => t.text).join('');
    if ('text' in v) return String(v.text);
    return null;
  }
  return normalizeCell(String(v));
}

function normalizeCell(v: unknown): Cell {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function uniqueHeaders(h: string[]): string[] {
  const seen = new Map<string, number>();
  return h.map((name, i) => {
    const base = name.trim() || `Column ${i + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base} (${n + 1})` : base;
  });
}

/** "UGX 1,250,000" → 1250000; "(45.5)" → -45.5; "12%" → 12. Returns null when not numeric. */
export function toNumber(v: Cell): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = v.replace(/[\s,]/g, '').replace(/^[A-Za-z$€£¥₦₹]{1,4}/, '').replace(/%$/, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return neg ? -n : n;
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})/;
export function toDate(v: Cell): string | null {
  if (v == null || typeof v === 'number') return null;
  const m = v.match(DATE_RE);
  if (!m) return null;
  let iso = m[1];
  if (!/^\d{4}/.test(iso)) {
    const [a, b, c] = iso.split(/[/.-]/).map(Number);
    const year = c < 100 ? 2000 + c : c;
    iso = `${year}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`; // day-first (common outside the US)
  }
  return Number.isNaN(Date.parse(iso)) ? null : iso.slice(0, 10);
}

export interface ColumnProfile {
  name: string;
  type: 'number' | 'date' | 'text' | 'empty';
  count: number;
  missing: number;
  distinct: number;
  sum?: number;
  mean?: number;
  median?: number;
  min?: number | string;
  max?: number | string;
  stdev?: number;
  top?: { value: string; count: number }[];
}

export interface Analysis {
  sheet: string;
  rowCount: number;
  columns: ColumnProfile[];
  cleaning: string[];
  rankings: { by: string; group: string; items: { label: string; total: number }[] }[];
  anomalies: { column: string; row: number; value: number; reason: string }[];
  trends: { date: string; value: string; points: { period: string; total: number }[]; direction: string; changePct: number | null }[];
  notes: string[];
}

export function cleanSheet(sheet: Sheet): { sheet: Sheet; cleaning: string[] } {
  const cleaning: string[] = [];
  const before = sheet.rows.length;
  let rows = sheet.rows.filter((r) => r.some((c) => c != null));
  if (rows.length < before) cleaning.push(`Removed ${before - rows.length} empty row(s).`);
  const seen = new Set<string>();
  const deduped: Cell[][] = [];
  for (const r of rows) {
    const key = JSON.stringify(r);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(r);
    }
  }
  if (deduped.length < rows.length) cleaning.push(`Found ${rows.length - deduped.length} exact duplicate row(s); they are excluded from the analysis.`);
  rows = deduped;
  if (rows.length > MAX_ROWS) {
    cleaning.push(`Only the first ${MAX_ROWS} rows were analysed.`);
    rows = rows.slice(0, MAX_ROWS);
  }
  return { sheet: { ...sheet, rows }, cleaning };
}

export function analyzeSheet(input: Sheet): Analysis {
  const { sheet, cleaning } = cleanSheet(input);
  const n = sheet.rows.length;
  const columns: ColumnProfile[] = sheet.headers.map((name, ci) => {
    const vals = sheet.rows.map((r) => r[ci]);
    const present = vals.filter((v) => v != null);
    const nums = present.map(toNumber).filter((x): x is number => x != null);
    const dates = present.map(toDate).filter((x): x is string => x != null);
    const distinct = new Set(present.map(String)).size;
    const base = { name, count: present.length, missing: n - present.length, distinct };
    if (!present.length) return { ...base, type: 'empty' as const };
    if (nums.length >= present.length * 0.9) {
      const sorted = [...nums].sort((a, b) => a - b);
      const sum = nums.reduce((a, b) => a + b, 0);
      const mean = sum / nums.length;
      const stdev = Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(nums.length - 1, 1));
      if (nums.length < present.length) cleaning.push(`Column "${name}": ${present.length - nums.length} non-numeric value(s) ignored.`);
      return {
        ...base, type: 'number' as const, sum: round(sum), mean: round(mean), stdev: round(stdev),
        median: round(sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2),
        min: sorted[0], max: sorted[sorted.length - 1],
      };
    }
    if (dates.length >= present.length * 0.9) {
      const sorted = [...dates].sort();
      return { ...base, type: 'date' as const, min: sorted[0], max: sorted[sorted.length - 1] };
    }
    const freq = new Map<string, number>();
    for (const v of present) freq.set(String(v), (freq.get(String(v)) ?? 0) + 1);
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value, count }));
    return { ...base, type: 'text' as const, top };
  });

  const numCols = columns.map((c, i) => ({ c, i })).filter((x) => x.c.type === 'number');
  const textCols = columns.map((c, i) => ({ c, i })).filter((x) => x.c.type === 'text' && x.c.distinct > 1 && x.c.distinct <= Math.max(50, n / 2));
  const dateCols = columns.map((c, i) => ({ c, i })).filter((x) => x.c.type === 'date');

  const rankings: Analysis['rankings'] = [];
  if (textCols.length && numCols.length) {
    const g = textCols[0];
    for (const v of numCols.slice(0, 2)) {
      const totals = new Map<string, number>();
      for (const r of sheet.rows) {
        const label = r[g.i] == null ? '(blank)' : String(r[g.i]);
        const x = toNumber(r[v.i]);
        if (x != null) totals.set(label, (totals.get(label) ?? 0) + x);
      }
      rankings.push({
        by: v.c.name, group: g.c.name,
        items: [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, total]) => ({ label, total: round(total) })),
      });
    }
  }

  const anomalies: Analysis['anomalies'] = [];
  for (const { c, i } of numCols) {
    if ((c.count ?? 0) < 8 || !c.stdev) continue;
    const vals = sheet.rows.map((r) => toNumber(r[i])).filter((x): x is number => x != null).sort((a, b) => a - b);
    const q1 = vals[Math.floor(vals.length * 0.25)];
    const q3 = vals[Math.floor(vals.length * 0.75)];
    const iqr = q3 - q1;
    if (iqr === 0) continue;
    sheet.rows.forEach((r, ri) => {
      const x = toNumber(r[i]);
      if (x == null) return;
      if (x > q3 + 3 * iqr || x < q1 - 3 * iqr) {
        anomalies.push({ column: c.name, row: ri + 2, value: x, reason: x > q3 ? 'far above the typical range' : 'far below the typical range' });
      }
    });
  }

  const trends: Analysis['trends'] = [];
  if (dateCols.length && numCols.length) {
    const d = dateCols[0];
    const v = numCols[0];
    const byMonth = new Map<string, number>();
    for (const r of sheet.rows) {
      const dt = toDate(r[d.i]);
      const x = toNumber(r[v.i]);
      if (dt && x != null) byMonth.set(dt.slice(0, 7), (byMonth.get(dt.slice(0, 7)) ?? 0) + x);
    }
    const points = [...byMonth.entries()].sort().map(([period, total]) => ({ period, total: round(total) }));
    if (points.length >= 2) {
      const first = points[0].total;
      const last = points[points.length - 1].total;
      const changePct = first !== 0 ? round(((last - first) / Math.abs(first)) * 100) : null;
      trends.push({
        date: d.c.name, value: v.c.name, points,
        direction: last > first ? 'increasing' : last < first ? 'decreasing' : 'flat',
        changePct,
      });
    }
  }

  const notes = [
    'Totals and averages are calculated from the values present; missing cells are excluded, not treated as zero.',
    'Anomalies use a 3×IQR rule — they are statistical outliers to check, not confirmed errors.',
  ];
  if (cleaning.length) notes.push('Row numbers refer to the data after empty and duplicate rows were removed (row 1 is the header).');
  if (dateCols.length) notes.push('Dates like 03/04/2026 are read day-first (3 April 2026).');
  return { sheet: sheet.name, rowCount: n, columns, cleaning, rankings, anomalies: anomalies.slice(0, 50), trends, notes };
}

const round = (x: number) => Math.round(x * 100) / 100;

/** Plain-text rendering of a sheet for indexing and for the model. */
export function sheetToText(sheet: Sheet, maxRows = 200): string {
  const lines = [sheet.headers.join(' | ')];
  for (const r of sheet.rows.slice(0, maxRows)) lines.push(r.map((c) => (c == null ? '' : String(c))).join(' | '));
  if (sheet.rows.length > maxRows) lines.push(`… ${sheet.rows.length - maxRows} more rows`);
  return lines.join('\n');
}
