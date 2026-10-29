import type { Db } from '../db/index.ts';
import { localDate, addDays } from './time.ts';

/** ISO week label (e.g. 2026-W44) of a local date (YYYY-MM-DD). */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week decides the year
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function recordVisit(db: Db, userId: string, now: Date, timeZone: string) {
  db.run('INSERT OR IGNORE INTO visits (user_id, week) VALUES (?, ?)', userId, isoWeek(localDate(now, timeZone)));
}

/** Consecutive weeks with a visit, counting back from this week (or last week, if not yet visited this week). */
export function weeklyStreak(db: Db, userId: string, now: Date, timeZone: string) {
  const weeks = new Set(db.all('SELECT week FROM visits WHERE user_id = ?', userId).map((r) => r.week as string));
  let day = localDate(now, timeZone);
  if (!weeks.has(isoWeek(day))) day = addDays(day, -7);
  let n = 0;
  while (weeks.has(isoWeek(day))) {
    n++;
    day = addDays(day, -7);
  }
  return { streak: n, weeksVisited: weeks.size };
}

export interface Challenge {
  id: 'regular' | 'doer' | 'friend' | 'chatty';
  title: string;
  blurb: string;
  /** The accessory Carino gets for it. */
  reward: 'crown' | 'headband' | 'cap' | 'chef';
  goal: number;
}

/** Long-running challenges. Each one earns Carino an accessory to wear. */
export const CHALLENGES: Challenge[] = [
  { id: 'regular', title: 'Four weeks in a row', blurb: 'Open Carino every week for four weeks.', reward: 'crown', goal: 4 },
  { id: 'doer', title: 'Get it done', blurb: 'Tick off 25 to-dos.', reward: 'headband', goal: 25 },
  { id: 'friend', title: 'Getting to know you', blurb: 'Let Carino remember 10 things about you.', reward: 'cap', goal: 10 },
  { id: 'chatty', title: 'Good company', blurb: 'Have 20 chats with Carino.', reward: 'chef', goal: 20 },
];

/** This week's small goals; they start again every Monday. */
function weeklyGoals(db: Db, userId: string, now: Date, timeZone: string) {
  const today = localDate(now, timeZone);
  const monday = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
  const since = new Date(`${monday}T00:00:00Z`).toISOString();
  const n = (sql: string) => Number(db.get(sql, userId, since)!.n);
  const goals = [
    { id: 'todos', title: 'Tick off 5 to-dos', goal: 5, progress: n("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status = 'done' AND completed_at >= ?") },
    { id: 'reminders', title: 'Set 2 reminders', goal: 2, progress: n('SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND created_at >= ?') },
    { id: 'ramble', title: 'Ramble it out once', goal: 1, progress: n("SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND entity = 'ramble' AND created_at >= ?") },
  ];
  return goals.map((g) => ({ ...g, progress: Math.min(g.progress, g.goal), done: g.progress >= g.goal }));
}

export function achievements(db: Db, userId: string, now: Date, timeZone: string) {
  const { streak, weeksVisited } = weeklyStreak(db, userId, now, timeZone);
  const count = (sql: string) => Number(db.get(sql, userId)!.n);
  const tasksDone = count("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status = 'done'");
  const progress: Record<Challenge['id'], number> = {
    regular: streak,
    doer: tasksDone,
    friend: count("SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND status = 'active'"),
    chatty: count('SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?'),
  };
  const challenges = CHALLENGES.map((ch) => ({ ...ch, progress: Math.min(progress[ch.id], ch.goal), done: progress[ch.id] >= ch.goal }));
  return {
    streak, weeksVisited, tasksDone,
    /** A 4-week streak earns the crown. */
    legendary: streak >= 4,
    challenges,
    weekly: weeklyGoals(db, userId, now, timeZone),
    /** Accessories the user can put on Carino. */
    accessories: ['none', 'party', ...challenges.filter((c) => c.done).map((c) => c.reward)],
  };
}

export function accessoryEarned(db: Db, userId: string, accessory: string, now: Date, timeZone: string) {
  return achievements(db, userId, now, timeZone).accessories.includes(accessory);
}

/** Counts for the "your week" card: the last 7 days, from the user's own data. */
export function weekInNumbers(db: Db, userId: string, now: Date) {
  const since = new Date(now.getTime() - 7 * 86400_000).toISOString();
  const n = (sql: string) => Number(db.get(sql, userId, since)!.n);
  return {
    tasksCompleted: n("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status = 'done' AND completed_at >= ?"),
    tasksAdded: n('SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND created_at >= ?'),
    remindersSent: n("SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND status = 'sent' AND sent_at >= ?"),
    memoriesSaved: n("SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND status = 'active' AND created_at >= ?"),
    routineRuns: n("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'routine' AND created_at >= ?"),
    chats: n('SELECT COUNT(*) AS n FROM conversations WHERE user_id = ? AND updated_at >= ?'),
  };
}
