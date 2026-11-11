import type { Services } from '../context.ts';
import type { Db, Row } from '../db/index.ts';
import { nowIso, parseJson } from '../db/index.ts';
import { api } from './apps/accounts.ts';
import { startOfLocalDay, addDays, localDate } from './time.ts';

/**
 * What's happening in the user's connected email and calendars, for the daily brief and
 * follow-ups: unread mail, threads waiting for the user's reply, and today's and tomorrow's events.
 *
 * Read-only and summary-only (sender, subject, time). Kept on the device in `connected_digest`, so the
 * brief works offline and nothing is sent to an AI provider unless the user asks about it in chat.
 * Refreshed by the morning routine, and when the app opens if it's more than 30 minutes old.
 */

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GCAL = 'https://www.googleapis.com/calendar/v3';
const GRAPH = 'https://graph.microsoft.com/v1.0';
/** A thread with no reply from the user for this long counts as waiting for one. */
export const AWAIT_DAYS = 2;
const STALE_MS = 30 * 60_000;
const enc = encodeURIComponent;

export interface DigestMessage { account: string; provider: string; id: string; thread_id?: string; from: string; subject: string; date: string; snippet?: string }
export interface DigestEvent { account: string; provider: string; id: string; title: string; start: string; end?: string; all_day: boolean; location?: string }
export interface Digest {
  fetched_at: string;
  unread: DigestMessage[];
  unread_total: number;
  awaiting: DigestMessage[];
  events: DigestEvent[];
  errors: { account: string; error: string }[];
}

const header = (m: any, name: string) => String(m?.payload?.headers?.find((h: any) => String(h.name).toLowerCase() === name.toLowerCase())?.value ?? '');
const addr = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
const name = (from: string) => from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || addr(from);

