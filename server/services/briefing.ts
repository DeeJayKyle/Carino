import type { Db } from '../db/index.ts';
import { localDate, startOfLocalDay, addDays, formatLocal } from './time.ts';
import { presentTask } from './tasks.ts';
import { getSettings } from './settings.ts';
import * as money from './money.ts';
import { billsDueSoon } from './finance.ts';
import { applicationsDue } from './applications.ts';
import { cachedDigest, awaitingReplies } from './inbox.ts';

/**
 * A factual snapshot of the user's stored data for a day. Everything here comes
 * from the database — nothing is invented to fill space.
 */
export function buildOverview(db: Db, userId: string, now: Date, timeZone: string, dayOffset = 0, locale = 'en-GB') {
  const today = localDate(now, timeZone);
  const day = addDays(today, dayOffset);
  const dayStart = startOfLocalDay(day, timeZone);
  const dayEnd = startOfLocalDay(addDays(day, 1), timeZone);
  const weekEnd = startOfLocalDay(addDays(day, 8), timeZone);
  const fmt = (iso: string, withTime = true) => formatLocal(iso, timeZone, locale, withTime);

  const due = db.all(
    `SELECT t.*, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.user_id = ? AND t.status = 'open' AND t.due_at >= ? AND t.due_at < ? ORDER BY t.priority, t.due_at`,
    userId, dayStart.toISOString(), dayEnd.toISOString(),
  ).map(presentTask);
  const overdue = db.all(
    `SELECT t.*, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.user_id = ? AND t.status = 'open' AND t.due_at < ? ORDER BY t.due_at`,
    userId, (dayOffset === 0 ? startOfLocalDay(today, timeZone) : dayStart).toISOString(),
  ).map(presentTask);
  const upcoming = db.all(
    `SELECT t.*, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.user_id = ? AND t.status = 'open' AND t.due_at >= ? AND t.due_at < ? ORDER BY t.due_at LIMIT 20`,
    userId, dayEnd.toISOString(), weekEnd.toISOString(),
  ).map(presentTask);
  const reminders = db.all(
    `SELECT * FROM reminders WHERE user_id = ? AND status = 'scheduled' AND remind_at >= ? AND remind_at < ? ORDER BY remind_at`,
    userId, dayStart.toISOString(), dayEnd.toISOString(),
  );
  const completedYesterday = db.all(
    `SELECT id, title, completed_at FROM tasks WHERE user_id = ? AND status = 'done' AND completed_at >= ? AND completed_at < ? ORDER BY completed_at DESC LIMIT 30`,
    userId, startOfLocalDay(addDays(today, -1), timeZone).toISOString(), startOfLocalDay(today, timeZone).toISOString(),
  );
  const completedToday = db.all(
    `SELECT id, title, completed_at FROM tasks WHERE user_id = ? AND status = 'done' AND completed_at >= ? ORDER BY completed_at DESC LIMIT 30`,
    userId, startOfLocalDay(today, timeZone).toISOString(),
  );
  const projects = db.all(
    `SELECT p.id, p.name, p.deadline, p.next_action,
       (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS tasks_total,
       (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS tasks_done,
       (SELECT COUNT(*) FROM project_items i WHERE i.project_id = p.id AND i.kind = 'blocker' AND i.done = 0) AS open_blockers
     FROM projects p WHERE p.user_id = ? AND p.status = 'active' ORDER BY p.deadline IS NULL, p.deadline, p.updated_at DESC LIMIT 10`,
    userId,
  );
  const pendingActions = Number(db.get("SELECT COUNT(*) AS n FROM actions WHERE user_id = ? AND status = 'pending'", userId)!.n);
  const proposedMemories = Number(db.get("SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND status = 'proposed'", userId)!.n);
  const estimate = [...overdue, ...due].reduce((a, t) => a + (t.estimate_minutes ?? 0), 0);
  const unestimated = [...overdue, ...due].filter((t) => !t.estimate_minutes).length;

  const brief = (t: any) => ({
    id: t.id, title: t.title, priority: t.priority, project: t.project_name ?? null,
    due: t.due_at ? fmt(t.due_at, !t.all_day) : null, due_at: t.due_at, estimate_minutes: t.estimate_minutes ?? null,
  });
  const cur = money.currencyFor(getSettings(db, userId));
  const week = money.weekSummary(db, userId, today, cur);
  const month = money.monthSummary(db, userId, today.slice(0, 7), today, cur);
  const cash = (n: number) => money.formatMoney(n, cur, locale);
  const spending = week.total > 0 || month.budgets.length ? {
    week: cash(week.total),
    weekTotal: week.total,
    previousWeek: cash(week.previous),
    top: week.top ? `${week.top.label} (${cash(week.top.total)})` : null,
    month: cash(month.total),
    over: month.budgets.filter((b) => b.spent > b.amount).map((b) => b.label),
    near: month.budgets.filter((b) => b.spent <= b.amount && b.percent >= 80).map((b) => `${b.label} (${b.percent}%)`),
  } : null;
  // Connected email and calendars (a saved summary, so this works offline); ignored once it's half a day old.
  const digest = cachedDigest(db, userId);
  const fresh = digest && now.getTime() - Date.parse(digest.fetched_at) < 12 * 3600_000 ? digest : null;
  const timeOf = (iso: string, allDay: boolean) => (allDay ? 'All day' : formatLocal(new Date(iso).toISOString(), timeZone, locale, true).replace(/^.*?(\d{1,2}[:.]\d{2}.*)$/, '$1'));
  const connected = fresh ? {
    fetched_at: fresh.fetched_at,
    events: fresh.events.filter((e) => (e.all_day ? String(e.start).slice(0, 10) : localDate(new Date(e.start), timeZone)) === day)
      .map((e) => ({ title: e.title, at: timeOf(e.start, e.all_day), location: e.location ?? null, account: e.account })),
    unread: fresh.unread_total,
    unreadFrom: fresh.unread.slice(0, 3).map((m) => ({ from: m.from, subject: m.subject })),
    awaiting: awaitingReplies(db, userId, fresh).slice(0, 5).map((m) => ({ id: m.id, from: m.from, subject: m.subject, account: m.account, provider: m.provider })),
    errors: fresh.errors.map((e) => e.account),
  } : null;
  const bills = billsDueSoon(db, userId, today, 3).map((b) => ({ id: b.id, name: b.name, amount: money.formatMoney(Number(b.amount), String(b.currency), locale), due: b.next_due, overdue: String(b.next_due) < today, book: b.book_name ?? null }));
  const apps = applicationsDue(db, userId, today);
  return {
    date: day,
    dateLabel: formatLocal(dayStart.toISOString(), timeZone, locale, false),
    timeZone,
    due: due.map(brief),
    overdue: overdue.map(brief),
    upcoming: upcoming.map(brief),
    reminders: reminders.map((r) => ({ id: r.id, title: r.title, at: fmt(r.remind_at) })),
    completedToday,
    completedYesterday,
    projects,
    pendingActions,
    proposedMemories,
    workload: { estimatedMinutes: estimate, tasksWithoutEstimate: unestimated },
    money: spending,
    connected,
    bills,
    applications: { deadlines: apps.deadlines.map((a) => ({ id: a.id, title: a.title, organisation: a.organisation, deadline: a.deadline })), followUps: apps.followUps.map((a) => ({ id: a.id, title: a.title, organisation: a.organisation })) },
  };
}

