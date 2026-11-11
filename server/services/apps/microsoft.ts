import { z } from 'zod';
import type { Services } from '../../context.ts';
import type { Row } from '../../db/index.ts';
import type { ToolContext } from '../../tools/registry.ts';
import { api, AppError } from './accounts.ts';
import {
  appTool, account, untrusted, clip, fileText, ownDocument, eventSpan, rowsInput, slidesInput,
  makeDocx, makeXlsx, makePptx, OFFICE_MIME, type AppToolDef,
} from './common.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const enc = encodeURIComponent;

const recipients = (list?: string) => (list ? list.split(/[,;]/).map((s) => s.trim()).filter(Boolean).map((address) => ({ emailAddress: { address } })) : undefined);
const person = (r: any) => (r?.emailAddress ? `${r.emailAddress.name ?? ''} <${r.emailAddress.address ?? ''}>`.trim() : undefined);

const mailOut = (m: any) => ({
  id: m.id, from: person(m.from), to: m.toRecipients?.map(person), subject: m.subject, date: m.receivedDateTime,
  preview: m.bodyPreview, unread: m.isRead === false, has_attachments: m.hasAttachments,
});

const eventOut = (e: any) => ({
  id: e.id, title: e.subject, start: e.start?.dateTime, end: e.end?.dateTime, time_zone: e.start?.timeZone, all_day: e.isAllDay,
  location: e.location?.displayName || undefined, attendees: e.attendees?.map((x: any) => x.emailAddress?.address).slice(0, 30),
  link: e.webLink, online_meeting: e.onlineMeeting?.joinUrl,
});

