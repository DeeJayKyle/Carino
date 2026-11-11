import type { Services } from '../context.ts';
import { notify } from './activity.ts';
import { getSettings } from './settings.ts';
import { localClock, localDate, safeTimeZone } from './time.ts';
import { buildOverview, briefingText, eveningReviewText } from './briefing.ts';
import { expireMemories } from './memory.ts';
import { parseJson } from '../db/index.ts';
import { runCustomRoutine } from './routines.ts';
import { nextReminderTime, type Recurrence } from './tasks.ts';

const MAX_ATTEMPTS = 5;

function inQuietHours(hhmm: string, start?: string, end?: string) {
  if (!start || !end || start === end) return false;
  return start < end ? hhmm >= start && hhmm < end : hhmm >= start || hhmm < end;
}

/**
 * Delivers due reminders. Runs on the server every 30 s, so reminders do not depend on
 * the browser being open. Each reminder is claimed atomically to avoid double delivery.
 */
export async function deliverDueReminders(services: Services) {
  const { db } = services;
  const now = services.now();
  const due = db.all(
    "SELECT * FROM reminders WHERE status = 'scheduled' AND remind_at <= ? ORDER BY remind_at LIMIT 100", now.toISOString(),
  );
  let delivered = 0;
  for (const r of due) {
    const settings = getSettings(db, r.user_id);
    const tz = safeTimeZone(settings.regional.timeZone);
    const { hhmm } = localClock(now, tz);
    const quiet = inQuietHours(hhmm, settings.notifications.quietHoursStart, settings.notifications.quietHoursEnd);
    if (quiet && r.attempts === 0) continue; // hold until quiet hours end
    const claim = db.run("UPDATE reminders SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'scheduled'", r.id);
    if (Number(claim.changes) === 0) continue;
    notify(db, r.user_id, { kind: 'reminder', title: r.title, body: r.body, link: r.task_id ? `/tasks?focus=${r.task_id}` : '/tasks' });
    let errorText: string | null = null;
    if (settings.notifications.push && services.push.configured()) {
      try {
        const res = await services.push.sendToUser(r.user_id, { title: `⏰ ${r.title}`, body: r.body || 'Reminder from Carino', url: r.task_id ? `/tasks?focus=${r.task_id}` : '/tasks', tag: `reminder-${r.id}` });
        if (res.sent === 0 && res.failed > 0) errorText = `Push failed: ${res.errors.join(', ')}`;
      } catch (err: any) {
        errorText = String(err?.message ?? err);
      }
    }
    if (errorText && r.attempts + 1 < MAX_ATTEMPTS) {
      // Back off and retry the push; the in-app notification is already stored.
      const retryAt = new Date(now.getTime() + 2 ** (r.attempts + 1) * 60_000).toISOString();
      db.run("UPDATE reminders SET status = 'scheduled', remind_at = ?, last_error = ? WHERE id = ?", retryAt, errorText, r.id);
    } else if (r.recurrence) {
      // Repeating: ring again at the next time (a failed push still moves on, it's already in the app).
      const rule = parseJson<Recurrence | null>(r.recurrence, null);
      const next = rule ? nextReminderTime(new Date(r.remind_at), rule, now).toISOString() : null;
      if (next) db.run("UPDATE reminders SET status = 'scheduled', remind_at = ?, sent_at = ?, attempts = 0, last_error = ? WHERE id = ?", next, now.toISOString(), errorText, r.id);
      else db.run("UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ?", now.toISOString(), r.id);
      delivered++;
    } else {
      db.run(
        'UPDATE reminders SET status = ?, sent_at = ?, last_error = ? WHERE id = ?',
        errorText ? 'failed' : 'sent', now.toISOString(), errorText, r.id,
      );
      if (errorText) notify(db, r.user_id, { kind: 'action_failed', title: 'A reminder could not be pushed to your devices', body: `${r.title}: ${errorText}`, link: '/settings#notifications' });
      delivered++;
    }
  }
  return delivered;
}

/**
 * Runs enabled routines (morning briefing, evening review) once per local day at their time.
 * Routines only notify and summarise; they never take actions beyond what the user approved.
 */
