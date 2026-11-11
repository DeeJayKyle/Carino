import { z } from 'zod';
import type { Services } from '../../context.ts';
import type { Row } from '../../db/index.ts';
import { api, AppError } from './accounts.ts';
import { appTool, account, untrusted, clip, htmlToText, fileText, ownDocument, eventSpan, idFrom, rowsInput, type AppToolDef } from './common.ts';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DOCS = 'https://docs.googleapis.com/v1/documents';

const enc = encodeURIComponent;
const b64urlText = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

// ---- Gmail ---------------------------------------------------------------------------------

/** Headers with non-ASCII text are encoded the way email expects. */
const headerText = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

export function mimeMessage(m: { to: string; cc?: string; subject: string; body: string; inReplyTo?: string; references?: string }) {
  const lines = [
    `To: ${oneLine(m.to)}`,
    ...(m.cc ? [`Cc: ${oneLine(m.cc)}`] : []),
    `Subject: ${headerText(oneLine(m.subject))}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${oneLine(m.inReplyTo)}`, `References: ${oneLine(m.references ?? m.inReplyTo)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(m.body, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

const header = (msg: any, name: string) => msg?.payload?.headers?.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

/** The readable text of a Gmail message: its plain-text part, or its HTML part as text. */
export function gmailBody(payload: any): string {
  let plain = '';
  let html = '';
  const walk = (p: any) => {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = b64urlText(p.body.data);
    else if (p.mimeType === 'text/html' && p.body?.data && !html) html = b64urlText(p.body.data);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return plain || htmlToText(html);
}

async function gmailSummary(services: Services, a: Row, id: string) {
  const m = await api(services, a, `${GMAIL}/messages/${enc(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
  return { id: m.id, thread_id: m.threadId, from: header(m, 'From'), to: header(m, 'To'), subject: header(m, 'Subject'), date: header(m, 'Date'), snippet: m.snippet, unread: (m.labelIds ?? []).includes('UNREAD') };
}

/** What a reply needs to stay in its Gmail thread. */
async function replyHeaders(services: Services, a: Row, messageId: string, subject: string) {
  const orig = await api(services, a, `${GMAIL}/messages/${enc(messageId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`);
  const inReplyTo = header(orig, 'Message-ID') || undefined;
  return {
    threadId: orig.threadId as string | undefined, inReplyTo,
    references: [header(orig, 'References'), inReplyTo].filter(Boolean).join(' ') || undefined,
    subject: subject.trim() ? subject : /^re:/i.test(header(orig, 'Subject')) ? header(orig, 'Subject') : `Re: ${header(orig, 'Subject')}`,
  };
}

const emailFields = {
  to: z.string().min(3).max(1000).describe('Recipient address(es), comma-separated'),
  cc: z.string().max(1000).optional(),
  subject: z.string().max(300),
  body: z.string().min(1).max(50_000).describe('Plain-text email body'),
};

// ---- Calendar ------------------------------------------------------------------------------

function gTime(t: { iso: string } | { date: string }, timeZone: string) {
  return 'date' in t ? { date: t.date } : { dateTime: t.iso, timeZone };
}

const eventOut = (e: any) => ({
  id: e.id, title: e.summary ?? '(no title)', start: e.start?.dateTime ?? e.start?.date, end: e.end?.dateTime ?? e.end?.date,
  location: e.location, description: e.description ? clip(String(e.description), 1500) : undefined,
  attendees: e.attendees?.map((x: any) => x.email).slice(0, 30), link: e.htmlLink, meet: e.hangoutLink,
});

// ---- Drive ---------------------------------------------------------------------------------

const GOOGLE_EXPORT: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'text/plain', ext: 'txt' },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', ext: 'csv' },
  'application/vnd.google-apps.presentation': { mime: 'text/plain', ext: 'txt' },
};

/** Multipart upload body: JSON metadata then the file. */
function multipart(meta: Record<string, unknown>, mime: string, data: Buffer) {
  const boundary = `carino${Date.now().toString(36)}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--`);
  return { body: Buffer.concat([head, data, tail]), type: `multipart/related; boundary=${boundary}` };
}

