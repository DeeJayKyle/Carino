import { z } from 'zod';
import type { Db, Row } from '../db/index.ts';
import { nowIso } from '../db/index.ts';
import { notFound } from '../context.ts';
import { addDays, startOfLocalDay } from './time.ts';
import { createReminder } from './tasks.ts';

/**
 * Jobs and scholarships the user is applying for. Deadlines and follow-ups use the normal reminders;
 * documents link to files already in Carino.
 */
export const KINDS = ['job', 'scholarship', 'other'] as const;
export const STATUSES = ['interested', 'preparing', 'applied', 'interview', 'offer', 'accepted', 'rejected', 'withdrawn'] as const;
export const STATUS_LABELS: Record<(typeof STATUSES)[number], string> = {
  interested: 'Interested', preparing: 'Preparing', applied: 'Applied', interview: 'Interview', offer: 'Offer',
  accepted: 'Accepted', rejected: 'Not successful', withdrawn: 'Withdrawn',
};
const CLOSED = new Set(['accepted', 'rejected', 'withdrawn']);
/** Follow up this many days after applying if nothing has been heard. */
export const FOLLOW_UP_DAYS = 14;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-01');
const fields = {
  kind: z.enum(KINDS), title: z.string().trim().min(1).max(200), organisation: z.string().trim().max(200), url: z.string().trim().max(500),
  location: z.string().trim().max(120), deadline: day.nullable(), status: z.enum(STATUSES), eligible: z.enum(['yes', 'no', 'unsure']),
  eligibility: z.string().trim().max(4000), value: z.string().trim().max(200), notes: z.string().trim().max(4000),
  next_step: z.string().trim().max(300), follow_up_on: day.nullable(), applied_on: day.nullable(),
};
export const applicationInput = z.object(fields).partial().required({ title: true });
/** An edit changes only the fields sent. */
export const applicationPatch = z.object(fields).partial().strict();

export const itemInput = z.object({
  kind: z.enum(['document', 'referee', 'requirement']), label: z.string().trim().min(1).max(200),
  status: z.enum(['needed', 'requested', 'ready', 'done']).default('needed'), document_id: z.string().max(64).nullable().optional(),
  contact: z.string().trim().max(200).optional(), note: z.string().trim().max(1000).optional(),
});
export const itemPatch = z.object({
  label: z.string().trim().min(1).max(200), status: z.enum(['needed', 'requested', 'ready', 'done']), document_id: z.string().max(64).nullable(),
  contact: z.string().trim().max(200), note: z.string().trim().max(1000),
}).partial().strict();

interface Ctx { today: string; timeZone: string; now: Date }

const at9 = (date: string, timeZone: string) => new Date(startOfLocalDay(date, timeZone).getTime() + 9 * 3600_000);

function event(db: Db, userId: string, appId: string, text: string) {
  db.insert('application_events', { user_id: userId, application_id: appId, text: text.slice(0, 500) });
}

function cancelReminder(db: Db, userId: string, id: unknown) {
  if (typeof id === 'string' && id) db.run("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'scheduled'", id, userId);
}

