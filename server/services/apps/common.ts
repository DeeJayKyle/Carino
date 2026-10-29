import { z } from 'zod';
import type { ToolDef, ToolContext } from '../../tools/registry.ts';
import type { Row } from '../../db/index.ts';
import { pickAccount, AppError } from './accounts.ts';
import type { ProviderId } from './providers.ts';
import { detectKind, extract, readDocumentFile } from '../documents.ts';
import { parseWhen, tzOffsetMinutes, addDays } from '../time.ts';

export interface AppToolDef extends ToolDef {
  provider: ProviderId;
}

/** Declares an app tool; `account` is added to every input so the model can pick one of several. */
export function appTool<S extends z.ZodObject<any>>(provider: ProviderId, d: Omit<ToolDef<S>, 'input'> & { input: S }): AppToolDef {
  const input = d.input.extend({ account: z.string().max(200).optional().describe('Which connected account to use (email or handle). Leave out for the first one.') });
  return { ...(d as unknown as ToolDef), input, provider, askByDefault: d.risk !== 'read' } as AppToolDef;
}

export const account = (ctx: ToolContext, provider: ProviderId, i: object): Row => pickAccount(ctx.services, ctx.userId, provider, (i as { account?: string }).account);

/** Wraps what an app returned, so the model treats it as data (it can contain anyone's text). */
export const untrusted = (app: string, account: Row, result: unknown) => ({ app, account: account.label, untrusted_content: true, result });

export const MAX_TEXT = 40_000;
export const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n)}\n…(cut — ${s.length - n} more characters)` : s);

/** Plain text from an HTML email or page, good enough for reading. */
export function htmlToText(html: string) {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Text from a downloaded file (Word, Excel, PowerPoint, PDF, text). */
export async function fileText(name: string, buf: Buffer): Promise<string> {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pptx')) return pptxText(buf);
  if (/\.(txt|md|csv|json|html?|xml|ics|log)$/.test(lower)) return lower.endsWith('.html') || lower.endsWith('.htm') ? htmlToText(buf.toString('utf8')) : buf.toString('utf8');
  let kind;
  try {
    kind = detectKind(name, buf);
  } catch {
    throw new AppError(`Carino can’t read ${name} (only Word, Excel, PowerPoint, PDF and text files).`);
  }
  if (kind.kind === 'image') throw new AppError(`${name} is a picture; Carino can only read documents from here.`);
  const ex = await extract(kind.kind, buf);
  return ex.chunks.map((c) => c.text).join('\n\n');
}

async function pptxText(buf: Buffer) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const out: string[] = [];
  for (const [i, f] of slides.entries()) {
    const xml = await zip.file(f)!.async('string');
    const paras = xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('')).filter(Boolean);
    out.push(`Slide ${i + 1}:\n${paras.join('\n')}`);
  }
  return out.join('\n\n');
}

/** A file the user attached in Carino (for uploads to Drive, OneDrive, Instagram, TikTok). */
export async function ownDocument(ctx: ToolContext, id: string) {
  const doc = ctx.services.db.getOwned('documents', ctx.userId, id);
  if (!doc) throw new AppError('That file isn’t in Carino. Use the id of a file the user attached or shared.');
  if (doc.storage_path) await ctx.services.loadFiles?.([doc.storage_path]);
  return { doc, buf: readDocumentFile(doc) };
}

/** Simple writing (headings with #, bullets with -, paragraphs) as Word document parts. */
export async function makeDocx(title: string, text: string): Promise<Buffer> {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import('docx');
  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  for (const line of text.split('\n')) {
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) children.push(new Paragraph({ text: h[2], heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][h[1].length - 1] }));
    else if (/^\s*[-*•]\s+/.test(line)) children.push(new Paragraph({ text: line.replace(/^\s*[-*•]\s+/, ''), bullet: { level: 0 } }));
    else children.push(new Paragraph({ children: [new TextRun(line)] }));
  }
  return Buffer.from(await Packer.toBuffer(new Document({ creator: 'Carino', title, sections: [{ children }] })));
}

export async function makeXlsx(sheetName: string, rows: (string | number | null)[][]): Promise<Buffer> {
  const mod = await import('exceljs');
  const ExcelJS = (mod as any).default ?? mod;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Carino';
  const ws = wb.addWorksheet(sheetName.slice(0, 31) || 'Sheet1');
  for (const r of rows) ws.addRow(r);
  if (rows.length) ws.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface SlideSpec {
  title: string;
  bullets?: string[];
  notes?: string;
}

export async function makePptx(title: string, slides: SlideSpec[]): Promise<Buffer> {
  const mod = await import('pptxgenjs');
  const PptxGenJS = (mod as any).default ?? mod;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = title;
  const cover = pptx.addSlide();
  cover.addText(title, { x: 0.6, y: 2.6, w: 12, h: 1.4, fontSize: 40, bold: true, color: '1F1B2E' });
  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.addText(s.title, { x: 0.6, y: 0.4, w: 12, h: 1, fontSize: 30, bold: true, color: '1F1B2E' });
    if (s.bullets?.length) slide.addText(s.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })), { x: 0.8, y: 1.6, w: 11.6, h: 5.2, fontSize: 20, color: '333333', valign: 'top' });
    if (s.notes) slide.addNotes(s.notes);
  }
  const out = await pptx.write({ outputType: 'uint8array' });
  return Buffer.from(out as Uint8Array);
}

export const OFFICE_MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

export const rowsInput = z.array(z.array(z.union([z.string().max(5000), z.number(), z.null()])).max(200)).max(2000);
export const slidesInput = z.array(z.object({
  title: z.string().min(1).max(200),
  bullets: z.array(z.string().max(500)).max(12).optional(),
  notes: z.string().max(3000).optional(),
})).min(1).max(40);

/**
 * A moment the model gave ("2026-11-03T15:00", "tomorrow 3pm") as an exact time, or a plain date
 * for all-day events. Local times without an offset are taken in the user's time zone.
 */
export function when(value: string, ctx: ToolContext): { iso: string } | { date: string } {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { date: v };
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    if (/(Z|[+-]\d{2}:?\d{2})$/.test(v)) return { iso: new Date(v).toISOString() };
    const naive = new Date(`${v.slice(0, 19).padEnd(19, ':00').slice(0, 19)}Z`);
    if (!Number.isNaN(naive.getTime())) return { iso: new Date(naive.getTime() - tzOffsetMinutes(ctx.timeZone, naive) * 60_000).toISOString() };
  }
  const parsed = parseWhen(v, ctx.now, ctx.timeZone);
  if (!parsed) throw new AppError(`Could not understand the time "${value}". Use a date and time such as 2026-11-03T15:00.`);
  return { iso: parsed.iso };
}

/** Start and end of an event; the end defaults to an hour later (or the same day). */
export function eventSpan(start: string, end: string | undefined, ctx: ToolContext) {
  const s = when(start, ctx);
  if ('date' in s) {
    const e = end ? when(end, ctx) : null;
    const endDate = e && 'date' in e ? e.date : addDays(s.date, 1);
    return { start: s, end: { date: endDate } as { date: string } | { iso: string } };
  }
  const e = end ? when(end, ctx) : { iso: new Date(Date.parse(s.iso) + 3600_000).toISOString() };
  return { start: s, end: e };
}

/** Accepts an id or a link (Google Docs/Sheets/Drive, OneDrive) and returns the id. */
export function idFrom(v: string) {
  const m = v.match(/\/d\/([A-Za-z0-9_-]{10,})/) ?? v.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : v.trim();
}