export async function runRoutines(services: Services) {
  const { db } = services;
  const now = services.now();
  const routines = db.all('SELECT * FROM routines WHERE enabled = 1');
  let ran = 0;
  for (const r of routines) {
    const settings = getSettings(db, r.user_id);
    const tz = safeTimeZone(settings.regional.timeZone);
    const today = localDate(now, tz);
    const { hhmm, weekday } = localClock(now, tz);
    if (r.last_run_on === today || hhmm < r.time_local) continue;
    if (!parseJson<number[]>(r.days, []).includes(weekday)) continue;
    // Don't fire a routine many hours late (e.g. after the server was offline overnight).
    const [h, m] = r.time_local.split(':').map(Number);
    const [ch, cm] = hhmm.split(':').map(Number);
    if (ch * 60 + cm - (h * 60 + m) > 180) {
      db.run('UPDATE routines SET last_run_on = ? WHERE id = ?', today, r.id);
      continue;
    }
    const claim = db.run('UPDATE routines SET last_run_on = ? WHERE id = ? AND (last_run_on IS NULL OR last_run_on != ?)', today, r.id, today);
    if (Number(claim.changes) === 0) continue;
    if (r.kind === 'custom') {
      try {
        await runCustomRoutine(services, r);
        ran++;
      } catch (err: any) {
        console.error('[routine]', r.title, err?.message ?? err);
        const msg = String(err?.message ?? err).slice(0, 300);
        db.run("UPDATE routines SET last_run_at = ?, last_status = 'failed', last_error = ? WHERE id = ?", now.toISOString(), msg, r.id);
        notify(db, r.user_id, { kind: 'action_failed', title: `Routine "${r.title}" failed`, body: msg, link: '/routines' });
      }
      continue;
    }
    try {
      const user = db.get('SELECT name FROM users WHERE id = ?', r.user_id);
      const o = buildOverview(db, r.user_id, now, tz, 0, settings.regional.locale);
      let title: string;
      let body: string;
      if (r.kind === 'evening_review') {
        title = 'Evening review';
        body = eveningReviewText(o, buildOverview(db, r.user_id, now, tz, 1, settings.regional.locale));
      } else {
        title = 'Your morning briefing';
        body = briefingText(o, settings.profile.displayName || user?.name || '', h);
      }
      notify(db, r.user_id, { kind: 'routine', title, body, link: '/' });
      if (settings.notifications.push && services.push.configured()) {
        await services.push.sendToUser(r.user_id, { title, body: body.slice(0, 240), url: '/', tag: `routine-${r.kind}` }).catch(() => undefined);
      }
      ran++;
      db.run("UPDATE routines SET last_run_at = ?, last_status = 'ok', last_error = NULL WHERE id = ?", now.toISOString(), r.id);
    } catch (err: any) {
      // One failing routine must not stop the others; record and surface the failure.
      console.error('[routine]', r.kind, err?.message ?? err);
      db.run("UPDATE routines SET last_run_at = ?, last_status = 'failed', last_error = ? WHERE id = ?", now.toISOString(), String(err?.message ?? err).slice(0, 300), r.id);
      notify(db, r.user_id, { kind: 'action_failed', title: 'A routine failed', body: `Your ${r.kind === 'evening_review' ? 'evening review' : 'morning briefing'} could not be prepared.`, link: '/settings' });
    }
  }
  return ran;
}

export function startScheduler(services: Services, intervalMs = 30_000) {
  let running = false;
  let routinesRunning = false;
  const tick = async () => {
    // Custom routines call the AI and can take a while, so they run beside the reminder loop
    // instead of holding it up.
    if (!routinesRunning) {
      routinesRunning = true;
      void runRoutines(services).catch((err) => console.error('[routines]', err)).finally(() => (routinesRunning = false));
    }
    if (running) return;
    running = true;
    try {
      // Recover reminders stuck in 'sending' after a crash.
      services.db.run("UPDATE reminders SET status = 'scheduled' WHERE status = 'sending' AND remind_at < ?", new Date(services.now().getTime() - 5 * 60_000).toISOString());
      await deliverDueReminders(services);
      expireMemories(services.db, services.now());
      services.db.run('DELETE FROM sessions WHERE expires_at < ?', services.now().toISOString());
      services.db.run('DELETE FROM client_ops WHERE created_at < ?', new Date(services.now().getTime() - 30 * 86400_000).toISOString());
    } catch (err) {
      console.error('[scheduler]', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
