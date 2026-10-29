import { z } from 'zod';
import type { Db, Row } from '../db/index.ts';
import { parseJson } from '../db/index.ts';
import { indexEntity, unindexEntity } from './indexer.ts';
import { logActivity } from './activity.ts';
import { notFound, badRequest } from '../context.ts';

export const recurrenceSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(365).default(1),
  byweekday: z.array(z.number().int().min(0).max(6)).max(7).optional(),
});
export type Recurrence = z.infer<typeof recurrenceSchema>;

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');

export const taskInput = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(10_000).optional(),
  priority: z.number().int().min(1).max(3).optional(),
  category: z.string().max(60).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  due_at: isoDate.nullable().optional(),
  all_day: z.boolean().optional(),
  estimate_minutes: z.number().int().min(1).max(10_000).nullable().optional(),
  recurrence: recurrenceSchema.nullable().optional(),
  project_id: z.string().max(64).nullable().optional(),
  workspace_id: z.string().max(64).nullable().optional(),
  parent_id: z.string().max(64).nullable().optional(),
  remind_at: isoDate.nullable().optional(),
});
export type TaskInput = z.infer<typeof taskInput>;

export function presentTask(row: Row): Row {
  return {
    ...row,
    tags: parseJson<string[]>(row.tags, []),
    recurrence: parseJson<Recurrence | null>(row.recurrence, null),
    all_day: !!row.all_day,
  };
}

function assertRefs(db: Db, userId: string, input: Partial<TaskInput>) {
  if (input.project_id && !db.getOwned('projects', userId, input.project_id)) throw notFound('Project');
  if (input.workspace_id && !db.getOwned('workspaces', userId, input.workspace_id)) throw notFound('Workspace');
  if (input.parent_id && !db.getOwned('tasks', userId, input.parent_id)) throw notFound('Parent task');
}

function history(db: Db, userId: string, taskId: string, change: string) {
  db.insert('task_history', { user_id: userId, task_id: taskId, change });
}

function reindex(db: Db, userId: string, t: Row) {
  indexEntity(db, userId, 'task', t.id, t.title, `${t.description} ${t.category} ${parseJson<string[]>(t.tags, []).join(' ')}`);
}

export function createTask(db: Db, userId: string, raw: unknown) {
  const input = taskInput.parse(raw);
  assertRefs(db, userId, input);
  return db.tx(() => {
    let projectId = input.project_id ?? null;
    if (input.parent_id && !projectId) projectId = db.getOwned('tasks', userId, input.parent_id)!.project_id ?? null;
    const t = db.insert('tasks', {
      user_id: userId,
      title: input.title,
      description: input.description ?? '',
      priority: input.priority ?? 2,
      category: input.category ?? '',
      tags: JSON.stringify(input.tags ?? []),
      due_at: input.due_at ? new Date(input.due_at).toISOString() : null,
      all_day: input.all_day ? 1 : 0,
      estimate_minutes: input.estimate_minutes ?? null,
      recurrence: input.recurrence ? JSON.stringify(input.recurrence) : null,
      project_id: projectId,
      workspace_id: input.workspace_id ?? null,
      parent_id: input.parent_id ?? null,
    });
    history(db, userId, t.id, 'created');
    reindex(db, userId, t);
    if (input.remind_at) createReminder(db, userId, { title: t.title, remind_at: input.remind_at, task_id: t.id });
    logActivity(db, userId, { entity: 'task', entityId: t.id, verb: 'created', summary: `Task created: ${t.title}`, projectId });
    return presentTask(t);
  });
}

