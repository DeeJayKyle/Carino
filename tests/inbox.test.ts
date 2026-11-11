import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, text, toolCall, type TestCtx } from './helpers.ts';
import { encryptSecret } from '../server/services/secrets.ts';
import { refreshDigest } from '../server/services/inbox.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());
// Clock: 2026-10-16 08:00 UTC = 11:00 in Kampala.

type C = Awaited<ReturnType<typeof signup>>;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const hdrs = (h: Record<string, string>) => ({ payload: { headers: Object.entries(h).map(([name, value]) => ({ name, value })) } });

function connect(c: C, provider: 'google' | 'microsoft', label: string) {
  return ctx.services.db.insert('app_accounts', {
    user_id: c.user.id, provider, external_id: label, label,
    secret: encryptSecret(ctx.services.config.DATA_DIR, JSON.stringify({ access_token: `${provider}-token`, expires_at: Date.parse('2030-01-01') })),
  });
}

/** Made-up Gmail, Google Calendar and Outlook. */
const drafts: any[] = [];
function fakeMail(opts: { gmailFails?: boolean } = {}) {
  const seen: string[] = [];
  drafts.length = 0;
  ctx.services.netFetch = (async (input: any, init: any = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(`${init.method ?? 'GET'} ${url}`);
    if (url.includes('gmail.googleapis.com') && opts.gmailFails) return json({ error: { message: 'Token revoked' } }, 401);
    if (url.includes('/gmail/v1/users/me/messages?')) return json({ messages: [{ id: 'u1' }], resultSizeEstimate: 4 });
    if (url.includes('/gmail/v1/users/me/messages/u1')) return json({ id: 'u1', threadId: 't9', snippet: 'Can you confirm the order?', ...hdrs({ From: 'Dr. Mary <mary@example.org>', Subject: 'Order for Friday', Date: 'Fri, 16 Oct 2026 06:00:00 +0000' }) });
    if (url.includes('/gmail/v1/users/me/threads?')) return json({ threads: [{ id: 't1' }, { id: 't2' }] });
    if (url.includes('/gmail/v1/users/me/threads/t1')) return json({ id: 't1', messages: [{ id: 'm1', labelIds: ['INBOX'], snippet: 'Any update on the invoice?', ...hdrs({ From: 'Sam <sam@example.com>', Subject: 'Invoice 42', Date: 'Mon, 12 Oct 2026 09:00:00 +0000' }) }] });
    // t2: the user already replied (the last message is theirs).
    if (url.includes('/gmail/v1/users/me/threads/t2')) return json({ id: 't2', messages: [{ id: 'm2', labelIds: ['INBOX'], ...hdrs({ From: 'Ann <ann@example.com>', Subject: 'Lunch' }) }, { id: 'm3', labelIds: ['SENT'], ...hdrs({ From: 'Me <me@example.com>' }) }] });
    if (url.includes('/calendar/v3/calendars/primary/events?')) return json({ items: [
      { id: 'e1', summary: 'Supplier meeting', start: { dateTime: '2026-10-16T11:00:00Z' }, end: { dateTime: '2026-10-16T12:00:00Z' }, location: 'Shop' },
      { id: 'e2', summary: 'Tomorrow thing', start: { dateTime: '2026-10-17T07:00:00Z' }, end: { dateTime: '2026-10-17T08:00:00Z' } },
      { id: 'e3', summary: 'Cancelled', status: 'cancelled', start: { dateTime: '2026-10-16T13:00:00Z' } },
    ] });
    if (url.includes('graph.microsoft.com/v1.0/me/mailFolders/inbox/messages')) return json({ '@odata.count': 2, value: [{ id: 'o1', conversationId: 'c1', subject: 'Exam results', from: { emailAddress: { name: 'University', address: 'exams@uni.example' } }, receivedDateTime: '2026-10-16T05:00:00Z', bodyPreview: 'Your results are ready' }] });
    if (url.includes('graph.microsoft.com/v1.0/me/calendarView')) return json({ value: [{ id: 'oe1', subject: 'Staff training', isAllDay: true, start: { dateTime: '2026-10-16T00:00:00.0000000' }, end: { dateTime: '2026-10-17T00:00:00.0000000' } }] });
    if (url.includes('/gmail/v1/users/me/messages/m1')) return json({ id: 'm1', threadId: 't1', ...hdrs({ 'Message-ID': '<m1@example.com>', Subject: 'Invoice 42' }) });
    if (url.includes('/gmail/v1/users/me/drafts')) {
      drafts.push(JSON.parse(String(init.body)));
      return json({ id: 'd1' });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return seen;
}

describe('email and calendar in the brief', () => {
  it('collects unread mail, replies owed and today’s events across accounts, read-only', async () => {
    const c = await signup(ctx);
    connect(c, 'google', 'me@example.com');
    connect(c, 'microsoft', 'me@school.example');
    const seen = fakeMail();
    const d = await refreshDigest(ctx.services, c.user.id, 'Africa/Kampala');
    expect(d.unread_total).toBe(6);
    expect(d.unread.map((m) => [m.from, m.subject])).toEqual([['Dr. Mary', 'Order for Friday'], ['University', 'Exam results']]);
    expect(d.awaiting.map((m) => [m.from, m.subject, m.id])).toEqual([['Sam', 'Invoice 42', 'm1']]); // not Ann: already replied
    expect(d.events.map((e) => e.title)).toEqual(['Staff training', 'Supplier meeting', 'Tomorrow thing']);
    expect(seen.every((s) => s.startsWith('GET '))).toBe(true);

    const brief = (await c.get('/api/dashboard')).data.briefing as string;
    expect(brief).toContain('On your calendar: All day Staff training; 14:00 Supplier meeting.');
    expect(brief).toContain('6 unread emails, including Dr. Mary: “Order for Friday”.');
    expect(brief).toContain('1 email is waiting for your reply (Sam: “Invoice 42”).');
    expect(brief).not.toContain('Tomorrow thing');
  });

  it('one account failing doesn’t stop the others, and says which', async () => {
    const c = await signup(ctx);
    connect(c, 'google', 'me@example.com');
    connect(c, 'microsoft', 'me@school.example');
    fakeMail({ gmailFails: true });
    const d = await refreshDigest(ctx.services, c.user.id, 'Africa/Kampala');
    expect(d.errors.map((e) => e.account)).toEqual(['me@example.com']);
    expect(d.unread.map((m) => m.from)).toEqual(['University']);
  });

  it('works offline from the saved summary, and drops it when it’s old', async () => {
    const c = await signup(ctx);
    connect(c, 'google', 'me@example.com');
    fakeMail();
    await refreshDigest(ctx.services, c.user.id, 'Africa/Kampala');
    ctx.services.netFetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    expect((await c.get('/api/dashboard')).data.briefing).toContain('Supplier meeting');
    ctx.clock.now = new Date('2026-10-17T08:00:00Z');
    expect((await c.get('/api/dashboard')).data.briefing).not.toContain('unread email');
  });

  it('bills and application deadlines are in the brief too', async () => {
    const c = await signup(ctx);
    await c.patch('/api/settings', { money: { currency: 'UGX' } });
    await c.post('/api/bills', { name: 'Rent', amount: 600000, next_due: '2026-10-17' });
    await c.post('/api/applications', { title: 'Masters scholarship', deadline: '2026-10-20' });
    const a = (await c.post('/api/applications', { title: 'Pharmacist', organisation: 'City Hospital', status: 'applied', applied_on: '2026-10-01' })).data;
    expect(a.follow_up_on).toBe('2026-10-15');
    const brief = (await c.get('/api/dashboard')).data.briefing as string;
    expect(brief).toContain('Bills due: Rent (UGX 600,000).');
    expect(brief).toContain('Application deadline this week: Masters scholarship (2026-10-20).');
    expect(brief).toContain('Time to follow up: Pharmacist at City Hospital.');
  });
});

describe('follow-ups', () => {
  it('suggests replies, and a dismissed one stays dismissed', async () => {
    const c = await signup(ctx);
    connect(c, 'google', 'me@example.com');
    fakeMail();
    await c.post('/api/digest/refresh', {});
    let d = (await c.get('/api/dashboard')).data;
    expect(d.suggestions.find((s: any) => s.action === 'reply')).toMatchObject({ text: 'Reply to Sam: “Invoice 42”' });
    expect(d.overview.connected.awaiting[0]).toMatchObject({ id: 'm1', provider: 'google' });
    await c.post('/api/followups/m1/dismiss', {});
    d = (await c.get('/api/dashboard')).data;
    expect(d.suggestions.some((s: any) => s.action === 'reply')).toBe(false);
    expect((await c.get('/api/digest')).data.awaiting).toEqual([]);
  });

  it('the assistant drafts a reply in the thread (not sent) and makes a to-do from an email', async () => {
    const c = await signup(ctx);
    connect(c, 'google', 'me@example.com');
    const seen = fakeMail();
    // Tools for connected apps ask first by default, drafts included; this user allowed drafts.
    await c.patch('/api/settings', { permissions: { tools: { gmail_draft: 'auto' } } });
    ctx.provider.steps.push(
      () => toolCall('inbox_overview', {}),
      () => toolCall('gmail_draft', { to: 'sam@example.com', subject: '', body: 'Hi Sam, paying on Monday.', reply_to_message_id: 'm1' }),
      () => toolCall('email_to_task', { message_id: 'u1', provider: 'google', from: 'Dr. Mary', subject: 'Order for Friday', title: 'Confirm Friday’s order with Dr. Mary', due: '2026-10-16T15:00' }),
      () => text('Draft saved and to-do added.'),
    );
    const conv = (await c.post('/api/conversations', {})).data;
    await c.post(`/api/conversations/${conv.id}/messages`, { text: 'what needs my attention? draft Sam a reply' });
    const overview = JSON.stringify(ctx.provider.calls[1].messages.at(-1));
    expect(overview).toContain('Invoice 42');
    expect(overview).toContain('untrusted_content');
    // Saved as a draft in the thread (a draft needs no approval; nothing is sent).
    expect(drafts).toHaveLength(1);
    expect(drafts[0].message.threadId).toBe('t1');
    const mime = Buffer.from(drafts[0].message.raw, 'base64url').toString();
    expect(mime).toContain('In-Reply-To: <m1@example.com>');
    expect(mime).toContain('Subject: Re: Invoice 42');
    expect(seen.some((s) => s.includes('/messages/send'))).toBe(false);
    const t = (await c.get('/api/tasks?view=all')).data.tasks[0];
    expect(t).toMatchObject({ title: 'Confirm Friday’s order with Dr. Mary' });
    expect(t.description).toContain('Dr. Mary: “Order for Friday”');
  });

  it('creating calendar events and sending email always wait for approval', async () => {
    const { TOOL_MAP } = await import('../server/tools/registry.ts');
    const { APP_TOOLS } = await import('../server/services/apps/index.ts');
    const risk = (n: string) => (TOOL_MAP.get(n) ?? APP_TOOLS.find((t) => t.name === n))?.risk;
    for (const n of ['gmail_send', 'outlook_send', 'google_calendar_create_event', 'outlook_calendar_create_event', 'sheets_update', 'sheets_append', 'docs_append', 'excel_update']) expect([n, risk(n)]).toEqual([n, 'consequential']);
    for (const n of ['gmail_draft', 'outlook_draft', 'inbox_overview']) expect(risk(n)).not.toBe('consequential');
  });
});