/** Reminders follow the dates: 3 days before the deadline (or the day itself if sooner), and on the follow-up day. */
function syncReminders(db: Db, userId: string, a: Row, ctx: Ctx) {
  const open = !CLOSED.has(String(a.status)) && a.status !== 'applied' && a.status !== 'interview' && a.status !== 'offer';
  cancelReminder(db, userId, a.deadline_reminder_id);
  let deadlineRem: string | null = null;
  if (a.deadline && open) {
    const early = at9(addDays(String(a.deadline), -3), ctx.timeZone);
    const when = early.getTime() > ctx.now.getTime() ? early : at9(String(a.deadline), ctx.timeZone);
    if (when.getTime() > ctx.now.getTime()) {
      deadlineRem = String(createReminder(db, userId, { title: `Deadline ${a.deadline}: ${a.title}${a.organisation ? ` (${a.organisation})` : ''}`, remind_at: when.toISOString() }).id);
    }
  }
  cancelReminder(db, userId, a.follow_up_reminder_id);
  let followRem: string | null = null;
  if (a.follow_up_on && !CLOSED.has(String(a.status))) {
    const when = at9(String(a.follow_up_on), ctx.timeZone);
    if (when.getTime() > ctx.now.getTime()) followRem = String(createReminder(db, userId, { title: `Follow up: ${a.title}${a.organisation ? ` at ${a.organisation}` : ''}`, remind_at: when.toISOString() }).id);
  }
  db.run('UPDATE applications SET deadline_reminder_id = ?, follow_up_reminder_id = ? WHERE id = ?', deadlineRem, followRem, a.id);
}

export function createApplication(db: Db, userId: string, raw: unknown, ctx: Ctx) {
  const i = applicationInput.parse(raw);
  const a = db.insert('applications', {
    user_id: userId, kind: i.kind ?? 'job', title: i.title, organisation: i.organisation ?? '', url: i.url ?? '', location: i.location ?? '',
    deadline: i.deadline ?? null, status: i.status ?? 'interested', eligible: i.eligible ?? 'unsure', eligibility: i.eligibility ?? '',
    value: i.value ?? '', notes: i.notes ?? '', next_step: i.next_step ?? '', follow_up_on: i.follow_up_on ?? null,
    applied_on: i.applied_on ?? (i.status === 'applied' ? ctx.today : null),
  });
  event(db, userId, String(a.id), `Added (${STATUS_LABELS[(i.status ?? 'interested') as keyof typeof STATUS_LABELS]})`);
  if (a.status === 'applied' && !a.follow_up_on) db.run('UPDATE applications SET follow_up_on = ? WHERE id = ?', addDays(String(a.applied_on ?? ctx.today), FOLLOW_UP_DAYS), a.id);
  syncReminders(db, userId, db.get('SELECT * FROM applications WHERE id = ?', a.id)!, ctx);
  return getApplication(db, userId, String(a.id));
}

export function updateApplication(db: Db, userId: string, id: string, raw: unknown, ctx: Ctx) {
  const before = db.getOwned('applications', userId, id);
  if (!before) throw notFound('Application');
  const i = applicationPatch.parse(raw);
  const changes: Record<string, any> = { ...i };
  if (i.status && i.status !== before.status) {
    event(db, userId, id, `${STATUS_LABELS[before.status as keyof typeof STATUS_LABELS] ?? before.status} → ${STATUS_LABELS[i.status]}`);
    // Applying starts the follow-up clock; an outcome ends it.
    if (i.status === 'applied') {
      changes.applied_on = i.applied_on ?? before.applied_on ?? ctx.today;
      if (i.follow_up_on === undefined) changes.follow_up_on = addDays(String(changes.applied_on), FOLLOW_UP_DAYS);
    }
    if (CLOSED.has(i.status) && i.follow_up_on === undefined) changes.follow_up_on = null;
  }
  if (i.notes !== undefined && i.notes !== before.notes && i.notes) event(db, userId, id, 'Notes updated');
  db.updateOwned('applications', userId, id, changes);
  syncReminders(db, userId, db.get('SELECT * FROM applications WHERE id = ?', id)!, ctx);
  return getApplication(db, userId, id);
}

export function deleteApplication(db: Db, userId: string, id: string) {
  const a = db.getOwned('applications', userId, id);
  if (!a) throw notFound('Application');
  cancelReminder(db, userId, a.deadline_reminder_id);
  cancelReminder(db, userId, a.follow_up_reminder_id);
  db.run('DELETE FROM applications WHERE id = ? AND user_id = ?', id, userId);
  return { deleted: true };
}