export function updateTask(db: Db, userId: string, id: string, raw: unknown) {
  const input = taskInput.partial().parse(raw);
  assertRefs(db, userId, input);
  if (input.parent_id === id) throw badRequest('A task cannot be its own parent');
  return db.tx(() => {
    const before = db.getOwned('tasks', userId, id);
    if (!before) throw notFound('Task');
    const t = db.updateOwned('tasks', userId, id, {
      title: input.title,
      description: input.description,
      priority: input.priority,
      category: input.category,
      tags: input.tags ? JSON.stringify(input.tags) : undefined,
      due_at: input.due_at === undefined ? undefined : input.due_at ? new Date(input.due_at).toISOString() : null,
      all_day: input.all_day === undefined ? undefined : input.all_day ? 1 : 0,
      estimate_minutes: input.estimate_minutes,
      recurrence: input.recurrence === undefined ? undefined : input.recurrence ? JSON.stringify(input.recurrence) : null,
      project_id: input.project_id,
      workspace_id: input.workspace_id,
      parent_id: input.parent_id,
    })!;
    const changed = Object.keys(input).filter((k) => k !== 'remind_at');
    if (changed.length) history(db, userId, id, `updated ${changed.join(', ')}`);
    if (input.remind_at) createReminder(db, userId, { title: t.title, remind_at: input.remind_at, task_id: id });
    reindex(db, userId, t);
    return presentTask(t);
  });
}

/** Completes a task. Recurring tasks spawn their next occurrence (with a shifted reminder). */
export function completeTask(db: Db, userId: string, id: string, now = new Date()) {
  return db.tx(() => {
    const t = db.getOwned('tasks', userId, id);
    if (!t) throw notFound('Task');
    if (t.status === 'done') return { task: presentTask(t), next: null };
    const done = db.updateOwned('tasks', userId, id, { status: 'done', completed_at: now.toISOString() })!;
    history(db, userId, id, 'completed');
    db.run("UPDATE reminders SET status = 'cancelled' WHERE task_id = ? AND user_id = ? AND status = 'scheduled'", id, userId);
    logActivity(db, userId, { entity: 'task', entityId: id, verb: 'completed', summary: `Completed: ${t.title}`, projectId: t.project_id });

    let next = null;
    const rule = parseJson<Recurrence | null>(t.recurrence, null);
    if (rule && t.due_at) {
      const nextDue = nextOccurrence(new Date(t.due_at), rule);
      const created = db.insert('tasks', {
        user_id: userId, title: t.title, description: t.description, priority: t.priority, category: t.category,
        tags: t.tags, due_at: nextDue.toISOString(), all_day: t.all_day, estimate_minutes: t.estimate_minutes,
        recurrence: t.recurrence, project_id: t.project_id, workspace_id: t.workspace_id, parent_id: t.parent_id,
      });
      history(db, userId, created.id, `created as next occurrence of ${id}`);
      reindex(db, userId, created);
      const lastReminder = db.get(
        'SELECT remind_at FROM reminders WHERE task_id = ? AND user_id = ? ORDER BY remind_at DESC LIMIT 1', id, userId,
      );
      if (lastReminder) {
        const lead = new Date(t.due_at).getTime() - new Date(lastReminder.remind_at).getTime();
        createReminder(db, userId, { title: t.title, remind_at: new Date(nextDue.getTime() - lead).toISOString(), task_id: created.id });
      }
      next = presentTask(created);
    }
    return { task: presentTask(done), next };
  });
}

export function reopenTask(db: Db, userId: string, id: string) {
  const t = db.updateOwned('tasks', userId, id, { status: 'open', completed_at: null });
  if (!t) throw notFound('Task');
  history(db, userId, id, 'reopened');
  return presentTask(t);
}

export function deleteTask(db: Db, userId: string, id: string) {
  return db.tx(() => {
    const t = db.getOwned('tasks', userId, id);
    if (!t) throw notFound('Task');
    const ids = [id, ...db.all('SELECT id FROM tasks WHERE parent_id = ? AND user_id = ?', id, userId).map((r) => r.id)];
    for (const tid of ids) unindexEntity(db, userId, 'task', tid);
    db.deleteOwned('tasks', userId, id);
    logActivity(db, userId, { entity: 'task', entityId: id, verb: 'deleted', summary: `Deleted task: ${t.title}`, projectId: t.project_id });
    return { deleted: true, title: t.title };
  });
}