/** Saves bytes as a file in the user's Google Drive (used for opt-in cloud backups). */
export async function driveUploadBytes(services: Services, a: Row, name: string, mime: string, data: Buffer) {
  const mp = multipart({ name }, mime, data);
  const f = await api(services, a, `${UPLOAD}?uploadType=multipart&fields=id,name,webViewLink`, { method: 'POST', raw: new Uint8Array(mp.body), headers: { 'content-type': mp.type }, timeoutMs: 300_000 });
  return { uploaded: true, id: f.id as string, name: f.name as string, link: f.webViewLink as string };
}

const tsv = (rows: unknown[][]) => rows.map((r) => r.map((c) => String(c ?? '').replace(/[\t\n]/g, ' ')).join('\t')).join('\n');

export const GOOGLE_TOOLS: AppToolDef[] = [
  appTool('google', {
    name: 'gmail_search',
    description: 'Search the user’s Gmail. Uses Gmail search syntax (from:, to:, subject:, is:unread, newer_than:7d, has:attachment…). Leave the query empty for the latest messages in the inbox.',
    risk: 'read',
    input: z.object({ query: z.string().max(500).optional(), max: z.number().int().min(1).max(25).optional() }),
    summarize: (i) => `Search Gmail${i.query ? ` for “${i.query}”` : ''}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'google', i);
      const q = i.query?.trim() || 'in:inbox';
      const list = await api(ctx.services, a, `${GMAIL}/messages?maxResults=${i.max ?? 10}&q=${enc(q)}`);
      const messages = await Promise.all((list.messages ?? []).map((m: any) => gmailSummary(ctx.services, a, m.id)));
      return untrusted('Gmail', a, { messages, more: !!list.nextPageToken });
    },
  }),
  appTool('google', {
    name: 'gmail_read',
    description: 'Read one Gmail message in full (use an id from gmail_search).',
    risk: 'read',
    input: z.object({ id: z.string().min(1).max(100) }),
    summarize: () => 'Read an email in Gmail',
    run: async (i, ctx) => {
      const a = account(ctx, 'google', i);
      const m = await api(ctx.services, a, `${GMAIL}/messages/${enc(i.id)}?format=full`);
      const attachments: string[] = [];
      const walk = (p: any) => { if (p?.filename) attachments.push(p.filename); for (const c of p?.parts ?? []) walk(c); };
      walk(m.payload);
      return untrusted('Gmail', a, {
        id: m.id, thread_id: m.threadId, from: header(m, 'From'), to: header(m, 'To'), cc: header(m, 'Cc'), subject: header(m, 'Subject'), date: header(m, 'Date'),
        body: clip(gmailBody(m.payload), 20_000), attachments,
      });
    },
  }),
  appTool('google', {
    name: 'gmail_send',
    description: 'Send an email from the user’s Gmail. To reply, pass reply_to_message_id (the reply stays in the same thread; "to" may then be the original sender). Always show the user the exact text first.',
    risk: 'consequential',
    input: z.object({ ...emailFields, reply_to_message_id: z.string().max(100).optional() }),
    summarize: (i) => `Send email to ${i.to}: “${i.subject}”\n\n${i.body.slice(0, 400)}${i.body.length > 400 ? '…' : ''}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'google', i);
      const r = i.reply_to_message_id ? await replyHeaders(ctx.services, a, i.reply_to_message_id, i.subject) : null;
      const threadId = r?.threadId;
      const inReplyTo = r?.inReplyTo;
      const references = r?.references;
      const subject = r?.subject ?? i.subject;
      const sent = await api(ctx.services, a, `${GMAIL}/messages/send`, { body: { raw: mimeMessage({ ...i, subject, inReplyTo, references }), threadId } });
      return { sent: true, id: sent.id, from: a.label, to: i.to };
    },
  }),
  appTool('google', {
    name: 'gmail_draft',
    description: 'Save an email as a draft in the user’s Gmail (not sent), so they can review and send it themselves. For a reply, pass reply_to_message_id: the draft goes in the same thread.',
    risk: 'reversible',
    input: z.object({ ...emailFields, reply_to_message_id: z.string().max(100).optional() }),
    summarize: (i) => `Save a Gmail draft${i.reply_to_message_id ? ' reply' : ''} to ${i.to}: “${i.subject}”`,
    run: async (i, ctx) => {
      const a = account(ctx, 'google', i);
      const r = i.reply_to_message_id ? await replyHeaders(ctx.services, a, i.reply_to_message_id, i.subject) : null;
      const d = await api(ctx.services, a, `${GMAIL}/drafts`, { body: { message: { raw: mimeMessage({ ...i, subject: r?.subject ?? i.subject, inReplyTo: r?.inReplyTo, references: r?.references }), threadId: r?.threadId } } });
      return { drafted: true, reply: !!r, id: d.id, account: a.label };
    },
  }),
  appTool('google', {
    name: 'google_calendar_events',
    description: 'List events in the user’s Google Calendar between two times (defaults: now to 7 days ahead). Optional text filter.',
    risk: 'read',
    input: z.object({ from: z.string().max(100).optional(), to: z.string().max(100).optional(), query: z.string().max(200).optional(), max: z.number().int().min(1).max(100).optional() }),
    summarize: (i) => `Look at Google Calendar${i.query ? ` for “${i.query}”` : ''}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'google', i);
      const span = eventSpan(i.from ?? ctx.now.toISOString(), i.to ?? new Date(ctx.now.getTime() + 7 * 86400_000).toISOString(), ctx);
      const iso = (t: { iso: string } | { date: string }) => ('date' in t ? new Date(`${t.date}T00:00:00Z`).toISOString() : t.iso);
      const q = new URLSearchParams({ timeMin: iso(span.start), timeMax: iso(span.end), singleEvents: 'true', orderBy: 'startTime', maxResults: String(i.max ?? 50) });
      if (i.query) q.set('q', i.query);
      const r = await api(ctx.services, a, `${CAL}/primary/events?${q}`);
      return untrusted('Google Calendar', a, { time_zone: r.timeZone, events: (r.items ?? []).map(eventOut) });
    },
  }),
  appTool('google', {
    name: 'google_calendar_create_event',
    description: 'Add an event to the user’s Google Calendar. Times as ISO 8601 (local times are in the user’s time zone); a plain date makes an all-day event. Attendees get an invitation email.',
    risk: 'consequential',
    input: z.object({
      title: z.string().min(1).max(300), start: z.string().min(4).max(100), end: z.string().max(100).optional(),
      location: z.string().max(500).optional(), description: z.string().max(8000).optional(),
      attendees: z.array(z.string().email()).max(50).optional(), video_call: z.boolean().optional().describe('Add a Google Meet link'),
    }),
    summarize: (i) => `Add “${i.title}” to Google Calendar at ${i.start}${i.attendees?.length ? `, inviting ${i.attendees.join(', ')}` : ''}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'google', i);
      const span = eventSpan(i.start, i.end, ctx);
      const body: any = {
        summary: i.title, location: i.location, description: i.description,
        start: gTime(span.start, ctx.timeZone), end: gTime(span.end, ctx.timeZone),
        attendees: i.attendees?.map((email) => ({ email })),
      };
      if (i.video_call) body.conferenceData = { createRequest: { requestId: `carino-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
      const e = await api(ctx.services, a, `${CAL}/primary/events?sendUpdates=${i.attendees?.length ? 'all' : 'none'}${i.video_call ? '&conferenceDataVersion=1' : ''}`, { body });
      return { created: true, ...eventOut(e) };
    },
  }),
  appTool('google', {
    name: 'drive_search',
    description: 'Find files in the user’s Google Drive by name or content. Returns ids for drive_read, sheets_read and docs_append.',
    risk: 'read',
    input: z.object({ query: z.string().max(300).optional().describe('Words to look for; empty lists recent files'), max: z.number().int().min(1).max(30).optional() }),
    summarize: (i) => `Search Google Drive${i.query ? ` for “${i.query}”` : ''}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'google', i);
      const words = i.query?.trim().replace(/['\\]/g, (m) => `\\${m}`);
      const q = words ? `(name contains '${words}' or fullText contains '${words}') and trashed = false` : 'trashed = false';
      const params = new URLSearchParams({ pageSize: String(i.max ?? 15), q, fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size)' });
      // Drive can't sort full-text results; recent files are listed newest first.
      if (!words) params.set('orderBy', 'modifiedTime desc');
      const r = await api(ctx.services, a, `${DRIVE}/files?${params}`);
      return untrusted('Google Drive', a, { files: (r.files ?? []).map((f: any) => ({ id: f.id, name: f.name, type: f.mimeType, modified: f.modifiedTime, link: f.webViewLink, size: f.size ? Number(f.size) : undefined })) });
    },
  }),
  appTool('google', {
    name: 'drive_read',
    description: 'Read a file from Google Drive as text: Google Docs, Sheets (as CSV), Slides, Word, Excel, PowerPoint, PDF or text files. Takes an id or a link.',
    risk: 'read',
    input: z.object({ file: z.string().min(5).max(500).describe('File id or link') }),
    summarize: () => 'Read a file from Google Drive',
    run: async (i, ctx) => {
      const a = account(ctx, 'google', i);
      const id = idFrom(i.file);
      const meta = await api(ctx.services, a, `${DRIVE}/files/${enc(id)}?fields=id,name,mimeType,size,webViewLink`);
      const exp = GOOGLE_EXPORT[meta.mimeType];
      let text: string;
      if (exp) {
        const buf: Buffer = await api(ctx.services, a, `${DRIVE}/files/${enc(id)}/export?mimeType=${enc(exp.mime)}`, { binary: true });
        text = buf.toString('utf8');
      } else if (String(meta.mimeType).startsWith('application/vnd.google-apps')) {
        throw new AppError(`Carino can’t read this kind of Google file (${meta.mimeType}).`);
      } else {
        if (Number(meta.size ?? 0) > 20 * 1024 * 1024) throw new AppError(`${meta.name} is too large to read (over 20 MB).`);
        const buf: Buffer = await api(ctx.services, a, `${DRIVE}/files/${enc(id)}?alt=media`, { binary: true, timeoutMs: 90_000 });
        text = await fileText(meta.name, buf);
      }
      return untrusted('Google Drive', a, { name: meta.name, link: meta.webViewLink, text: clip(text) });
    },
  }),
  appTool('google', {
    name: 'drive_upload',
    description: 'Save a file the user attached in Carino (its document id) to their Google Drive. Word and Excel files can be converted to Google Docs and Sheets.',
    risk: 'reversible',
    input: z.object({ document_id: z.string().min(1).max(64), name: z.string().max(200).optional(), convert: z.boolean().optional() }),
    summarize: (i) => `Upload a file to Google Drive${i.name ? ` as “${i.name}”` : ''}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'google', i);
      const { doc, buf } = await ownDocument(ctx, i.document_id);
      const name = i.name || doc.filename || doc.title;
      const convertTo = i.convert ? ({ docx: 'application/vnd.google-apps.document', xlsx: 'application/vnd.google-apps.spreadsheet', csv: 'application/vnd.google-apps.spreadsheet' } as Record<string, string>)[doc.kind] : undefined;
      const mp = multipart({ name, ...(convertTo ? { mimeType: convertTo } : {}) }, doc.mime || 'application/octet-stream', buf);
      const f = await api(ctx.services, a, `${UPLOAD}?uploadType=multipart&fields=id,name,webViewLink`, { method: 'POST', raw: new Uint8Array(mp.body), headers: { 'content-type': mp.type }, timeoutMs: 180_000 });
      return { uploaded: true, id: f.id, name: f.name, link: f.webViewLink };
    },
  }),
  appTool('google', {
    name: 'sheets_read',
    description: 'Read cells from a Google Sheet (id or link). Without a range, reads the first tab (up to 500 rows).',
    risk: 'read',
    input: z.object({ spreadsheet: z.string().min(5).max(500), range: z.string().max(200).optional().describe('A1 notation, e.g. "Budget!A1:F40"') }),
    summarize: () => 'Read a Google Sheet',
    run: async (i, ctx) => {
      const a = account(ctx, 'google', i);
      const id = idFrom(i.spreadsheet);
      const meta = await api(ctx.services, a, `${SHEETS}/${enc(id)}?fields=properties.title,sheets.properties(title,gridProperties)`);
      const tabs = (meta.sheets ?? []).map((s: any) => s.properties.title as string);
      const range = i.range || `'${(tabs[0] ?? 'Sheet1').replace(/'/g, "''")}'!A1:Z500`;
      const v = await api(ctx.services, a, `${SHEETS}/${enc(id)}/values/${enc(range)}`);
      return untrusted('Google Sheets', a, { title: meta.properties?.title, tabs, range: v.range, values: clip(tsv(v.values ?? [])) });
    },
  }),
  appTool('google', {
    name: 'sheets_append',
    description: 'Add rows to the end of a table in a Google Sheet. Values are entered as if typed (numbers, dates and formulas work).',
    risk: 'consequential',
    input: z.object({ spreadsheet: z.string().min(5).max(500), range: z.string().max(200).optional().describe('Tab or table, e.g. "Expenses" (defaults to the first tab)'), rows: rowsInput }),
    summarize: (i) => `Add ${i.rows.length} row${i.rows.length === 1 ? '' : 's'} to a Google Sheet`,
    run: async (i, ctx) => {
      const a = account(ctx, 'google', i);
      const id = idFrom(i.spreadsheet);
      const r = await api(ctx.services, a, `${SHEETS}/${enc(id)}/values/${enc(i.range || 'A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { body: { values: i.rows } });
      return { appended: true, range: r.updates?.updatedRange, rows: r.updates?.updatedRows };
    },
  }),
  appTool('google', {
    name: 'sheets_update',
    description: 'Overwrite a range of cells in a Google Sheet, e.g. "Budget!B2:C5". Values are entered as if typed.',
    risk: 'consequential',
    input: z.object({ spreadsheet: z.string().min(5).max(500), range: z.string().min(2).max(200), rows: rowsInput }),
    summarize: (i) => `Update ${i.range} in a Google Sheet`,
    run: async (i, ctx) => {
      const a = account(ctx, 'google', i);
      const r = await api(ctx.services, a, `${SHEETS}/${enc(idFrom(i.spreadsheet))}/values/${enc(i.range)}?valueInputOption=USER_ENTERED`, { method: 'PUT', body: { values: i.rows } });
      return { updated: true, range: r.updatedRange, cells: r.updatedCells };
    },
  }),
  appTool('google', {
    name: 'sheets_create',
    description: 'Create a new Google Sheet, optionally filled with rows (first row = headings).',
    risk: 'reversible',
    input: z.object({ title: z.string().min(1).max(200), rows: rowsInput.optional() }),
    summarize: (i) => `Create the Google Sheet “${i.title}”`,
    run: async (i, ctx) => {
      const a = account(ctx, 'google', i);
      const s = await api(ctx.services, a, SHEETS, { body: { properties: { title: i.title } } });
      if (i.rows?.length) {
        const tab = s.sheets?.[0]?.properties?.title ?? 'Sheet1';
        await api(ctx.services, a, `${SHEETS}/${enc(s.spreadsheetId)}/values/${enc(`'${tab}'!A1`)}?valueInputOption=USER_ENTERED`, { method: 'PUT', body: { values: i.rows } });
      }
      return { created: true, id: s.spreadsheetId, link: s.spreadsheetUrl };
    },
  }),
  appTool('google', {
    name: 'docs_create',
    description: 'Create a Google Doc with the given text.',
    risk: 'reversible',
    input: z.object({ title: z.string().min(1).max(200), text: z.string().max(100_000) }),
    summarize: (i) => `Create the Google Doc “${i.title}”`,
    run: async (i, ctx) => {
      const a = account(ctx, 'google', i);
      const d = await api(ctx.services, a, DOCS, { body: { title: i.title } });
      if (i.text) await api(ctx.services, a, `${DOCS}/${enc(d.documentId)}:batchUpdate`, { body: { requests: [{ insertText: { location: { index: 1 }, text: i.text } }] } });
      return { created: true, id: d.documentId, link: `https://docs.google.com/document/d/${d.documentId}/edit` };
    },
  }),
  appTool('google', {
    name: 'docs_append',
    description: 'Add text to the end of an existing Google Doc (id or link).',
    risk: 'consequential',
    input: z.object({ document: z.string().min(5).max(500), text: z.string().min(1).max(100_000) }),
    summarize: () => 'Add text to a Google Doc',
    run: async (i, ctx) => {
      const a = account(ctx, 'google', i);
      const id = idFrom(i.document);
      const d = await api(ctx.services, a, `${DOCS}/${enc(id)}?fields=title,body.content(endIndex)`);
      const end = Math.max(1, Number(d.body?.content?.at(-1)?.endIndex ?? 2) - 1);
      await api(ctx.services, a, `${DOCS}/${enc(id)}:batchUpdate`, { body: { requests: [{ insertText: { location: { index: end }, text: `\n${i.text}` } }] } });
      return { updated: true, title: d.title, link: `https://docs.google.com/document/d/${id}/edit` };
    },
  }),
];