export type Overview = ReturnType<typeof buildOverview>;

/** A plain-language briefing written from the overview by code (no AI needed, never fabricated). */
export function briefingText(o: Overview, name: string, hourLocal: number): string {
  const greet = hourLocal < 12 ? 'Good morning' : hourLocal < 17 ? 'Good afternoon' : 'Good evening';
  const lines: string[] = [`${greet}${name ? `, ${name}` : ''}. Here is ${o.dateLabel}.`];
  const n = o.due.length;
  if (!n && !o.overdue.length) lines.push('Nothing is due today.');
  else {
    if (n) lines.push(`${n} task${n === 1 ? '' : 's'} due today${o.due[0] ? `, starting with "${o.due[0].title}"` : ''}.`);
    if (o.overdue.length) lines.push(`${o.overdue.length} overdue task${o.overdue.length === 1 ? '' : 's'} need a decision — finish, reschedule or drop.`);
  }
  const high = [...o.overdue, ...o.due].filter((t) => t.priority === 1);
  if (high.length) lines.push(`High priority: ${high.slice(0, 3).map((t) => t.title).join('; ')}.`);
  if (o.reminders.length) lines.push(`${o.reminders.length} reminder${o.reminders.length === 1 ? '' : 's'} scheduled today.`);
  if (o.completedYesterday.length) lines.push(`Yesterday you completed ${o.completedYesterday.length} task${o.completedYesterday.length === 1 ? '' : 's'}.`);
  if (o.pendingActions) lines.push(`${o.pendingActions} action${o.pendingActions === 1 ? ' is' : 's are'} waiting for your approval.`);
  if (o.proposedMemories) lines.push(`${o.proposedMemories} suggested memor${o.proposedMemories === 1 ? 'y is' : 'ies are'} waiting for review.`);
  const c = o.connected;
  if (c) {
    if (c.events.length) lines.push(`On your calendar: ${c.events.slice(0, 3).map((e) => `${e.at} ${e.title}`).join('; ')}${c.events.length > 3 ? ` and ${c.events.length - 3} more` : ''}.`);
    if (c.unread) lines.push(`${c.unread} unread email${c.unread === 1 ? '' : 's'}${c.unreadFrom[0] ? `, including ${c.unreadFrom[0].from}: “${c.unreadFrom[0].subject}”` : ''}.`);
    if (c.awaiting.length) lines.push(`${c.awaiting.length} email${c.awaiting.length === 1 ? ' is' : 's are'} waiting for your reply${c.awaiting[0] ? ` (${c.awaiting[0].from}: “${c.awaiting[0].subject}”)` : ''}.`);
  }
  if (o.bills.length) lines.push(`Bills due: ${o.bills.slice(0, 3).map((b) => `${b.name} (${b.amount}${b.overdue ? ', overdue' : ''})`).join('; ')}.`);
  if (o.applications.deadlines.length) lines.push(`Application deadline${o.applications.deadlines.length === 1 ? '' : 's'} this week: ${o.applications.deadlines.map((a) => `${a.title} (${a.deadline})`).join('; ')}.`);
  if (o.applications.followUps.length) lines.push(`Time to follow up: ${o.applications.followUps.map((a) => `${a.title}${a.organisation ? ` at ${a.organisation}` : ''}`).join('; ')}.`);
  const m = o.money;
  if (m) {
    if (m.weekTotal > 0) lines.push(`In the last 7 days you spent ${m.week}${m.top ? `, most on ${m.top}` : ''}.`);
    if (m.over.length) lines.push(`Over budget this month: ${m.over.join(', ')}.`);
    else if (m.near.length) lines.push(`Close to budget: ${m.near.join(', ')}.`);
  }
  return lines.join(' ');
}