export function nextOccurrence(from: Date, rule: Recurrence): Date {
  const d = new Date(from);
  const n = rule.interval ?? 1;
  switch (rule.freq) {
    case 'daily':
      d.setUTCDate(d.getUTCDate() + n);
      return d;
    case 'weekly': {
      if (rule.byweekday?.length) {
        // Next listed weekday; when it falls in a later week, skip (interval - 1) extra weeks.
        for (let i = 1; i <= 7; i++) {
          const c = new Date(from.getTime() + i * 86400_000);
          if (!rule.byweekday.includes(c.getUTCDay())) continue;
          const sameWeek = from.getUTCDay() + i < 7;
          return sameWeek ? c : new Date(c.getTime() + (n - 1) * 7 * 86400_000);
        }
      }
      d.setUTCDate(d.getUTCDate() + 7 * n);
      return d;
    }
    case 'monthly': {
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + n);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, last));
      return d;
    }
    case 'yearly':
      d.setUTCFullYear(d.getUTCFullYear() + n);
      return d;
  }
}

export const reminderInput = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().max(2000).optional(),
  remind_at: isoDate,
  task_id: z.string().max(64).nullable().optional(),
});

export function createReminder(db: Db, userId: string, raw: unknown) {
  const input = reminderInput.parse(raw);
  if (input.task_id && !db.getOwned('tasks', userId, input.task_id)) throw notFound('Task');
  return db.insert('reminders', {
    user_id: userId,
    title: input.title,
    body: input.body ?? '',
    remind_at: new Date(input.remind_at).toISOString(),
    task_id: input.task_id ?? null,
  });
}

export type TaskView = 'today' | 'upcoming' | 'overdue' | 'completed' | 'all' | 'inbox';

