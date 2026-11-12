import { z } from 'zod';
import type { Services } from '../context.ts';
import { HttpError, badRequest } from '../context.ts';
import type { Db, Row } from '../db/index.ts';
import { parseJson } from '../db/index.ts';
import { notify } from './activity.ts';
import { ACCESS_IDS, allowedToolsFor, describeAccess } from './routine-access.ts';
import { getSettings } from './settings.ts';

export const MAX_CUSTOM_ROUTINES = 25;
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAYS = [1, 2, 3, 4, 5];

export interface RoutineIdea {
  id: string;
  category: 'Plan' | 'Work' | 'Money' | 'Health' | 'Family & friends' | 'Learn' | 'Stay informed' | 'Connected apps';
  icon: string;
  title: string;
  blurb: string;
  prompt: string;
  time: string;
  days: number[];
  /** What the idea relies on beyond Carino's own data, so the UI can say so up front. */
  needs?: ('web_search' | 'connector')[];
}

/**
 * Ready-made routine ideas. Text in [square brackets] is for the user to fill in before adding.
 * Every prompt keeps consequential steps (sending, buying, deleting) with the user.
 */
export const ROUTINE_IDEAS: RoutineIdea[] = [
  {
    id: 'week-ahead', category: 'Plan', icon: 'calendar', title: 'Sunday week-ahead',
    blurb: 'A calm look at the coming week, with overloaded days flagged.',
    prompt: 'Look at my tasks, deadlines and reminders for the next 7 days and check my workload. Give me a short day-by-day outline, point out any overloaded day or dependency conflict, and suggest what could move. Do not move anything yourself.',
    time: '18:00', days: [0],
  },
  {
    id: 'overdue-sweep', category: 'Plan', icon: 'clock', title: 'Midday overdue sweep',
    blurb: 'Catches tasks that slipped, before the afternoon gets away.',
    prompt: 'List my overdue tasks. For each, suggest one of: do today, move to a specific day, or drop. Keep it to one line per task. If nothing is overdue, just say so.',
    time: '12:30', days: WEEKDAYS,
  },
  {
    id: 'no-date-tasks', category: 'Plan', icon: 'tasks', title: 'Undated tasks check',
    blurb: 'Gives your “someday” tasks a realistic date.',
    prompt: 'List my tasks that have no due date. Suggest a sensible due date for the five most important ones, based on their priority and my workload. Ask before changing anything.',
    time: '09:00', days: [3],
  },
  {
    id: 'work-wins', category: 'Work', icon: 'flag', title: 'Friday wins log',
    blurb: 'Keeps a running record of what you got done — handy for reviews.',
    prompt: 'Look at the tasks I completed in the last 7 days and give me a short bulleted list of the meaningful ones for my wins log, then tell me the top three.',
    time: '16:30', days: [5],
  },
  {
    id: 'business-followups', category: 'Work', icon: 'briefcase', title: 'Business follow-ups',
    blurb: 'Supplier, stock and customer follow-ups due this week.',
    prompt: 'Look through my to-dos, reminders and memories for supplier, stock, order, payment or customer follow-ups that are due or mentioned for this week. List them with what is needed and by when.',
    time: '08:00', days: [1],
  },
  {
    id: 'price-watch', category: 'Money', icon: 'target', title: 'Price watch',
    blurb: 'Checks a price daily and tells you when it drops.',
    prompt: 'Search the web for the current price of [item] from [shop or website]. If it is at or below [target price], tell me with the link. Otherwise reply in one line with today\'s price. Never buy anything.',
    time: '09:00', days: EVERY_DAY, needs: ['web_search'],
  },
  {
    id: 'money-checkin', category: 'Money', icon: 'chart', title: 'Weekly money check-in',
    blurb: 'Bills, payments and money tasks coming up.',
    prompt: 'Find my to-dos, reminders and memories about bills, payments, invoices, rent, fees or subscriptions due in the next 10 days. List them by date with amounts if I saved them. Remind me to review my spending this week.',
    time: '19:00', days: [5],
  },
  {
    id: 'water-walk', category: 'Health', icon: 'heart', title: 'Afternoon move & water',
    blurb: 'One friendly nudge a day — different each time.',
    prompt: 'Send me one short, friendly line reminding me to drink some water and stretch or take a short walk. Vary the wording from previous days in this conversation.',
    time: '15:00', days: WEEKDAYS,
  },
  {
    id: 'meal-plan', category: 'Health', icon: 'heart', title: 'Meal plan for the week',
    blurb: 'Five simple dinners and a shopping list.',
    prompt: 'Using any food preferences you remember about me, plan five simple dinners for this week and a combined shopping list grouped by section. Offer to add the shopping list as a to-do.',
    time: '17:00', days: [0],
  },
  {
    id: 'occasions', category: 'Family & friends', icon: 'sparkle', title: 'Birthdays & occasions',
    blurb: 'Never miss a birthday or anniversary you told Carino about.',
    prompt: 'Check my memories, to-dos and reminders for birthdays, anniversaries and other occasions in the next 14 days. List them with the date, and suggest one thoughtful idea for each. If there are none, say so in one line.',
    time: '08:00', days: [1],
  },
  {
    id: 'bedtime-story', category: 'Family & friends', icon: 'moon', title: 'Bedtime story',
    blurb: 'A new short story each night, starring your child.',
    prompt: 'Write a gentle bedtime story that takes about three minutes to read aloud, starring [child\'s name], aged [age], who loves [favourite things]. Make it different from earlier stories in this conversation and end calmly.',
    time: '19:00', days: EVERY_DAY,
  },
  {
    id: 'daily-lesson', category: 'Learn', icon: 'book', title: 'Daily mini-lesson',
    blurb: 'Five minutes a day on a subject, building lesson by lesson.',
    prompt: 'Teach me one short lesson about [subject], building on the earlier lessons in this conversation. Keep it under 300 words, give one example, and end with a single quiz question I can answer tomorrow.',
    time: '07:30', days: WEEKDAYS,
  },
  {
    id: 'topic-news', category: 'Stay informed', icon: 'globe', title: 'News on a topic',
    blurb: 'The most important updates on something you follow, with sources.',
    prompt: 'Search the web for the most important news about [topic] from the last 24 hours. Give me three to five bullet points, each with its source link. Skip anything that is only speculation.',
    time: '07:00', days: EVERY_DAY, needs: ['web_search'],
  },
  {
    id: 'ai-brief', category: 'Connected apps', icon: 'sun', title: 'One clear daily brief',
    blurb: 'Tasks, calendar, email and messages from your connected apps, in one summary.',
    prompt: 'Give me one clear brief for today. Use my to-dos and reminders, and — if I have connected apps — today\'s calendar, emails waiting on me and important messages. Lead with the three things that matter most, then anything I need to reply to, then the rest in short bullets. Skip anything that doesn\'t need me.',
    time: '07:15', days: [1, 2, 3, 4, 5, 6, 0], needs: ['connector'],
  },
  {
    id: 'email-triage', category: 'Connected apps', icon: 'send', title: 'Email needing a reply',
    blurb: 'Uses your connected email app to list what is waiting on you.',
    prompt: 'Using my connected email app, find emails from the last day that ask me a direct question or are waiting on my reply. List them with the sender and a one-line summary. Skip newsletters. Do not send or draft anything.',
    time: '08:15', days: WEEKDAYS, needs: ['connector'],
  },
  {
    id: 'meeting-prep', category: 'Connected apps', icon: 'calendar', title: 'Meeting prep',
    blurb: 'Uses your connected calendar to prepare you for today’s meetings.',
    prompt: 'Using my connected calendar, list today\'s meetings. For each, add anything relevant from my to-dos and memories, and one question I might want to ask.',
    time: '07:45', days: WEEKDAYS, needs: ['connector'],
  },
];

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 07:30');
const days = z.array(z.number().int().min(0).max(6)).min(1, 'Pick at least one day').max(7);