async function google(services: Services, a: Row, from: Date, to: Date): Promise<Partial<Digest>> {
  const me = String(a.label).toLowerCase();
  const people = '-category:promotions -category:social -category:updates -category:forums';
  const unreadList = await api(services, a, `${GMAIL}/messages?maxResults=10&q=${enc(`is:unread in:inbox newer_than:2d ${people}`)}`);
  const unread: DigestMessage[] = await Promise.all((unreadList.messages ?? []).slice(0, 10).map(async (m: any) => {
    const x = await api(services, a, `${GMAIL}/messages/${enc(m.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    return { account: String(a.label), provider: 'google', id: x.id, thread_id: x.threadId, from: name(header(x, 'From')), subject: header(x, 'Subject') || '(no subject)', date: header(x, 'Date'), snippet: String(x.snippet ?? '').slice(0, 160) };
  }));
  // Threads in the inbox from people, 2–14 days old, whose last message isn't from the user.
  const threads = await api(services, a, `${GMAIL}/threads?maxResults=10&q=${enc(`in:inbox ${people} newer_than:14d older_than:${AWAIT_DAYS}d`)}`);
  const awaiting: DigestMessage[] = [];
  for (const t of (threads.threads ?? []).slice(0, 10)) {
    const th = await api(services, a, `${GMAIL}/threads/${enc(t.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    const last = th.messages?.at(-1);
    if (!last || (last.labelIds ?? []).includes('SENT') || addr(header(last, 'From')) === me) continue;
    awaiting.push({ account: String(a.label), provider: 'google', id: last.id, thread_id: th.id, from: name(header(last, 'From')), subject: header(th.messages[0], 'Subject') || '(no subject)', date: header(last, 'Date'), snippet: String(last.snippet ?? '').slice(0, 160) });
  }
  const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '25' });
  const ev = await api(services, a, `${GCAL}/calendars/primary/events?${q}`);
  const events: DigestEvent[] = (ev.items ?? []).filter((e: any) => e.status !== 'cancelled').map((e: any) => ({
    account: String(a.label), provider: 'google', id: e.id, title: e.summary ?? '(no title)', start: e.start?.dateTime ?? e.start?.date, end: e.end?.dateTime ?? e.end?.date, all_day: !e.start?.dateTime, location: e.location,
  }));
  return { unread, unread_total: Number(unreadList.resultSizeEstimate ?? unread.length), awaiting, events };
}

async function microsoft(services: Services, a: Row, from: Date, to: Date, timeZone: string): Promise<Partial<Digest>> {
  const since = new Date(from.getTime() - 86400_000).toISOString();
  const sel = '$select=id,conversationId,subject,from,receivedDateTime,bodyPreview';
  const unreadRes = await api(services, a, `${GRAPH}/me/mailFolders/inbox/messages?$filter=${enc(`isRead eq false and receivedDateTime ge ${since} and inferenceClassification eq 'focused'`)}&$top=10&$count=true&${sel}`, { headers: { consistencylevel: 'eventual' } });
  const unread: DigestMessage[] = (unreadRes.value ?? []).map((m: any) => ({
    account: String(a.label), provider: 'microsoft', id: m.id, thread_id: m.conversationId, from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || '', subject: m.subject || '(no subject)', date: m.receivedDateTime, snippet: String(m.bodyPreview ?? '').slice(0, 160),
  }));
  const q = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: '25', $orderby: 'start/dateTime', $select: 'id,subject,start,end,isAllDay,location,isCancelled' });
  const ev = await api(services, a, `${GRAPH}/me/calendarView?${q}`, { headers: { prefer: `outlook.timezone="${timeZone}"` } });
  const events: DigestEvent[] = (ev.value ?? []).filter((e: any) => !e.isCancelled).map((e: any) => ({
    account: String(a.label), provider: 'microsoft', id: e.id, title: e.subject || '(no title)', start: e.start?.dateTime, end: e.end?.dateTime, all_day: !!e.isAllDay, location: e.location?.displayName || undefined,
  }));
  // Outlook doesn't say which threads await a reply without reading each one; only Gmail reports those.
  return { unread, unread_total: Number(unreadRes['@odata.count'] ?? unread.length), awaiting: [], events };
}

/** Fetches a fresh digest from every connected Google and Microsoft account, and keeps it. */
export async function refreshDigest(services: Services, userId: string, timeZone: string): Promise<Digest> {
  const now = services.now();
  const today = localDate(now, timeZone);
  const from = startOfLocalDay(today, timeZone);
  const to = startOfLocalDay(addDays(today, 2), timeZone);
  const d: Digest = { fetched_at: now.toISOString(), unread: [], unread_total: 0, awaiting: [], events: [], errors: [] };
  for (const a of services.db.all("SELECT * FROM app_accounts WHERE user_id = ? AND provider IN ('google', 'microsoft') ORDER BY created_at", userId)) {
    try {
      const part = a.provider === 'google' ? await google(services, a, from, to) : await microsoft(services, a, from, to, timeZone);
      d.unread.push(...(part.unread ?? []));
      d.unread_total += part.unread_total ?? 0;
      d.awaiting.push(...(part.awaiting ?? []));
      d.events.push(...(part.events ?? []));
    } catch (e: any) {
      d.errors.push({ account: String(a.label), error: String(e?.message ?? e).slice(0, 200) });
    }
  }
  d.events.sort((x, y) => String(x.start).localeCompare(String(y.start)));
  services.db.run(
    `INSERT INTO connected_digest (user_id, data, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
    userId, JSON.stringify(d), d.fetched_at,
  );
  return d;
}

/** The last digest, if there is one (and how old it is). */
export function cachedDigest(db: Db, userId: string): Digest | null {
  const row = db.get('SELECT data FROM connected_digest WHERE user_id = ?', userId);
  return row ? parseJson<Digest | null>(row.data, null) : null;
}

const refreshing = new Set<string>();
/** Refreshes in the background when the saved digest is old (never blocks, one at a time). */
export function refreshIfStale(services: Services, userId: string, timeZone: string) {
  const d = cachedDigest(services.db, userId);
  const hasAccounts = !!services.db.get("SELECT 1 FROM app_accounts WHERE user_id = ? AND provider IN ('google', 'microsoft')", userId);
  if (!hasAccounts || refreshing.has(userId)) return;
  if (d && services.now().getTime() - Date.parse(d.fetched_at) < STALE_MS) return;
  refreshing.add(userId);
  void refreshDigest(services, userId, timeZone).catch(() => undefined).finally(() => refreshing.delete(userId));
}

/** Follow-ups the user has put off or dismissed, so they aren't suggested again. */
export function dismissFollowUp(db: Db, userId: string, messageId: string) {
  db.run('INSERT OR IGNORE INTO follow_up_dismissed (user_id, message_id, created_at) VALUES (?, ?, ?)', userId, messageId, nowIso());
}

export function awaitingReplies(db: Db, userId: string, d: Digest | null) {
  if (!d) return [];
  const gone = new Set(db.all('SELECT message_id FROM follow_up_dismissed WHERE user_id = ?', userId).map((r) => String(r.message_id)));
  return d.awaiting.filter((m) => !gone.has(m.id));
}