export function listTasks(
  db: Db,
  userId: string,
  opts: { view?: TaskView; q?: string; project_id?: string; tag?: string; priority?: number; sort?: string; dayStart: Date; dayEnd: Date; now: Date; limit?: number },
) {
  const where = ['t.user_id = ?'];
  const params: any[] = [userId];
  const nowIsoStr = opts.now.toISOString();
  switch (opts.view) {
    case 'today':
      where.push("t.status = 'open' AND t.due_at IS NOT NULL AND t.due_at < ?");
      params.push(opts.dayEnd.toISOString());
      break;
    case 'upcoming':
      where.push("t.status = 'open' AND t.due_at >= ?");
      params.push(opts.dayEnd.toISOString());
      break;
    case 'overdue':
      where.push("t.status = 'open' AND t.due_at < ? AND NOT (t.all_day = 1 AND t.due_at >= ?)");
      params.push(nowIsoStr, opts.dayStart.toISOString());
      break;
    case 'completed':
      where.push("t.status = 'done'");
      break;
    case 'inbox':
      where.push("t.status = 'open' AND t.due_at IS NULL");
      break;
    default:
      break;
  }
  if (opts.project_id) {
    where.push('t.project_id = ?');
    params.push(opts.project_id);
  }
  if (opts.priority) {
    where.push('t.priority = ?');
    params.push(opts.priority);
  }
  if (opts.tag) {
    where.push('EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = ?)');
    params.push(opts.tag);
  }
  if (opts.q) {
    where.push('(t.title LIKE ? OR t.description LIKE ?)');
    params.push(`%${opts.q}%`, `%${opts.q}%`);
  }
  const order =
    opts.sort === 'priority' ? 't.priority ASC, t.due_at IS NULL, t.due_at ASC'
    : opts.sort === 'created' ? 't.created_at DESC'
    : opts.view === 'completed' ? 't.completed_at DESC'
    : 't.due_at IS NULL, t.due_at ASC, t.priority ASC, t.created_at DESC';
  const rows = db.all(
    `SELECT t.*, p.name AS project_name,
       (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id) AS subtask_count,
       (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id AND s.status = 'done') AS subtask_done,
       (SELECT MIN(remind_at) FROM reminders r WHERE r.task_id = t.id AND r.status = 'scheduled') AS next_reminder
     FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
     WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
    ...params, Math.min(opts.limit ?? 500, 5000),
  );
  return rows.map(presentTask);
}

/** How many tasks match a list's filters, so the page can say "500 of 1,240" and offer more. */
export function countTasks(db: Db, userId: string, opts: Parameters<typeof listTasks>[2]): number {
  return listTasks(db, userId, { ...opts, limit: 5000 }).length;
}

// ---------- Dependencies & workload ----------

/** Records that `taskId` depends on `dependsOnId`. Both must be the user's, and cycles are refused. */
export function addDependency(db: Db, userId: string, taskId: string, dependsOnId: string) {
  if (!db.getOwned('tasks', userId, taskId)) throw notFound('Task');
  if (!db.getOwned('tasks', userId, dependsOnId)) throw notFound('Task');
  if (taskId === dependsOnId) throw badRequest('A task cannot depend on itself.');
  // Walk what dependsOnId (transitively) depends on; reaching taskId would form a cycle.
  const seen = new Set<string>();
  const stack = [dependsOnId];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === taskId) throw badRequest('That would create a circular dependency.');
    if (seen.has(id)) continue;
    seen.add(id);
    for (const r of db.all('SELECT depends_on_id FROM task_dependencies WHERE task_id = ? AND user_id = ?', id, userId)) stack.push(r.depends_on_id);
  }
  db.run('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, user_id) VALUES (?, ?, ?)', taskId, dependsOnId, userId);
  history(db, userId, taskId, 'dependency added');
  return listDependencies(db, userId, taskId);
}

export function removeDependency(db: Db, userId: string, taskId: string, dependsOnId: string) {
  const r = db.run('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ? AND user_id = ?', taskId, dependsOnId, userId);
  if (Number(r.changes) === 0) throw notFound('Dependency');
  history(db, userId, taskId, 'dependency removed');
  return listDependencies(db, userId, taskId);
}

export function listDependencies(db: Db, userId: string, taskId: string) {
  const cols = 't.id, t.title, t.status, t.due_at, t.priority';
  return {
    depends_on: db.all(`SELECT ${cols} FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_id WHERE d.task_id = ? AND d.user_id = ? ORDER BY t.due_at`, taskId, userId),
    blocks: db.all(`SELECT ${cols} FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE d.depends_on_id = ? AND d.user_id = ? ORDER BY t.due_at`, taskId, userId),
  };
}

/**
 * Planned load per local day from open tasks' due dates and estimates, plus concrete conflicts:
 * days over capacity, and tasks due before a task they depend on.
 */
export function workload(db: Db, userId: string, dayBounds: { date: string; start: string; end: string }[], capacityMinutes: number) {
  const days = dayBounds.map((d) => {
    const rows = db.all(
      "SELECT id, title, estimate_minutes FROM tasks WHERE user_id = ? AND status = 'open' AND due_at >= ? AND due_at < ? ORDER BY priority, due_at",
      userId, d.start, d.end,
    );
    const minutes = rows.reduce((a, t) => a + (t.estimate_minutes ?? 0), 0);
    return {
      date: d.date, tasks: rows.length, estimatedMinutes: minutes,
      unestimated: rows.filter((t) => !t.estimate_minutes).length, overCapacity: minutes > capacityMinutes,
    };
  });
  const dependencyConflicts = db.all(
    `SELECT a.id AS task_id, a.title AS task_title, a.due_at AS task_due, b.id AS depends_on_id, b.title AS depends_on_title, b.due_at AS depends_on_due
     FROM task_dependencies d JOIN tasks a ON a.id = d.task_id JOIN tasks b ON b.id = d.depends_on_id
     WHERE d.user_id = ? AND a.status = 'open' AND b.status = 'open' AND a.due_at IS NOT NULL AND b.due_at IS NOT NULL AND b.due_at > a.due_at
     ORDER BY a.due_at LIMIT 50`,
    userId,
  );
  return { capacityMinutes, days, dependencyConflicts };
}