export function getApplication(db: Db, userId: string, id: string): Row & { items: Row[]; events: Row[]; progress: { total: number; ready: number; missing: string[] } } {
  const a = db.getOwned('applications', userId, id);
  if (!a) throw notFound('Application');
  const items = db.all(
    `SELECT i.*, d.filename AS document_name FROM application_items i LEFT JOIN documents d ON d.id = i.document_id AND d.user_id = i.user_id
     WHERE i.application_id = ? AND i.user_id = ? ORDER BY i.kind, i.created_at`, id, userId,
  );
  const events = db.all('SELECT text, created_at FROM application_events WHERE application_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50', id, userId);
  return { ...a, items, events, progress: progressOf(items) };
}

function progressOf(items: Row[]) {
  const total = items.length;
  const ready = items.filter((i) => i.status === 'ready' || i.status === 'done').length;
  return { total, ready, missing: items.filter((i) => i.status === 'needed' || i.status === 'requested').map((i) => String(i.label)) };
}

export function listApplications(db: Db, userId: string, opts: { kind?: string; open?: boolean } = {}) {
  const where = ['user_id = ?'];
  const params: any[] = [userId];
  if (opts.kind && (KINDS as readonly string[]).includes(opts.kind)) { where.push('kind = ?'); params.push(opts.kind); }
  if (opts.open) where.push("status NOT IN ('accepted','rejected','withdrawn')");
  return db.all(`SELECT * FROM applications WHERE ${where.join(' AND ')} ORDER BY status IN ('accepted','rejected','withdrawn'), deadline IS NULL, deadline, updated_at DESC LIMIT 300`, ...params)
    .map((a) => ({ ...a, progress: progressOf(db.all('SELECT label, status FROM application_items WHERE application_id = ?', a.id)) }));
}

export function addItem(db: Db, userId: string, appId: string, raw: unknown) {
  if (!db.getOwned('applications', userId, appId)) throw notFound('Application');
  const i = itemInput.parse(raw);
  if (i.document_id && !db.getOwned('documents', userId, i.document_id)) throw notFound('Document');
  const row = db.insert('application_items', {
    user_id: userId, application_id: appId, kind: i.kind, label: i.label, status: i.document_id && i.status === 'needed' ? 'ready' : i.status,
    document_id: i.document_id ?? null, contact: i.contact ?? '', note: i.note ?? '',
  });
  db.run('UPDATE applications SET updated_at = ? WHERE id = ?', nowIso(), appId);
  return row;
}

export function updateItem(db: Db, userId: string, itemId: string, raw: unknown) {
  const before = db.getOwned('application_items', userId, itemId);
  if (!before) throw notFound('Item');
  const i = itemPatch.parse(raw);
  if (i.document_id && !db.getOwned('documents', userId, i.document_id)) throw notFound('Document');
  const row = db.updateOwned('application_items', userId, itemId, { ...i });
  if (i.status && i.status !== before.status) event(db, userId, String(before.application_id), `${before.label}: ${i.status}`);
  return row;
}

export function deleteItem(db: Db, userId: string, itemId: string) {
  if (!Number(db.run('DELETE FROM application_items WHERE id = ? AND user_id = ?', itemId, userId).changes)) throw notFound('Item');
  return { deleted: true };
}

/** For the brief: deadlines in the next week, and follow-ups due. */
export function applicationsDue(db: Db, userId: string, today: string) {
  return {
    deadlines: db.all("SELECT id, title, organisation, deadline, status FROM applications WHERE user_id = ? AND status IN ('interested','preparing') AND deadline >= ? AND deadline <= ? ORDER BY deadline", userId, today, addDays(today, 7)),
    followUps: db.all("SELECT id, title, organisation, follow_up_on FROM applications WHERE user_id = ? AND status NOT IN ('accepted','rejected','withdrawn') AND follow_up_on IS NOT NULL AND follow_up_on <= ? ORDER BY follow_up_on", userId, today),
  };
}