/** Life goals a routine can belong to. */
export const GOALS = ['career', 'family', 'money', 'friends', 'kids', 'health', 'travel', 'home', 'learning', 'other'] as const;
const goal = z.enum(GOALS).nullable().optional();

export const routineInput = z.object({
  title: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(5).max(2000),
  time_local: time,
  days: days.default(EVERY_DAY),
  catalog_id: z.string().max(60).optional(),
  enabled: z.boolean().default(true),
  steps: z.array(z.string().trim().min(1).max(400)).max(12).optional(),
  /** Access groups this routine may use; omitted or null means everything (as before). */
  access: z.array(z.enum(ACCESS_IDS as [string, ...string[]])).max(20).nullable().optional(),
  goal,
});

export const routineUpdate = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  prompt: z.string().trim().min(5).max(2000).optional(),
  time_local: time.optional(),
  days: days.optional(),
  enabled: z.boolean().optional(),
  steps: z.array(z.string().trim().min(1).max(400)).max(12).optional(),
  access: z.array(z.enum(ACCESS_IDS as [string, ...string[]])).max(20).nullable().optional(),
  goal,
});

export function presentRoutine(r: Row): Row {
  return {
    ...r,
    enabled: !!r.enabled,
    days: parseJson(r.days, []),
    approved_actions: parseJson(r.approved_actions, []),
    steps: parseJson(r.steps, []),
    access: parseJson(r.access, null),
    access_summary: describeAccess(parseJson(r.access, null)),
    custom: r.kind === 'custom',
    title: r.title || (r.kind === 'evening_review' ? 'Evening review' : r.kind === 'morning_briefing' ? 'Morning briefing' : r.kind),
  };
}