/**
 * Evening review written from today's and tomorrow's overviews by code.
 * Unfinished = due today and still open (older overdue items are counted separately).
 */
export function eveningReviewText(today: Overview, tomorrow: Overview): string {
  const done = today.completedToday;
  const lines: string[] = [];
  lines.push(done.length
    ? `You completed ${done.length} task${done.length === 1 ? '' : 's'} today: ${done.slice(0, 3).map((t: any) => t.title).join('; ')}${done.length > 3 ? '…' : ''}.`
    : 'No tasks were marked complete today.');
  if (today.due.length) lines.push(`${today.due.length} task${today.due.length === 1 ? '' : 's'} due today ${today.due.length === 1 ? 'is' : 'are'} still open.`);
  if (today.overdue.length) lines.push(`${today.overdue.length} older overdue task${today.overdue.length === 1 ? '' : 's'} still need a decision.`);
  const next = [...today.overdue, ...today.due, ...tomorrow.due]
    .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9))
    .filter((t, i, all) => all.findIndex((x) => x.id === t.id) === i)
    .slice(0, 3);
  lines.push(next.length ? `Suggested priorities for tomorrow: ${next.map((t) => t.title).join('; ')}.` : 'Nothing is due tomorrow.');
  return lines.join(' ');
}

/** Suggestions derived from real data patterns — each one names the data it is based on. */
export function suggestions(o: Overview, db: Db, userId: string, now = new Date()) {
  const out: { text: string; basis: string; action?: string }[] = [];
  if (o.overdue.length) out.push({ text: `Reschedule or close ${o.overdue.length} overdue to-do(s)`, basis: 'Overdue to-dos' });
  void db; void userId; void now;
  for (const a of o.connected?.awaiting ?? []) out.push({ text: `Reply to ${a.from}: “${a.subject}”`, basis: 'No reply for 2+ days', action: 'reply' });
  for (const b of o.bills) if (b.overdue) out.push({ text: `Pay ${b.name} (${b.amount})`, basis: `Due ${b.due}`, action: 'money' });
  if (o.proposedMemories) out.push({ text: 'Review suggested memories', basis: `${o.proposedMemories} awaiting approval`, action: 'memories' });
  return out.slice(0, 6);
}