/** A drive item from an id or a sharing link. */
function item(file: string) {
  const v = file.trim();
  if (/^https?:\/\//.test(v)) return `${GRAPH}/shares/u!${Buffer.from(v).toString('base64url')}/driveItem`;
  return `${GRAPH}/me/drive/items/${enc(v)}`;
}

/** Saves bytes as a file in the user's OneDrive "Carino" folder, renaming on a clash. */
export async function upload(services: Services, a: Row, name: string, mime: string, data: Buffer) {
  const safe = name.replace(/[\\/:*?"<>|#%]/g, '-').slice(0, 180);
  if (data.length > 200 * 1024 * 1024) throw new AppError('That file is too large to upload (over 200 MB).');
  const f = await api(services, a, `${GRAPH}/me/drive/root:/Carino/${enc(safe)}:/content?@microsoft.graph.conflictBehavior=rename`, {
    method: 'PUT', raw: new Uint8Array(data), headers: { 'content-type': mime }, timeoutMs: 180_000,
  });
  return { uploaded: true, id: f.id, name: f.name, link: f.webUrl, folder: 'OneDrive/Carino' };
}

const withExt = (name: string, ext: string) => (name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`);

function graphTime(t: { iso: string } | { date: string }) {
  return 'date' in t ? { dateTime: `${t.date}T00:00:00`, timeZone: 'UTC' } : { dateTime: t.iso.replace(/Z$/, ''), timeZone: 'UTC' };
}

/** Excel column letters (1 → A, 27 → AA). */
export function colName(n: number) {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

async function worksheet(services: Services, a: Row, file: string, sheet?: string) {
  const base = `${item(file)}/workbook/worksheets`;
  const list = await api(services, a, `${base}?$select=name`);
  const names: string[] = (list.value ?? []).map((w: any) => w.name);
  const name = sheet ?? names[0];
  if (!name) throw new AppError('That workbook has no sheets.');
  if (sheet && !names.includes(sheet)) throw new AppError(`There’s no sheet called “${sheet}”. Sheets: ${names.join(', ')}.`);
  return { url: `${base}('${enc(name.replace(/'/g, "''"))}')`, name, names };
}

const tsv = (rows: unknown[][]) => rows.map((r) => r.map((c) => String(c ?? '').replace(/[\t\n]/g, ' ')).join('\t')).join('\n');

const emailFields = {
  to: z.string().min(3).max(1000).describe('Recipient address(es), comma-separated'),
  cc: z.string().max(1000).optional(),
  subject: z.string().max(300),
  body: z.string().min(1).max(50_000).describe('Plain-text email body'),
};

const message = (i: { to: string; cc?: string; subject: string; body: string }) => ({
  subject: i.subject, body: { contentType: 'Text', content: i.body }, toRecipients: recipients(i.to), ccRecipients: recipients(i.cc),
});

const fileInput = z.string().min(5).max(1000).describe('OneDrive file id (from onedrive_search) or a sharing link');

async function readFile(ctx: ToolContext, a: Row, file: string) {
  const meta = await api(ctx.services, a, `${item(file)}?$select=id,name,size,webUrl,file,folder,@microsoft.graph.downloadUrl`);
  if (meta.folder) throw new AppError(`${meta.name} is a folder.`);
  if (Number(meta.size ?? 0) > 20 * 1024 * 1024) throw new AppError(`${meta.name} is too large to read (over 20 MB).`);
  const url = meta['@microsoft.graph.downloadUrl'];
  let buf: Buffer;
  if (url) {
    // A short-lived, pre-signed link: fetched without the account's token.
    const res = await (ctx.services.netFetch ?? fetch)(url, { signal: AbortSignal.timeout(90_000) }).catch(() => null);
    if (!res?.ok) throw new AppError(`Could not download ${meta.name} from OneDrive.`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    buf = await api(ctx.services, a, `${item(file)}/content`, { binary: true, timeoutMs: 90_000 });
  }
  return { meta, text: await fileText(meta.name, buf) };
}

export const MICROSOFT_TOOLS: AppToolDef[] = [
  appTool('microsoft', {
    name: 'outlook_search',
    description: 'Search the user’s Outlook / Microsoft 365 email. Leave the query empty for the latest messages in the inbox.',
    risk: 'read',
    input: z.object({ query: z.string().max(300).optional(), max: z.number().int().min(1).max(25).optional() }),
    summarize: (i) => `Search Outlook${i.query ? ` for “${i.query}”` : ''}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'microsoft', i);
      const select = '$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments';
      const url = i.query?.trim()
        ? `${GRAPH}/me/messages?$search=${enc(`"${i.query.replace(/"/g, '')}"`)}&$top=${i.max ?? 10}&${select}`
        : `${GRAPH}/me/mailFolders/inbox/messages?$top=${i.max ?? 10}&$orderby=receivedDateTime%20desc&${select}`;
      const r = await api(ctx.services, a, url);
      return untrusted('Outlook', a, { messages: (r.value ?? []).map(mailOut) });
    },
  }),
  appTool('microsoft', {
    name: 'outlook_read',
    description: 'Read one Outlook email in full (use an id from outlook_search).',
    risk: 'read',
    input: z.object({ id: z.string().min(1).max(400) }),
    summarize: () => 'Read an email in Outlook',
    run: async (i, ctx) => {
      const a = account(ctx, 'microsoft', i);
      const m = await api(ctx.services, a, `${GRAPH}/me/messages/${enc(i.id)}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments`, { headers: { prefer: 'outlook.body-content-type="text"' } });
      return untrusted('Outlook', a, { ...mailOut(m), cc: m.ccRecipients?.map(person), body: clip(String(m.body?.content ?? ''), 20_000) });
    },
  }),
  appTool('microsoft', {
    name: 'outlook_send',
    description: 'Send an email from the user’s Outlook. To reply in the same conversation, pass reply_to_message_id (then "to" is ignored and the reply goes to the sender). Always show the user the exact text first.',
    risk: 'consequential',
    input: z.object({ ...emailFields, reply_to_message_id: z.string().max(400).optional() }),
    summarize: (i) => `Send email${i.reply_to_message_id ? ' (reply)' : ''} to ${i.to}: “${i.subject}”\n\n${i.body.slice(0, 400)}${i.body.length > 400 ? '…' : ''}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'microsoft', i);
      if (i.reply_to_message_id) await api(ctx.services, a, `${GRAPH}/me/messages/${enc(i.reply_to_message_id)}/reply`, { body: { comment: i.body } });
      else await api(ctx.services, a, `${GRAPH}/me/sendMail`, { body: { message: message(i), saveToSentItems: true } });
      return { sent: true, from: a.label, to: i.to };
    },
  }),
  appTool('microsoft', {
    name: 'outlook_draft',
    description: 'Save an email as a draft in Outlook (not sent), so the user can review and send it. For a reply, pass reply_to_message_id: the draft goes in the same conversation, to the sender.',
    risk: 'reversible',
    input: z.object({ ...emailFields, reply_to_message_id: z.string().max(400).optional() }),
    summarize: (i) => `Save an Outlook draft${i.reply_to_message_id ? ' reply' : ''} to ${i.to}: “${i.subject}”`,
    run: async (i, ctx) => {
      const a = account(ctx, 'microsoft', i);
      if (i.reply_to_message_id) {
        const d = await api(ctx.services, a, `${GRAPH}/me/messages/${enc(i.reply_to_message_id)}/createReply`, { body: { comment: i.body } });
        return { drafted: true, reply: true, id: d.id, link: d.webLink };
      }
      const d = await api(ctx.services, a, `${GRAPH}/me/messages`, { body: message(i) });
      return { drafted: true, id: d.id, link: d.webLink };
    },
  }),
  appTool('microsoft', {
    name: 'outlook_calendar_events',
    description: 'List events in the user’s Outlook calendar between two times (defaults: now to 7 days ahead).',
    risk: 'read',
    input: z.object({ from: z.string().max(100).optional(), to: z.string().max(100).optional(), max: z.number().int().min(1).max(100).optional() }),
    summarize: () => 'Look at the Outlook calendar',
    run: async (i, ctx) => {
      const a = account(ctx, 'microsoft', i);
      const span = eventSpan(i.from ?? ctx.now.toISOString(), i.to ?? new Date(ctx.now.getTime() + 7 * 86400_000).toISOString(), ctx);
      const iso = (t: { iso: string } | { date: string }) => ('date' in t ? `${t.date}T00:00:00Z` : t.iso);
      const q = new URLSearchParams({ startDateTime: iso(span.start), endDateTime: iso(span.end), $top: String(i.max ?? 50), $orderby: 'start/dateTime', $select: 'id,subject,start,end,isAllDay,location,attendees,webLink,onlineMeeting' });
      const r = await api(ctx.services, a, `${GRAPH}/me/calendarView?${q}`, { headers: { prefer: `outlook.timezone="${ctx.timeZone}"` } });
      return untrusted('Outlook Calendar', a, { events: (r.value ?? []).map(eventOut) });
    },
  }),
  appTool('microsoft', {
    name: 'outlook_calendar_create_event',
    description: 'Add an event to the user’s Outlook calendar. Times as ISO 8601 (local times are in the user’s time zone); a plain date makes an all-day event. Attendees get an invitation.',
    risk: 'consequential',
    input: z.object({
      title: z.string().min(1).max(300), start: z.string().min(4).max(100), end: z.string().max(100).optional(),
      location: z.string().max(500).optional(), description: z.string().max(8000).optional(),
      attendees: z.array(z.string().email()).max(50).optional(), online_meeting: z.boolean().optional().describe('Add a Teams meeting link'),
    }),
    summarize: (i) => `Add “${i.title}” to the Outlook calendar at ${i.start}${i.attendees?.length ? `, inviting ${i.attendees.join(', ')}` : ''}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'microsoft', i);
      const span = eventSpan(i.start, i.end, ctx);
      const allDay = 'date' in span.start;
      const e = await api(ctx.services, a, `${GRAPH}/me/events`, {
        body: {
          subject: i.title, body: i.description ? { contentType: 'Text', content: i.description } : undefined,
          start: allDay ? { ...graphTime(span.start), timeZone: ctx.timeZone } : graphTime(span.start),
          end: allDay ? { ...graphTime(span.end), timeZone: ctx.timeZone } : graphTime(span.end),
          isAllDay: allDay, location: i.location ? { displayName: i.location } : undefined,
          attendees: i.attendees?.map((address) => ({ emailAddress: { address }, type: 'required' })),
          isOnlineMeeting: i.online_meeting || undefined,
        },
      });
      return { created: true, ...eventOut(e) };
    },
  }),
  appTool('microsoft', {
    name: 'onedrive_search',
    description: 'Find files in the user’s OneDrive (Word, Excel, PowerPoint, PDFs…). Leave the query empty for recent files.',
    risk: 'read',
    input: z.object({ query: z.string().max(300).optional(), max: z.number().int().min(1).max(30).optional() }),
    summarize: (i) => `Search OneDrive${i.query ? ` for “${i.query}”` : ''}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'microsoft', i);
      const url = i.query?.trim()
        ? `${GRAPH}/me/drive/root/search(q='${enc(i.query.replace(/'/g, "''"))}')?$top=${i.max ?? 15}`
        : `${GRAPH}/me/drive/recent?$top=${i.max ?? 15}`;
      const r = await api(ctx.services, a, url);
      const files = (r.value ?? []).map((f: any) => ({ id: f.remoteItem?.id ?? f.id, name: f.name, folder: !!f.folder, size: f.size, modified: f.lastModifiedDateTime, link: f.webUrl }));
      return untrusted('OneDrive', a, { files });
    },
  }),
  appTool('microsoft', {
    name: 'onedrive_read',
    description: 'Read a OneDrive file as text: Word, Excel, PowerPoint, PDF or text files.',
    risk: 'read',
    input: z.object({ file: fileInput }),
    summarize: () => 'Read a file from OneDrive',
    run: async (i, ctx) => {
      const a = account(ctx, 'microsoft', i);
      const { meta, text } = await readFile(ctx, a, i.file);
      return untrusted('OneDrive', a, { name: meta.name, link: meta.webUrl, text: clip(text) });
    },
  }),
  appTool('microsoft', {
    name: 'onedrive_upload',
    description: 'Save a file the user attached in Carino (its document id) to their OneDrive, in a "Carino" folder.',
    risk: 'reversible',
    input: z.object({ document_id: z.string().min(1).max(64), name: z.string().max(200).optional() }),
    summarize: (i) => `Upload a file to OneDrive${i.name ? ` as “${i.name}”` : ''}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'microsoft', i);
      const { doc, buf } = await ownDocument(ctx, i.document_id);
      return upload(ctx.services, a, i.name || doc.filename, doc.mime || 'application/octet-stream', buf);
    },
  }),
  appTool('microsoft', {
    name: 'word_create',
    description: 'Write a Word document (.docx) and save it in the user’s OneDrive (Carino folder). Text: lines starting with #, ## or ### become headings, lines starting with - become bullets.',
    risk: 'reversible',
    input: z.object({ name: z.string().min(1).max(150), title: z.string().max(200).optional(), text: z.string().min(1).max(200_000) }),
    summarize: (i) => `Create the Word document “${withExt(i.name, 'docx')}” in OneDrive`,
    run: async (i, ctx) => {
      const a = account(ctx, 'microsoft', i);
      return upload(ctx.services, a, withExt(i.name, 'docx'), OFFICE_MIME.docx, await makeDocx(i.title ?? i.name.replace(/\.docx$/i, ''), i.text));
    },
  }),
  appTool('microsoft', {
    name: 'excel_create',
    description: 'Create an Excel workbook (.xlsx) with rows (first row = headings) and save it in the user’s OneDrive (Carino folder).',
    risk: 'reversible',
    input: z.object({ name: z.string().min(1).max(150), sheet: z.string().max(31).optional(), rows: rowsInput }),
    summarize: (i) => `Create the Excel workbook “${withExt(i.name, 'xlsx')}” in OneDrive`,
    run: async (i, ctx) => {
      const a = account(ctx, 'microsoft', i);
      return upload(ctx.services, a, withExt(i.name, 'xlsx'), OFFICE_MIME.xlsx, await makeXlsx(i.sheet ?? 'Sheet1', i.rows));
    },
  }),
  appTool('microsoft', {
    name: 'excel_read',
    description: 'Read cells from an Excel workbook in OneDrive. Without a range, reads the sheet’s used area.',
    risk: 'read',
    input: z.object({ file: fileInput, sheet: z.string().max(100).optional(), range: z.string().max(50).optional().describe('e.g. "A1:F40"') }),
    summarize: () => 'Read an Excel workbook in OneDrive',
    run: async (i, ctx) => {
      const a = account(ctx, 'microsoft', i);
      const ws = await worksheet(ctx.services, a, i.file, i.sheet);
      const r = await api(ctx.services, a, i.range ? `${ws.url}/range(address='${enc(i.range)}')?$select=address,values` : `${ws.url}/usedRange(valuesOnly=true)?$select=address,values`);
      const values: unknown[][] = (r.values ?? []).slice(0, 2000);
      return untrusted('Excel', a, { sheet: ws.name, sheets: ws.names, range: r.address, values: clip(tsv(values)) });
    },
  }),
  appTool('microsoft', {
    name: 'excel_update',
    description: 'Write values into an Excel workbook in OneDrive, either over a range ("B2:C5", rows must match its size) or, with append=true, as new rows under the existing data.',
    risk: 'consequential',
    input: z.object({ file: fileInput, sheet: z.string().max(100).optional(), range: z.string().max(50).optional(), append: z.boolean().optional(), rows: rowsInput.min(1) }),
    summarize: (i) => (i.append ? `Add ${i.rows.length} row${i.rows.length === 1 ? '' : 's'} to an Excel workbook` : `Update ${i.range ?? 'cells'} in an Excel workbook`),
    run: async (i, ctx) => {
      const a = account(ctx, 'microsoft', i);
      const ws = await worksheet(ctx.services, a, i.file, i.sheet);
      const width = Math.max(...i.rows.map((r) => r.length), 1);
      const rows = i.rows.map((r) => [...r, ...Array(width - r.length).fill('')]);
      let address = i.range;
      if (i.append || !address) {
        const used = await api(ctx.services, a, `${ws.url}/usedRange(valuesOnly=true)?$select=address,rowCount,rowIndex`);
        const next = used.values?.length === 1 && used.values[0].every((v: unknown) => v === '') ? 1 : Number(used.rowIndex ?? 0) + Number(used.rowCount ?? 0) + 1;
        address = `A${next}:${colName(width)}${next + rows.length - 1}`;
      }
      const r = await api(ctx.services, a, `${ws.url}/range(address='${enc(address)}')`, { method: 'PATCH', body: { values: rows } });
      return { updated: true, sheet: ws.name, range: r.address ?? address };
    },
  }),
  appTool('microsoft', {
    name: 'powerpoint_create',
    description: 'Make a PowerPoint presentation (.pptx) from slide titles and bullet points, and save it in the user’s OneDrive (Carino folder).',
    risk: 'reversible',
    input: z.object({ name: z.string().min(1).max(150), title: z.string().max(200).optional(), slides: slidesInput }),
    summarize: (i) => `Create the PowerPoint “${withExt(i.name, 'pptx')}” (${i.slides.length} slides) in OneDrive`,
    run: async (i, ctx) => {
      const a = account(ctx, 'microsoft', i);
      return upload(ctx.services, a, withExt(i.name, 'pptx'), OFFICE_MIME.pptx, await makePptx(i.title ?? i.name.replace(/\.pptx$/i, ''), i.slides));
    },
  }),
];