export function listRoutines(db: Db, userId: string) {
  return db.all("SELECT * FROM routines WHERE user_id = ? ORDER BY kind = 'custom', time_local", userId).map(presentRoutine);
}

export function createRoutine(db: Db, userId: string, raw: unknown) {
  const i = routineInput.parse(raw);
  const n = Number(db.get("SELECT COUNT(*) AS n FROM routines WHERE user_id = ? AND kind = 'custom'", userId)!.n);
  if (n >= MAX_CUSTOM_ROUTINES) throw badRequest(`You can have up to ${MAX_CUSTOM_ROUTINES} custom routines. Delete one you no longer use first.`);
  if (/\[[^\]]+\]/.test(i.prompt)) throw badRequest('Fill in the parts in [square brackets] before adding this routine.');
  return presentRoutine(db.insert('routines', {
    user_id: userId, kind: 'custom', title: i.title, prompt: i.prompt, time_local: i.time_local,
    days: JSON.stringify(i.days), catalog_id: i.catalog_id ?? null, enabled: i.enabled ? 1 : 0,
    steps: i.steps?.length ? JSON.stringify(i.steps) : null,
    access: i.access ? JSON.stringify([...new Set(i.access)]) : null,
    goal: i.goal ?? null,
  }));
}

export function updateRoutine(db: Db, userId: string, id: string, raw: unknown) {
  const i = routineUpdate.parse(raw);
  const existing = db.getOwned('routines', userId, id);
  if (!existing) throw new HttpError(404, 'Routine not found', 'not_found');
  if ((i.title !== undefined || i.prompt !== undefined) && existing.kind !== 'custom') throw badRequest('Built-in routines can only change their time, days and on/off switch.');
  if (i.prompt && /\[[^\]]+\]/.test(i.prompt)) throw badRequest('Fill in the parts in [square brackets] first.');
  if ((i.steps !== undefined || i.access !== undefined) && existing.kind !== 'custom') throw badRequest('Built-in routines can only change their time, days and on/off switch.');
  const row = db.updateOwned('routines', userId, id, {
    title: i.title, prompt: i.prompt, time_local: i.time_local,
    days: i.days ? JSON.stringify(i.days) : undefined,
    enabled: i.enabled === undefined ? undefined : i.enabled ? 1 : 0,
    steps: i.steps === undefined ? undefined : i.steps.length ? JSON.stringify(i.steps) : null,
    access: i.access === undefined ? undefined : i.access === null ? null : JSON.stringify([...new Set(i.access)]),
    goal: i.goal === undefined ? undefined : i.goal,
  }, false);
  return presentRoutine(row!);
}

export function deleteRoutine(db: Db, userId: string, id: string) {
  const r = db.getOwned('routines', userId, id);
  if (!r) throw new HttpError(404, 'Routine not found', 'not_found');
  if (r.kind !== 'custom') throw badRequest('Built-in routines can be switched off but not deleted.');
  db.deleteOwned('routines', userId, id);
  return { deleted: true, title: r.title };
}

function stepLines(steps: string[]) {
  return steps.length ? ['', 'Steps, in order:', ...steps.map((st, n) => `${n + 1}. ${st}`)] : [];
}

/** Plain-text preview of a reply for a notification: Markdown markers stripped, first lines only. */
export function previewText(markdown: string, max = 240) {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^>\s?.*$/gm, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/**
 * Runs a custom routine as a normal agent turn in the routine's own conversation, so its
 * history (earlier lessons, stories, prices) carries forward and every step is visible.
 * Tool permissions are the user's usual ones: anything needing approval is queued, not done.
 * A routine with an access list can use only those tools (the agent enforces it).
 */
export async function runCustomRoutine(services: Services, routine: Row) {
  const { db } = services;
  const user = db.get('SELECT id, email, name FROM users WHERE id = ?', routine.user_id);
  if (!user) throw new Error('User not found');
  let conversationId = routine.conversation_id as string | null;
  if (!conversationId || !db.getOwned('conversations', user.id, conversationId)) {
    const conv = db.insert('conversations', { user_id: user.id, title: `Routine: ${routine.title}` });
    conversationId = conv.id;
    db.run('UPDATE routines SET conversation_id = ? WHERE id = ?', conversationId, routine.id);
  }
  // Imported lazily: the agent imports the tool registry, which imports this module.
  const { runTurn } = await import('../ai/agent.ts');
  const instruction = [
    `[Scheduled routine "${routine.title}". The user is not watching right now; they will see your reply as a notification and in this conversation.`,
    'Do what the routine asks using your tools and their saved data, then reply with a short, useful result. If nothing needs their attention, say so in one line.',
    'Anything that needs approval will wait for them — say so if that happens.]',
    '',
    routine.prompt,
    ...stepLines(parseJson(routine.steps, [])),
  ].join('\n');
  const allowedTools = allowedToolsFor(parseJson(routine.access, null));
  const { message } = await runTurn(services, user as any, conversationId!, instruction, { emit: () => {}, allowedTools });
  const reply = String(message?.content ?? '').trim() || 'The routine ran but produced no reply.';
  const now = services.now().toISOString();
  db.run("UPDATE routines SET last_run_at = ?, last_status = 'ok', last_error = NULL, last_result = ? WHERE id = ?", now, reply.slice(0, 4000), routine.id);
  const link = `/chat/${conversationId}`;
  notify(db, user.id, { kind: 'routine', title: routine.title, body: previewText(reply, 600), link });
  const settings = getSettings(db, user.id);
  if (settings.notifications.push && services.push.configured()) {
    await services.push.sendToUser(user.id, { title: routine.title, body: previewText(reply), url: link, tag: `routine-${routine.id}` }).catch(() => undefined);
  }
  return { reply, conversation_id: conversationId, ran_at: now };
}
