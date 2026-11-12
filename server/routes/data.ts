import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../context.ts';
import { notFound, badRequest, HttpError } from '../context.ts';
import { parseJson, nowIso } from '../db/index.ts';
import * as tasks from '../services/tasks.ts';
import * as money from '../services/money.ts';
import * as finance from '../services/finance.ts';
import * as applications from '../services/applications.ts';
import * as backup from '../services/backup.ts';
import * as inbox from '../services/inbox.ts';
import * as sync from '../services/sync.ts';
import * as files from '../services/localfiles.ts';
import { notify } from '../services/activity.ts';
import * as memory from '../services/memory.ts';
import * as routines from '../services/routines.ts';
import { ACCESS_GROUPS } from '../services/routine-access.ts';
import { extractRamble, applyRamble, MAX_RAMBLE_CHARS } from '../services/ramble.ts';
import * as connectors from '../services/connectors.ts';
import { startOAuth, finishOAuth } from '../services/mcp-oauth.ts';
import * as apps from '../services/apps/accounts.ts';
import { APP_TOOLS } from '../services/apps/index.ts';
import * as achievements from '../services/achievements.ts';
import { DISCOVER } from '../services/discover.ts';
import * as channels from '../services/channels.ts';
import { connectTelegram } from '../services/telegram.ts';
import { connectWhatsApp, webhookUrl } from '../services/whatsapp.ts';
import { connectRelay, pollRelay, relayAppSecret } from '../services/whatsapp-relay.ts';
import { deployRelay } from '../services/relay-deploy.ts';
import { startSharedLink, sharedLinkStatus, unlinkShared, isShared } from '../services/whatsapp-shared.ts';
import { helperConfig } from '../services/helper.ts';
import { transcriptionConfigured } from '../services/transcribe.ts';
import { getSettings, updateSettings } from '../services/settings.ts';
import { buildOverview, briefingText, suggestions } from '../services/briefing.ts';
import { searchIndex } from '../services/indexer.ts';
import { localDate, startOfLocalDay, addDays, safeTimeZone, localClock, parseWhen, formatLocal } from '../services/time.ts';
import { learnVoice, forgetVoice } from '../services/voice.ts';
import { approveAction, rejectAction, editAction, TOOLS, executeTool, makeContext } from '../tools/registry.ts';
import { rateLimit } from '../middleware.ts';

const page = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) });

export function dataRoutes() {
  const r = new Hono<AppEnv>();
  // Each of these is a full AI request, so they get their own per-user limit.
  const aiLimit = rateLimit({ name: 'ai-actions', windowMs: 60_000, max: 10, key: (c) => c.var.user.id });
  const connectLimit = rateLimit({ name: 'connectors', windowMs: 60_000, max: 10, key: (c) => c.var.user.id });
  const uid = (c: any) => c.var.user.id as string;
  const db = (c: any) => c.var.services.db as AppEnv['Variables']['services']['db'];
  const tzOf = (c: any) => safeTimeZone(getSettings(db(c), uid(c)).regional.timeZone);
  const body = async (c: any) => c.req.json().catch(() => {
    throw badRequest('Request body must be JSON');
  });

  // ---------- Settings ----------
  r.get('/settings', (c) => c.json(getSettings(db(c), uid(c))));
  r.patch('/settings', async (c) => {
    const patchBody = await body(c);
    const acc = patchBody?.profile?.mascotAccessory;
    if (acc && acc !== 'auto' && !achievements.accessoryEarned(db(c), uid(c), acc, c.var.services.now(), tzOf(c))) {
      throw badRequest('Carino hasn’t earned that one yet.');
    }
    return c.json(updateSettings(db(c), uid(c), patchBody));
  });
  /** Counts for the "Your stuff" hub: everything Carino is holding for you, in one place. */
  r.get('/stuff', (c) => {
    const u = uid(c);
    const { now } = c.var.services;
    const tz = tzOf(c);
    const today = localDate(now(), tz);
    const dayEnd = startOfLocalDay(addDays(today, 1), tz).toISOString();
    const nowIso = now().toISOString();
    const week = new Date(now().getTime() + 7 * 86400_000).toISOString();
    const n = (sql: string, ...p: any[]) => Number(db(c).get(sql, u, ...p)!.n);
    const nextReminder = db(c).get("SELECT title, remind_at FROM reminders WHERE user_id = ? AND status = 'scheduled' AND remind_at >= ? ORDER BY remind_at LIMIT 1", u, nowIso);
    return c.json({
      tasks: {
        open: n("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status != 'done' AND parent_id IS NULL"),
        dueToday: n("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status != 'done' AND due_at IS NOT NULL AND due_at < ? AND due_at >= ?", dayEnd, startOfLocalDay(today, tz).toISOString()),
        overdue: n("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status != 'done' AND due_at IS NOT NULL AND due_at < ?", startOfLocalDay(today, tz).toISOString()),
      },
      reminders: { upcoming: n("SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND status = 'scheduled' AND remind_at >= ? AND remind_at < ?", nowIso, week), next: nextReminder ?? null },
      routines: { active: n("SELECT COUNT(*) AS n FROM routines WHERE user_id = ? AND enabled = 1"), custom: n("SELECT COUNT(*) AS n FROM routines WHERE user_id = ? AND kind = 'custom'") },
      memories: { active: n("SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND status = 'active'"), waiting: n("SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND status = 'proposed'") },
      apps: n('SELECT (SELECT COUNT(*) FROM connectors WHERE user_id = ?1 AND enabled = 1) + (SELECT COUNT(*) FROM app_accounts WHERE user_id = ?1) AS n'),
      chats: n('SELECT COUNT(*) AS n FROM channel_chats WHERE user_id = ?'),
      approvals: n("SELECT COUNT(*) AS n FROM actions WHERE user_id = ? AND status = 'pending'"),
      files: n('SELECT COUNT(*) AS n FROM local_files WHERE user_id = ?'),
      folders: n('SELECT COUNT(*) AS n FROM folder_grants WHERE user_id = ?'),
      applications: {
        open: n("SELECT COUNT(*) AS n FROM applications WHERE user_id = ? AND status NOT IN ('accepted','rejected','withdrawn')"),
        dueSoon: n("SELECT COUNT(*) AS n FROM applications WHERE user_id = ? AND status IN ('interested','preparing') AND deadline >= ? AND deadline <= ?", today, addDays(today, 7)),
      },
      money: (() => {
        const s = getSettings(db(c), u);
        const m = money.monthSummary(db(c), u, today.slice(0, 7), today, money.currencyFor(s));
        return { spent: m.total, currency: m.currency, budgets: m.budgets.length, over: m.budgets.filter((b) => b.spent > b.amount).length };
      })(),
    });
  });
  r.get('/discover', (c) => {
    const interests = new Set(getSettings(db(c), uid(c)).profile.interests);
    const score = (card: (typeof DISCOVER)[number]) => card.interests.filter((i) => interests.has(i)).length;
    return c.json({ cards: DISCOVER.map((card) => ({ ...card, forYou: score(card) > 0 })).sort((a, b) => score(b) - score(a)) });
  });
  r.get('/achievements', (c) => c.json(achievements.achievements(db(c), uid(c), c.var.services.now(), tzOf(c))));
  // ---------- Dashboard ----------
  r.get('/dashboard', (c) => {
    const { now } = c.var.services;
    const s = getSettings(db(c), uid(c));
    const tz = safeTimeZone(s.regional.timeZone);
    // Email and calendar summary: refreshed in the background when it's old (the brief uses the saved one).
    inbox.refreshIfStale(c.var.services, uid(c), tz);
    const o = buildOverview(db(c), uid(c), now(), tz, 0, s.regional.locale);
    const hour = Number(localClock(now(), tz).hhmm.slice(0, 2));
    const recentConversations = db(c).all(
      'SELECT id, title, updated_at FROM conversations WHERE user_id = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 6', uid(c),
    );
    const recentWork = db(c).all('SELECT * FROM activity WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', uid(c));
    const notifications = db(c).all('SELECT * FROM notifications WHERE user_id = ? AND read = 0 ORDER BY created_at DESC LIMIT 10', uid(c));
    achievements.recordVisit(db(c), uid(c), now(), tz);
    return c.json({
      week: achievements.weekInNumbers(db(c), uid(c), now()),
      streak: achievements.weeklyStreak(db(c), uid(c), now(), tz).streak,
      overview: o,
      briefing: briefingText(o, s.profile.displayName || c.var.user.name, hour),
      suggestions: suggestions(o, db(c), uid(c), now()),
      recentConversations, recentWork, notifications,
      hour,
    });
  });

  // ---------- Global search ----------
  r.get('/search', (c) => {
    const q = (c.req.query('q') ?? '').slice(0, 300);
    const hits = searchIndex(db(c), uid(c), q, { limit: 40 });
    const out = hits.map((h) => {
      if (h.entity === 'doc_chunk') {
        const d = db(c).get('SELECT d.id, d.filename FROM doc_chunks k JOIN documents d ON d.id = k.document_id WHERE k.id = ?', h.id);
        return { ...h, entity: 'document', id: d?.id ?? h.id, title: d?.filename ?? h.title };
      }
      if (h.entity === 'message') {
        const m = db(c).get('SELECT conversation_id FROM messages WHERE id = ?', h.id);
        return { ...h, entity: 'conversation', id: m?.conversation_id ?? h.id };
      }
      return h;
    });
    return c.json({ results: out });
  });

  // ---------- Tasks ----------
  r.get('/tasks', (c) => {
    const q = c.req.query();
    const tz = tzOf(c);
    const today = localDate(c.var.services.now(), tz);
    const opts = {
      view: (q.view as tasks.TaskView) ?? 'all', q: q.q, project_id: q.project_id, tag: q.tag,
      priority: q.priority ? Number(q.priority) : undefined, sort: q.sort,
      dayStart: startOfLocalDay(today, tz), dayEnd: startOfLocalDay(addDays(today, 1), tz), now: c.var.services.now(),
      limit: q.limit ? Math.max(1, Math.min(Number(q.limit) || 500, 5000)) : undefined,
    };
    const list = tasks.listTasks(db(c), uid(c), opts);
    // The full count only when the page is full, so the usual short list costs nothing extra.
    const total = list.length >= (opts.limit ?? 500) ? tasks.countTasks(db(c), uid(c), opts) : list.length;
    return c.json({ tasks: list, total });
  });
  r.post('/tasks', async (c) => c.json(tasks.createTask(db(c), uid(c), await body(c)), 201));
  /** Parses a natural-language request into a task draft for the user to confirm. Nothing is saved. */
  r.post('/tasks/parse', async (c) => {
    const { text } = z.object({ text: z.string().min(1).max(500) }).parse(await body(c));
    const s = getSettings(db(c), uid(c));
    const tz = safeTimeZone(s.regional.timeZone);
    const p = parseWhen(text, c.var.services.now(), tz);
    const wantsReminder = /\bremind(er)?\b/i.test(text);
    const priority = /\b(urgent|asap|important|high priority)\b/i.test(text) ? 1 : 2;
    return c.json({
      draft: {
        title: (p?.remainder || text).replace(/\b(urgent|asap)\b/gi, '').trim().replace(/^./, (m) => m.toUpperCase()) || text,
        due_at: p?.iso ?? null,
        all_day: p?.allDay ?? false,
        remind_at: wantsReminder && p ? p.iso : null,
        priority,
      },
      interpreted: p ? { text: p.matchedText, local: formatLocal(p.iso, tz, s.regional.locale, !p.allDay) } : null,
      ambiguities: p ? p.ambiguities : wantsReminder ? ['No date or time was found — when should I remind you?'] : [],
      needsConfirmation: !p || p.ambiguities.length > 0 || wantsReminder,
    });
  });
  r.get('/tasks/:id', (c) => {
    const t = db(c).getOwned('tasks', uid(c), c.req.param('id'));
    if (!t) throw notFound('Task');
    return c.json({
      ...tasks.presentTask(t),
      subtasks: db(c).all('SELECT * FROM tasks WHERE parent_id = ? AND user_id = ? ORDER BY status, sort, created_at', t.id, uid(c)).map(tasks.presentTask),
      history: db(c).all('SELECT change, created_at FROM task_history WHERE task_id = ? ORDER BY created_at DESC LIMIT 50', t.id),
      reminders: db(c).all('SELECT * FROM reminders WHERE task_id = ? AND user_id = ? ORDER BY remind_at', t.id, uid(c)),
      ...tasks.listDependencies(db(c), uid(c), t.id),
    });
  });
  r.patch('/tasks/:id', async (c) => c.json(tasks.updateTask(db(c), uid(c), c.req.param('id'), await body(c))));
  r.post('/tasks/:id/complete', (c) => c.json(tasks.completeTask(db(c), uid(c), c.req.param('id'), c.var.services.now())));
  r.post('/tasks/:id/reopen', (c) => c.json(tasks.reopenTask(db(c), uid(c), c.req.param('id'))));
  r.delete('/tasks/:id', (c) => c.json(tasks.deleteTask(db(c), uid(c), c.req.param('id'))));
  // ---------- Reminders ----------
  r.get('/reminders', (c) => c.json({
    reminders: db(c).all(
      "SELECT * FROM reminders WHERE user_id = ? AND (status IN ('scheduled','sending') OR remind_at > ?) ORDER BY remind_at", uid(c),
      new Date(c.var.services.now().getTime() - 7 * 86400_000).toISOString(),
    ),
  }));
  r.post('/reminders', async (c) => {
    const i = tasks.reminderInput.parse(await body(c));
    if (new Date(i.remind_at).getTime() < c.var.services.now().getTime() - 60_000) throw badRequest('That time is in the past.');
    return c.json(tasks.createReminder(db(c), uid(c), i), 201);
  });
  r.delete('/reminders/:id', (c) => {
    const res = db(c).run("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'scheduled'", c.req.param('id'), uid(c));
    if (Number(res.changes) === 0) throw notFound('Scheduled reminder');
    return c.json({ cancelled: true });
  });
  r.post('/reminders/:id/snooze', async (c) => {
    const i = z.object({ minutes: z.number().int().min(1).max(1440).default(10) }).parse(await body(c));
    return c.json(tasks.snoozeReminder(db(c), uid(c), c.req.param('id'), i.minutes, c.var.services.now()));
  });
  // ---------- Place reminders (ring on arriving somewhere) ----------
  r.get('/place-reminders', (c) => c.json({
    places: db(c).all("SELECT * FROM place_reminders WHERE user_id = ? AND status <> 'cancelled' ORDER BY status = 'fired', created_at DESC LIMIT 100", uid(c)),
  }));
  r.post('/place-reminders', async (c) => c.json(tasks.createPlaceReminder(db(c), uid(c), await body(c)), 201));
  r.delete('/place-reminders/:id', (c) => {
    const res = db(c).run("UPDATE place_reminders SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status <> 'cancelled'", c.req.param('id'), uid(c));
    if (Number(res.changes) === 0) throw notFound('Place reminder');
    return c.json({ cancelled: true });
  });
  // The phone arrived: record it once and put it in the app's notifications.
  r.post('/place-reminders/:id/arrived', (c) => {
    const p = tasks.firePlaceReminder(db(c), uid(c), c.req.param('id'), c.var.services.now());
    if (p) notify(db(c), uid(c), { kind: 'reminder', title: `📍 ${p.title}`, body: p.body || `You're at ${p.place_name}`, link: '/tasks' });
    return c.json({ fired: !!p });
  });

  // ---------- Money ----------
  const moneyCtx = (c: any) => {
    const s = getSettings(db(c), uid(c));
    const timeZone = safeTimeZone(s.regional.timeZone);
    return { today: localDate(c.var.services.now(), timeZone), currency: money.currencyFor(s), locale: s.regional.locale, now: c.var.services.now(), timeZone };
  };
  const moneyErr = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof money.MoneyError) throw badRequest(e.message);
      throw e;
    }
  };
  /** The book a request is about (?book= or "book" in the body); Personal when left out. */
  const bookOf = (c: any, raw?: any) => moneyErr(() => finance.resolveBook(db(c), uid(c), (raw && typeof raw === 'object' ? raw.book : undefined) ?? c.req.query('book')));
  const strip = (raw: any) => {
    if (raw && typeof raw === 'object') delete raw.book;
    return raw;
  };
  /** A book's own currency, if it has one, else the user's. */
  const bookCurrency = (c: any, book: money.Book, main: string) => (book ? String(db(c).get('SELECT currency FROM money_books WHERE id = ?', book)?.currency ?? '') || main : main);
  r.get('/money', (c) => {
    const m = moneyCtx(c);
    const book = bookOf(c);
    const cur = bookCurrency(c, book, m.currency);
    const q = c.req.query('month');
    const month = q && /^\d{4}-\d{2}$/.test(q) ? q : m.today.slice(0, 7);
    return c.json({
      ...money.monthSummary(db(c), uid(c), month, m.today, cur, book),
      week: money.weekSummary(db(c), uid(c), m.today, cur, book),
      today: m.today,
      book, books: finance.listBooks(db(c), uid(c)),
      expenses: money.listExpenses(db(c), uid(c), { from: `${month}-01`, to: money.monthEnd(month), book }),
      income_list: finance.listIncome(db(c), uid(c), book, `${month}-01`, money.monthEnd(month)),
      bills: finance.listBills(db(c), uid(c), book),
      debts: finance.listDebts(db(c), uid(c), book),
      goals: finance.listGoals(db(c), uid(c), book),
      categories: money.CATEGORIES.map((id) => ({ id, label: money.CATEGORY_LABELS[id] })),
    });
  });
  r.post('/money/books', async (c) => {
    const raw = await body(c);
    return c.json(moneyErr(() => finance.createBook(db(c), uid(c), raw)), 201);
  });
  r.delete('/money/books/:id', (c) => c.json(finance.deleteBook(db(c), uid(c), c.req.param('id'))));
  r.post('/income', async (c) => {
    const raw = await body(c);
    const m = moneyCtx(c);
    const book = bookOf(c, raw);
    return c.json(moneyErr(() => finance.addIncome(db(c), uid(c), strip(raw), { today: m.today, currency: bookCurrency(c, book, m.currency), book })), 201);
  });
  r.delete('/income/:id', (c) => {
    if (!finance.deleteIncome(db(c), uid(c), c.req.param('id'))) throw notFound('Income');
    return c.json({ deleted: true });
  });
  r.post('/bills', async (c) => {
    const raw = await body(c);
    const m = moneyCtx(c);
    const book = bookOf(c, raw);
    return c.json(moneyErr(() => finance.addBill(db(c), uid(c), strip(raw), { currency: bookCurrency(c, book, m.currency), book, timeZone: m.timeZone, now: m.now })), 201);
  });
  r.post('/bills/:id/pay', async (c) => {
    const raw = await body(c);
    const m = moneyCtx(c);
    const i = z.object({ paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), amount: z.number().positive().max(1e12).optional() }).parse(raw);
    const res = moneyErr(() => finance.payBill(db(c), uid(c), c.req.param('id'), { today: m.today, locale: m.locale, now: m.now, paidOn: i.paid_on, amount: i.amount }));
    await money.pushAlerts(c.var.services, uid(c), res.alerts);
    return c.json(res);
  });
  r.delete('/bills/:id', (c) => c.json(finance.stopBill(db(c), uid(c), c.req.param('id'))));
  r.post('/debts', async (c) => {
    const raw = await body(c);
    const m = moneyCtx(c);
    const book = bookOf(c, raw);
    return c.json(moneyErr(() => finance.addDebt(db(c), uid(c), strip(raw), { currency: bookCurrency(c, book, m.currency), book })), 201);
  });
  r.post('/debts/:id/pay', async (c) => {
    const raw = await body(c);
    return c.json(moneyErr(() => finance.payDebt(db(c), uid(c), c.req.param('id'), raw, moneyCtx(c).today)));
  });
  r.post('/savings', async (c) => {
    const raw = await body(c);
    const m = moneyCtx(c);
    const book = bookOf(c, raw);
    return c.json(moneyErr(() => finance.addGoal(db(c), uid(c), strip(raw), { currency: bookCurrency(c, book, m.currency), book })), 201);
  });
  r.post('/savings/:id/move', async (c) => {
    const raw = await body(c);
    return c.json(moneyErr(() => finance.moveSavings(db(c), uid(c), c.req.param('id'), raw, moneyCtx(c).today)));
  });
  r.post('/expenses', async (c) => {
    const raw = await body(c);
    const m = moneyCtx(c);
    const book = bookOf(c, raw);
    const res = moneyErr(() => money.addExpense(db(c), uid(c), strip(raw), { ...m, currency: bookCurrency(c, book, m.currency), book }));
    await money.pushAlerts(c.var.services, uid(c), res.alerts);
    return c.json(res, 201);
  });
  // Returns the updated expense (with its new updated_at, for offline edits made on top of it).
  r.patch('/expenses/:id', async (c) => {
    const raw = await body(c);
    const res = moneyErr(() => money.updateExpense(db(c), uid(c), c.req.param('id'), raw, moneyCtx(c)));
    if (!res) throw notFound('Expense');
    await money.pushAlerts(c.var.services, uid(c), res.alerts);
    return c.json({ ...res.expense, alerts: res.alerts });
  });
  r.delete('/expenses/:id', (c) => {
    if (!money.deleteExpense(db(c), uid(c), c.req.param('id'))) throw notFound('Expense');
    return c.json({ deleted: true });
  });
  r.put('/budgets', async (c) => {
    const m = moneyCtx(c);
    const raw = await body(c);
    const book = bookOf(c, raw);
    const b = money.setBudget(db(c), uid(c), strip(raw), bookCurrency(c, book, m.currency), book);
    const alerts = money.checkBudgets(db(c), uid(c), m.today.slice(0, 7), m.today, m.locale, book);
    await money.pushAlerts(c.var.services, uid(c), alerts);
    return c.json({ budget: b });
  });

  // ---------- Applications (jobs, scholarships) ----------
  const appCtx = (c: any) => {
    const m = moneyCtx(c);
    return { today: m.today, timeZone: m.timeZone, now: m.now };
  };
  r.get('/applications', (c) => c.json({
    applications: applications.listApplications(db(c), uid(c), { kind: c.req.query('kind'), open: c.req.query('open') === '1' }),
    statuses: applications.STATUSES.map((id) => ({ id, label: applications.STATUS_LABELS[id] })),
  }));
  r.get('/applications/:id', (c) => c.json(applications.getApplication(db(c), uid(c), c.req.param('id'))));
  r.post('/applications', async (c) => c.json(applications.createApplication(db(c), uid(c), await body(c), appCtx(c)), 201));
  r.patch('/applications/:id', async (c) => c.json(applications.updateApplication(db(c), uid(c), c.req.param('id'), await body(c), appCtx(c))));
  r.delete('/applications/:id', (c) => c.json(applications.deleteApplication(db(c), uid(c), c.req.param('id'))));
  r.post('/applications/:id/items', async (c) => c.json(applications.addItem(db(c), uid(c), c.req.param('id'), await body(c)), 201));
  r.patch('/application-items/:id', async (c) => c.json(applications.updateItem(db(c), uid(c), c.req.param('id'), await body(c))));
  r.delete('/application-items/:id', (c) => c.json(applications.deleteItem(db(c), uid(c), c.req.param('id'))));

  // ---------- Memories ----------
  r.get('/memories', (c) => {
    const { status, category, q, context } = c.req.query();
    const where = ['user_id = ?'];
    const params: any[] = [uid(c)];
    if (status) { where.push('status = ?'); params.push(status); }
    if (context === 'personal' || context === 'work') { where.push('context = ?'); params.push(context); }
    if (category) { where.push('category = ?'); params.push(category); }
    if (q) { where.push('content LIKE ?'); params.push(`%${q}%`); }
    return c.json({
      memories: db(c).all(`SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY status = 'proposed' DESC, updated_at DESC LIMIT 1000`, ...params)
        .map((m) => ({ ...m, sensitive: !!m.sensitive, sensitivity: memory.sensitivityOf(m.content) })),
      categories: memory.MEMORY_CATEGORIES,
    });
  });
  r.post('/memories', async (c) => {
    const s = getSettings(db(c), uid(c));
    const raw = await body(c);
    const expires = s.memory.retentionDays && !raw.expires_at ? new Date(c.var.services.now().getTime() + s.memory.retentionDays * 86400_000).toISOString() : raw.expires_at;
    // Saved by the user directly, so it is active even if sensitive (they chose to save it).
    return c.json(memory.saveMemory(db(c), uid(c), { ...raw, expires_at: expires }, { status: 'active', source: 'user' }), 201);
  });
  r.patch('/memories/:id', async (c) => c.json(memory.updateMemory(db(c), uid(c), c.req.param('id'), await body(c))));
  r.post('/memories/:id/approve', (c) => c.json(memory.updateMemory(db(c), uid(c), c.req.param('id'), { status: 'active' })));
  r.delete('/memories/:id', (c) => c.json(memory.deleteMemory(db(c), uid(c), c.req.param('id'))));
  r.post('/memories/delete', async (c) => {
    const i = z.object({ ids: z.array(z.string().max(64)).min(1).max(500) }).parse(await body(c));
    return c.json(memory.deleteMemories(db(c), uid(c), i.ids));
  });
  r.post('/memories/clear', async (c) => {
    const i = z.object({ categories: z.array(z.string()).optional(), confirm: z.literal(true) }).parse(await body(c));
    return c.json(memory.clearMemories(db(c), uid(c), i.categories));
  });

  // ---------- Notifications ----------
  r.get('/notifications', (c) => c.json({
    notifications: db(c).all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', uid(c)),
    unread: Number(db(c).get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0', uid(c))!.n),
  }));
  r.delete('/notifications', (c) => c.json({ deleted: Number(db(c).run('DELETE FROM notifications WHERE user_id = ?', uid(c)).changes) }));
  r.post('/notifications/read', async (c) => {
    const { ids } = z.object({ ids: z.array(z.string().max(64)).max(500).optional() }).parse(await body(c));
    if (ids?.length) for (const id of ids) db(c).run('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?', id, uid(c));
    else db(c).run('UPDATE notifications SET read = 1 WHERE user_id = ?', uid(c));
    return c.json({ ok: true });
  });

  // ---------- Actions (approval queue + history) ----------
  r.get('/actions', (c) => {
    const { status } = c.req.query();
    const { limit, offset } = page.parse(c.req.query());
    const rows = db(c).all(
      `SELECT a.*, c.title AS conversation_title FROM actions a LEFT JOIN conversations c ON c.id = a.conversation_id
       WHERE a.user_id = ? ${status ? 'AND a.status = ?' : ''} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
      uid(c), ...(status ? [status] : []), limit, offset,
    );
    return c.json({
      actions: rows.map((a) => ({ ...a, input: parseJson(a.input, {}), result: parseJson(a.result, null) })),
      pending: Number(db(c).get("SELECT COUNT(*) AS n FROM actions WHERE user_id = ? AND status = 'pending'", uid(c))!.n),
    });
  });
  r.post('/actions/:id/approve', async (c) => c.json(await approveAction(c.var.services, uid(c), c.req.param('id'))));
  r.post('/actions/:id/reject', (c) => c.json(rejectAction(c.var.services, uid(c), c.req.param('id'))));
  // Edit the text of a queued action (an email, a message) before approving it.
  r.patch('/actions/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { input?: Record<string, unknown> };
    return c.json(editAction(c.var.services, uid(c), c.req.param('id'), body.input ?? {}));
  });
  r.get('/tools', (c) => {
    const s = getSettings(db(c), uid(c));
    const connected = apps.connectedProviders(c.var.services, uid(c));
    return c.json({
      tools: [
        ...TOOLS.map((t) => ({
          name: t.name, description: t.description, risk: t.risk,
          mode: s.permissions.tools[t.name] ?? (t.risk === 'consequential' ? 'ask' : t.risk === 'reversible' && !s.permissions.autoReversible ? 'ask' : 'auto'),
        })),
        // Tools of the apps connected in My apps: changes ask first unless allowed here.
        ...APP_TOOLS.filter((t) => connected.has(t.provider)).map((t) => ({
          name: t.name, description: t.description, risk: t.risk,
          mode: s.permissions.tools[t.name] ?? (t.risk === 'read' ? 'auto' : 'ask'),
        })),
      ],
    });
  });

  // ---------- Routines ----------
  r.get('/routines', (c) => c.json({ routines: routines.listRoutines(db(c), uid(c)) }));
  r.get('/routines/access', (c) => c.json({ groups: ACCESS_GROUPS.map(({ tools: _t, prefixes: _p, ...g }) => g) }));
  r.get('/routines/ideas', (c) => c.json({ ideas: routines.ROUTINE_IDEAS, webSearch: c.var.services.search.available().configured }));
  r.post('/routines', async (c) => c.json(routines.createRoutine(db(c), uid(c), await body(c)), 201));
  r.patch('/routines/:id', async (c) => c.json(routines.updateRoutine(db(c), uid(c), c.req.param('id'), await body(c))));
  r.delete('/routines/:id', (c) => c.json(routines.deleteRoutine(db(c), uid(c), c.req.param('id'))));
  r.post('/routines/:id/run', aiLimit, async (c) => {
    const row = db(c).getOwned('routines', uid(c), c.req.param('id'));
    if (!row) throw notFound('Routine');
    if (row.kind !== 'custom') throw badRequest('Built-in routines run at their scheduled time.');
    try {
      return c.json(await routines.runCustomRoutine(c.var.services, row));
    } catch (err: any) {
      db(c).run("UPDATE routines SET last_run_at = ?, last_status = 'failed', last_error = ? WHERE id = ?", c.var.services.now().toISOString(), String(err?.message ?? err).slice(0, 300), row.id);
      throw err;
    }
  });

  // ---------- Connected apps (MCP) ----------
  r.get('/connectors', (c) => c.json({ connectors: connectors.listConnectors(db(c), uid(c)), allowPrivate: c.var.services.config.MCP_ALLOW_PRIVATE_NETWORK === 'true' }));
  r.post('/connectors', connectLimit, async (c) => c.json(await connectors.addConnector(c.var.services, uid(c), await body(c)), 201));
  r.post('/connectors/oauth/start', connectLimit, async (c) => {
    const i = z.object({ name: z.string().trim().min(1).max(40), url: z.string().trim().min(8).max(500) }).parse(await body(c));
    return c.json(await startOAuth(c.var.services, uid(c), i.name, i.url));
  });
  /** The app sends the browser back here after sign-in. */
  r.get('/connectors/oauth/callback', async (c) => {
    const { code, state, error, error_description } = c.req.query();
    const back = (q: Record<string, string>) => c.redirect(`/connectors?${new URLSearchParams(q)}`, 302);
    if (error || !code || !state) return back({ oauth_error: (error_description || error || 'Sign-in was cancelled.').slice(0, 200) });
    try {
      const done = await finishOAuth(c.var.services, uid(c), state, code);
      const conn = await connectors.addOAuthConnector(c.var.services, uid(c), done.name, done.url, done.tokens);
      return back({ connected: conn.name });
    } catch (e: any) {
      return back({ oauth_error: String(e?.message ?? 'Sign-in failed.').slice(0, 200) });
    }
  });
  r.post('/connectors/:id/refresh', connectLimit, async (c) => c.json(await connectors.refreshConnector(c.var.services, uid(c), c.req.param('id'))));
  r.patch('/connectors/:id', async (c) => c.json(connectors.updateConnector(c.var.services, uid(c), c.req.param('id'), await body(c))));
  r.delete('/connectors/:id', (c) => c.json(connectors.deleteConnector(db(c), uid(c), c.req.param('id'))));

  // ---------- My apps (Google, Microsoft, Meta, X, LinkedIn, TikTok) ----------
  const groupParam = (c: any) => {
    const g = c.req.param('group');
    if (!['google', 'microsoft', 'meta', 'x', 'linkedin', 'tiktok'].includes(g)) throw notFound('App');
    return g as Parameters<typeof apps.saveClient>[2];
  };
  r.get('/apps', async (c) => c.json({ apps: await apps.presentApps(c.var.services, uid(c)) }));
  r.put('/apps/clients/:group', connectLimit, async (c) => c.json(apps.saveClient(c.var.services, uid(c), groupParam(c), await body(c))));
  r.delete('/apps/clients/:group', (c) => c.json(apps.deleteClient(c.var.services, uid(c), groupParam(c))));
  r.post('/apps/:provider/start', connectLimit, async (c) => c.json(await apps.startSignIn(c.var.services, uid(c), c.req.param('provider'))));
  r.delete('/apps/accounts/:id', async (c) => c.json(await apps.disconnect(c.var.services, uid(c), c.req.param('id'))));
  /** The provider sends the browser back here after sign-in (PC; the phone uses /oauth/finish). */
  r.get('/apps/callback', async (c) => {
    const { code, state, error, error_description } = c.req.query();
    const back = (q: Record<string, string>) => c.redirect(`/apps?${new URLSearchParams(q)}`, 302);
    if (error || !code || !state) return back({ oauth_error: (error_description || error || 'Sign-in was cancelled.').slice(0, 200) });
    try {
      const done = await apps.finishSignIn(c.var.services, uid(c), state, code);
      return back({ connected: done.account.label });
    } catch (e: any) {
      return back({ oauth_error: String(e?.message ?? 'Sign-in failed.').slice(0, 300) });
    }
  });
  /**
   * The phone app's sign-in listener hands over what the browser brought back. The state says
   * whether it's a My apps account or a connected app (MCP).
   */
  r.post('/oauth/finish', connectLimit, async (c) => {
    const i = z.object({ state: z.string().max(200).optional(), code: z.string().max(4000).optional(), error: z.string().max(500).optional(), error_description: z.string().max(500).optional() }).parse(await body(c));
    if (!i.state) throw badRequest('Sign-in didn’t finish. Try again.');
    const row = db(c).get('SELECT name FROM oauth_states WHERE state = ? AND user_id = ?', i.state, uid(c));
    if (!row) throw badRequest('That sign-in has expired or was already used. Start again.');
    const isApp = String(row.name).startsWith(apps.STATE_PREFIX);
    if (i.error || !i.code) {
      db(c).run('DELETE FROM oauth_states WHERE state = ?', i.state);
      throw badRequest((i.error_description || i.error || 'Sign-in was cancelled.').slice(0, 300));
    }
    try {
      if (isApp) {
        const done = await apps.finishSignIn(c.var.services, uid(c), i.state, i.code);
        return c.json({ kind: 'app', provider: done.provider, label: done.account.label });
      }
      const done = await finishOAuth(c.var.services, uid(c), i.state, i.code);
      const conn = await connectors.addOAuthConnector(c.var.services, uid(c), done.name, done.url, done.tokens);
      return c.json({ kind: 'connector', label: conn.name });
    } catch (e: any) {
      if (e?.status) throw e;
      throw badRequest(String(e?.message ?? 'Sign-in failed.').slice(0, 300));
    }
  });

  // ---------- Messaging channels (Telegram, WhatsApp) ----------
  r.get('/channels', async (c) => {
    const shared = (await helperConfig(c.var.services))?.whatsapp ?? null;
    // Carino's shared number can change (e.g. from Meta's test number to a real one).
    if (shared?.number) {
      for (const ch of db(c).all("SELECT id, config FROM channels WHERE user_id = ? AND kind = 'whatsapp'", uid(c))) {
        const cfg = parseJson<any>(ch.config, {});
        if (cfg.mode === 'shared' && cfg.display_phone !== shared.number) db(c).run('UPDATE channels SET config = ? WHERE id = ?', JSON.stringify({ ...cfg, display_phone: shared.number }), ch.id);
      }
    }
    const rows = db(c).all('SELECT * FROM channels WHERE user_id = ? ORDER BY kind', uid(c));
    return c.json({
      channels: rows.map((ch) => ({ ...channels.presentChannel(db(c), ch, c.var.services.now()), webhook_url: ch.kind === 'whatsapp' ? webhookUrl(c.var.services, ch) : undefined })),
      transcription: transcriptionConfigured(c.var.services),
      // Carino's shared WhatsApp number, if this build has one (link with a code, like Toqi).
      shared_whatsapp: shared,
      publicUrl: c.var.services.config.PUBLIC_URL,
    });
  });
  r.post('/channels/telegram', connectLimit, async (c) => {
    const i = z.object({ token: z.string().trim().min(10).max(200) }).parse(await body(c));
    const ch = await connectTelegram(c.var.services, uid(c), i.token);
    channels.newPairingCode(db(c), ch.id, c.var.services.now());
    return c.json(channels.presentChannel(db(c), db(c).get('SELECT * FROM channels WHERE id = ?', ch.id)!, c.var.services.now()), 201);
  });
  r.post('/channels/whatsapp', connectLimit, async (c) => {
    const i = z.object({ phone_number_id: z.string().trim().max(40), access_token: z.string().trim().min(20).max(1000), app_secret: z.string().trim().max(200) }).parse(await body(c));
    const ch = await connectWhatsApp(c.var.services, uid(c), i);
    channels.newPairingCode(db(c), ch.id, c.var.services.now());
    const fresh = db(c).get('SELECT * FROM channels WHERE id = ?', ch.id)!;
    return c.json({ ...channels.presentChannel(db(c), fresh, c.var.services.now()), webhook_url: webhookUrl(c.var.services, fresh) }, 201);
  });
  /** Phone app: link WhatsApp to the user's own relay (see relay/ in the repository). */
  r.post('/channels/whatsapp/relay', connectLimit, async (c) => {
    const i = z.object({ url: z.string().trim().min(8).max(300), setup_code: z.string().trim().max(200).optional() }).parse(await body(c));
    const ch = await connectRelay(c.var.services, uid(c), i.url, undefined, i.setup_code || undefined);
    return c.json({ ...channels.presentChannel(db(c), ch, c.var.services.now()), webhook_url: webhookUrl(c.var.services, ch) });
  });
  /** Phone app: create the relay on the user's own Cloudflare account, then link it. */
  r.post('/channels/whatsapp/relay/create', connectLimit, async (c) => {
    const i = z.object({ token: z.string().trim().min(20).max(300), verify_at_relay: z.boolean().optional() }).parse(await body(c));
    if (!db(c).get("SELECT 1 FROM channels WHERE user_id = ? AND kind = 'whatsapp'", uid(c))) throw badRequest('Connect WhatsApp first (phone number ID, token and app secret).');
    const key = randomBytes(24).toString('base64url');
    const url = await deployRelay(c.var.services, i.token, key, i.verify_at_relay ? relayAppSecret(c.var.services, uid(c)) : undefined);
    // A brand-new workers.dev address can take a few seconds to come online.
    let ch;
    for (let attempt = 0; ; attempt++) {
      try {
        ch = await connectRelay(c.var.services, uid(c), url, key);
        break;
      } catch (e: any) {
        if (attempt >= 7 || !/Could not reach|error 5\d\d|error 404/.test(String(e?.message))) throw e;
        await new Promise((r) => setTimeout(r, c.var.services.config.NODE_ENV === 'test' ? 5 : 4000));
      }
    }
    return c.json({ ...channels.presentChannel(db(c), ch, c.var.services.now()), webhook_url: webhookUrl(c.var.services, ch) });
  });
  r.post('/channels/whatsapp/shared/link', connectLimit, async (c) => c.json(await startSharedLink(c.var.services, uid(c))));
  r.get('/channels/whatsapp/shared/status', async (c) => c.json(await sharedLinkStatus(c.var.services, uid(c))));
  r.post('/channels/whatsapp/poll', async (c) => c.json({ handled: await pollRelay(c.var.services) }));
  r.post('/channels/:id/pair', (c) => {
    const ch = channels.ownChannel(db(c), uid(c), c.req.param('id'));
    return c.json({ pairing_code: channels.newPairingCode(db(c), ch.id, c.var.services.now()), expires_in_minutes: channels.PAIRING_TTL_MS / 60_000 });
  });
  r.patch('/channels/:id', async (c) => {
    const ch = channels.ownChannel(db(c), uid(c), c.req.param('id'));
    const i = z.object({ enabled: z.boolean().optional(), transcribe_voice: z.boolean().optional() }).parse(await body(c));
    if (i.enabled !== undefined) db(c).run('UPDATE channels SET enabled = ? WHERE id = ?', i.enabled ? 1 : 0, ch.id);
    if (i.transcribe_voice !== undefined) db(c).run("UPDATE channels SET config = json_set(config, '$.transcribe_voice', json(?)) WHERE id = ?", String(i.transcribe_voice), ch.id);
    return c.json(channels.presentChannel(db(c), db(c).get('SELECT * FROM channels WHERE id = ?', ch.id)!, c.var.services.now()));
  });
  r.delete('/channels/:id', async (c) => {
    const ch = channels.ownChannel(db(c), uid(c), c.req.param('id'));
    if (ch.kind === 'whatsapp' && isShared(ch)) await unlinkShared(c.var.services, ch);
    return c.json(channels.deleteChannel(db(c), uid(c), c.req.param('id')));
  });
  r.patch('/channel-chats/:id', async (c) => {
    const i = z.object({ muted: z.boolean().optional(), catchup: z.boolean().optional() }).parse(await body(c));
    if (i.muted !== undefined) channels.setChatMuted(db(c), uid(c), c.req.param('id'), i.muted);
    if (i.catchup !== undefined) {
      const chat = db(c).getOwned('channel_chats', uid(c), c.req.param('id'));
      if (!chat) throw notFound('Chat');
      db(c).run('UPDATE channel_chats SET catchup = ? WHERE id = ?', i.catchup ? 1 : 0, chat.id);
      // Switching it off forgets what was kept.
      if (!i.catchup) db(c).run('DELETE FROM group_log WHERE chat_id = ?', chat.id);
    }
    return c.json({ ok: true });
  });
  r.delete('/channel-chats/:id', (c) => {
    channels.unlinkChat(db(c), uid(c), c.req.param('id'));
    return c.json({ deleted: true });
  });

  // ---------- Ramble (brain-dump → tasks, reminders, notes) ----------
  // Pages and small apps Carino built in chat.
  r.get('/pages', (c) => c.json({ pages: db(c).all('SELECT id, title, kind, version, conversation_id, updated_at FROM pages WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200', uid(c)) }));
  r.get('/pages/:id', (c) => {
    const p = db(c).getOwned('pages', uid(c), c.req.param('id'));
    if (!p) throw new HttpError(404, 'Page not found', 'not_found');
    return c.json({ ...p, history: parseJson<any[]>(p.history, []).map((h) => ({ version: h.version, at: h.at })) });
  });
  r.get('/pages/:id/html', (c) => {
    const p = db(c).getOwned('pages', uid(c), c.req.param('id'));
    if (!p) throw new HttpError(404, 'Page not found', 'not_found');
    const v = Number(c.req.query('version') ?? p.version);
    const html = v === Number(p.version) ? String(p.html) : String(parseJson<any[]>(p.history, []).find((h) => h.version === v)?.html ?? p.html);
    // Shown in its own sandbox: no access to Carino, no outside requests.
    return c.body(html, 200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "sandbox allow-scripts allow-forms allow-modals; default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; media-src data: https:" });
  });
  r.post('/pages/:id/restore', async (c) => {
    const p = db(c).getOwned('pages', uid(c), c.req.param('id'));
    if (!p) throw new HttpError(404, 'Page not found', 'not_found');
    const { version } = (await c.req.json().catch(() => ({}))) as { version?: number };
    const history = parseJson<any[]>(p.history, []);
    const old = history.find((h) => h.version === version);
    if (!old) throw new HttpError(400, 'No such version', 'bad_request');
    const next = [...history, { version: p.version, html: p.html, at: p.updated_at }].slice(-10);
    db(c).run('UPDATE pages SET html = ?, version = version + 1, history = ?, updated_at = ? WHERE id = ?', old.html, JSON.stringify(next), new Date().toISOString(), p.id);
    return c.json({ ok: true, version: Number(p.version) + 1 });
  });
  r.delete('/pages/:id', (c) => {
    if (!db(c).deleteOwned('pages', uid(c), c.req.param('id'))) throw new HttpError(404, 'Page not found', 'not_found');
    return c.json({ deleted: true });
  });

  // "Like me": learn how the user writes (from their own messages or pasted samples), or forget it.
  r.post('/settings/voice/learn', aiLimit, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { samples?: string };
    return c.json(await learnVoice(c.var.services, uid(c), typeof b.samples === 'string' ? b.samples.slice(0, 6000) : undefined));
  });
  r.delete('/settings/voice', (c) => c.json(forgetVoice(c.var.services, uid(c))));
  r.post('/ramble/extract', aiLimit, async (c) => {
    const i = z.object({ text: z.string().max(MAX_RAMBLE_CHARS + 1000) }).parse(await body(c));
    return c.json(await extractRamble(c.var.services, uid(c), i.text));
  });
  r.post('/ramble/apply', async (c) => c.json(applyRamble(db(c), uid(c), await body(c), c.var.services.now()), 201));

  // ---------- Email, calendar and follow-ups ----------
  r.get('/digest', (c) => {
    const d = inbox.cachedDigest(db(c), uid(c));
    return c.json({ digest: d, awaiting: inbox.awaitingReplies(db(c), uid(c), d) });
  });
  r.post('/digest/refresh', connectLimit, async (c) => {
    const d = await inbox.refreshDigest(c.var.services, uid(c), tzOf(c));
    return c.json({ digest: d, awaiting: inbox.awaitingReplies(db(c), uid(c), d) });
  });
  /** "No reply needed": stop suggesting a follow-up for this message. */
  r.post('/followups/:id/dismiss', (c) => {
    inbox.dismissFollowUp(db(c), uid(c), c.req.param('id').slice(0, 300));
    return c.json({ dismissed: true });
  });

  // ---------- Devices: pairing, sync, conflicts and handoffs ----------
  const syncErr = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof sync.SyncError) throw new HttpError(e.status, e.message, 'sync');
      throw e;
    }
  };
  r.get('/sync', async (c) => c.json({
    device: await sync.identity(c.var.services),
    peers: sync.listPeers(db(c), uid(c)),
    conflicts: sync.listConflicts(db(c), uid(c)),
  }));
  r.patch('/sync/device', async (c) => {
    const i = z.object({ name: z.string().trim().min(1).max(60) }).parse(await body(c));
    await sync.identity(c.var.services);
    sync.renameDevice(db(c), i.name);
    return c.json({ device: await sync.identity(c.var.services) });
  });
  /** On a PC: show a pairing code (the desktop app passes its local network addresses). */
  r.post('/sync/pair/start', connectLimit, async (c) => {
    const i = z.object({ addresses: z.array(z.string().max(100)).max(4).default([]) }).parse(await body(c));
    return c.json(await sync.startPairing(c.var.services, uid(c), i.addresses));
  });
  /** On the phone: pair using the PC's QR link, or its code and address typed in. */
  r.post('/sync/pair/join', connectLimit, async (c) => syncErr(async () => {
    const i = z.object({ link: z.string().max(4000).optional(), code: z.string().max(40).optional(), address: z.string().max(200).optional(), offer: z.any().optional() }).parse(await body(c));
    const fromLink = i.link ? sync.parsePairLink(i.link) : null;
    const code = fromLink?.code ?? i.code;
    if (!code) throw new sync.SyncError('Scan the QR code on the PC, or type its code and address.');
    const address = (i.address || fromLink?.at?.[0] || i.offer?.at?.[0] || '').trim();
    if (!/^https?:\/\/[\w.:[\]-]+$/.test(address)) throw new sync.SyncError('Add the PC’s address as shown on the PC, e.g. http://192.168.1.20:47900');
    const offer = fromLink ?? i.offer ?? (await sync.fetchOffer(c.var.services, address));
    return c.json(await sync.joinPairing(c.var.services, uid(c), offer, code, address));
  }));
  r.get('/sync/peers/:id/check', async (c) => syncErr(async () => c.json({ check: await sync.peerCheck(c.var.services, uid(c), c.req.param('id')) })));
  r.post('/sync/peers/:id/confirm', async (c) => syncErr(() => {
    sync.confirmPeer(db(c), uid(c), c.req.param('id'));
    return c.json({ confirmed: true });
  }));
  r.delete('/sync/peers/:id', (c) => {
    sync.forgetPeer(db(c), uid(c), c.req.param('id'));
    return c.json({ forgotten: true });
  });
  /** On the phone: sync now with every paired PC that can be reached. */
  r.post('/sync/now', async (c) => {
    const out: any[] = [];
    for (const p of sync.listPeers(db(c), uid(c)).filter((x) => x.role === 'listener' && x.confirmed)) {
      try {
        out.push({ device: p.device_id, name: p.name, ...(await sync.syncWith(c.var.services, uid(c), String(p.device_id))) });
      } catch (e: any) {
        out.push({ device: p.device_id, name: p.name, error: String(e?.message ?? e) });
      }
    }
    return c.json({ results: out, conflicts: sync.listConflicts(db(c), uid(c)).length });
  });
  r.post('/sync/conflicts/:id', async (c) => syncErr(async () => {
    const i = z.object({ keep: z.enum(['mine', 'theirs']) }).parse(await body(c));
    sync.resolveConflict(c.var.services, uid(c), c.req.param('id'), i.keep);
    return c.json({ resolved: true });
  }));
  // "Continue on my other device": a chat, to-do or application with a note and chosen files.
  r.get('/handoffs', async (c) => {
    const me = await sync.identity(c.var.services);
    return c.json({
      handoffs: db(c).all("SELECT * FROM handoffs WHERE user_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 20", uid(c))
        .map((h) => ({ ...h, files: parseJson(h.files, []), from_here: h.from_device === me.device_id })),
    });
  });
  r.post('/handoffs', async (c) => {
    const i = z.object({ kind: z.enum(['chat', 'task', 'application']), ref_id: z.string().max(64), note: z.string().max(1000).default(''), files: z.array(z.string().max(64)).max(20).default([]) }).parse(await body(c));
    const table = { chat: 'conversations', task: 'tasks', application: 'applications' }[i.kind];
    const ref = db(c).getOwned(table, uid(c), i.ref_id);
    if (!ref) throw notFound('Item');
    for (const f of i.files) if (!db(c).getOwned('documents', uid(c), f)) throw notFound('File');
    const me = await sync.identity(c.var.services);
    db(c).run("UPDATE handoffs SET status = 'done', updated_at = ? WHERE user_id = ? AND kind = ? AND ref_id = ? AND status = 'open'", nowIso(), uid(c), i.kind, i.ref_id);
    const h = db(c).insert('handoffs', { user_id: uid(c), kind: i.kind, ref_id: i.ref_id, title: String(ref.title ?? ref.name ?? 'Untitled').slice(0, 200), note: i.note, files: JSON.stringify(i.files), from_device: me.device_id });
    return c.json({ ...h, files: i.files }, 201);
  });
  r.post('/handoffs/:id/done', (c) => {
    const res = db(c).run("UPDATE handoffs SET status = 'done', updated_at = ? WHERE id = ? AND user_id = ?", nowIso(), c.req.param('id'), uid(c));
    if (!Number(res.changes)) throw notFound('Handoff');
    return c.json({ done: true });
  });

  // ---------- The user's own folders (read-only unless they allow changes; every change approved) ----------
  const filesErr = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (e: any) {
      if (e instanceof files.FilesError || e?.name === 'LocalFsError') throw badRequest(e.message);
      throw e;
    }
  };
  r.get('/files', (c) => c.json({
    available: !!c.var.services.localFs, platform: c.var.services.localFs?.platform ?? null,
    folders: db(c).all('SELECT g.*, (SELECT COUNT(*) FROM local_files f WHERE f.grant_id = g.id) AS files FROM folder_grants g WHERE g.user_id = ? ORDER BY g.created_at', uid(c)).map((g) => ({ ...g, can_change: !!g.can_change, local_only: !!g.local_only })),
  }));
  /** Adds a folder the user picked in the system's folder picker (the app passes what the picker returned). */
  r.post('/files/folders', async (c) => filesErr(async () => {
    const i = z.object({ root: z.string().min(1).max(2000), label: z.string().max(200).default('') }).parse(await body(c));
    if (!c.var.services.localFs) throw new files.FilesError('Folders on this device aren’t available here.');
    const g = files.addGrant(db(c), uid(c), i.root, i.label);
    const scan = await files.scanGrant(c.var.services, uid(c), String(g.id));
    return c.json({ folder: g, scan }, 201);
  }));
  r.delete('/files/folders/:id', (c) => c.json({ removed: files.revokeGrant(db(c), uid(c), c.req.param('id')) }));
  r.patch('/files/folders/:id', async (c) => {
    const i = z.object({ can_change: z.boolean().optional(), local_only: z.boolean().optional() }).parse(await body(c));
    if (i.can_change !== undefined) files.setCanChange(db(c), uid(c), c.req.param('id'), i.can_change);
    if (i.local_only !== undefined) files.setLocalOnly(db(c), uid(c), c.req.param('id'), i.local_only);
    return c.json(i);
  });
  r.post('/files/folders/:id/scan', async (c) => filesErr(async () => c.json(await files.scanGrant(c.var.services, uid(c), c.req.param('id')))));
  r.get('/files/list', (c) => c.json({ files: files.listFiles(db(c), uid(c), { grant: c.req.query('folder'), q: c.req.query('q'), kind: c.req.query('kind') }) }));
  r.get('/files/search', (c) => c.json({ results: files.searchFiles(db(c), uid(c), (c.req.query('q') ?? '').slice(0, 200)) }));
  r.get('/files/duplicates', (c) => c.json({ groups: files.duplicates(db(c), uid(c)) }));
  r.get('/files/suggestions', (c) => c.json({ suggestions: files.suggestions(db(c), uid(c)) }));
  r.get('/files/history', (c) => c.json({ history: files.history(db(c), uid(c)) }));
  r.get('/files/item/:id/text', (c) => c.json(files.fileText(db(c), uid(c), c.req.param('id'))));
  /** Proposes changes: they're checked and queued for the user's approval (nothing happens yet). */
  r.post('/files/changes', async (c) => filesErr(async () => {
    const i = z.object({ ops: z.array(z.any()).min(1).max(200) }).parse(await body(c));
    files.checkOps(db(c), uid(c), i.ops);
    const res: any = await executeTool('change_local_files', { ops: i.ops }, makeContext(c.var.services, uid(c), null), 'user');
    return c.json(res);
  }));
  r.post('/files/history/:id/undo', async (c) => filesErr(async () => c.json(await files.undoOp(c.var.services, uid(c), c.req.param('id')))));

  // ---------- Encrypted backup and restore ----------
  // Each call derives a key from the passphrase on purpose slowly, so these are limited too.
  const backupLimit = rateLimit({ name: 'backup', windowMs: 60_000, max: 6, key: (c) => c.var.user.id });
  const backupErr = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof backup.BackupError) throw badRequest(e.message);
      throw e;
    }
  };
  const dataDir = (c: any) => c.var.services.config.DATA_DIR as string;
  /** The backup a request is about: an uploaded file (form field "file"), or one kept on this device ("name"). */
  const backupInput = async (c: any) => {
    const type = c.req.header('content-type') ?? '';
    if (type.includes('multipart/form-data')) {
      const form = await c.req.formData();
      const file = form.get('file');
      if (!(file instanceof Blob)) throw badRequest('Choose a backup file.');
      if (file.size > 700 * 1024 * 1024) throw badRequest('That file is too large to be a Carino backup.');
      return { file: new Uint8Array(await file.arrayBuffer()), passphrase: String(form.get('passphrase') ?? ''), mode: String(form.get('mode') ?? ''), confirm: form.get('confirm') === 'true' };
    }
    const i = z.object({ name: z.string().max(200), passphrase: z.string().max(200), mode: z.string().max(20).optional(), confirm: z.boolean().optional() }).parse(await body(c));
    return { file: backup.readLocal(dataDir(c), uid(c), i.name), passphrase: i.passphrase, mode: i.mode ?? '', confirm: !!i.confirm };
  };
  r.get('/backup', (c) => c.json({
    backups: backup.listLocal(dataDir(c), uid(c)),
    tables: backup.backupTables(db(c)),
    cloud: db(c).all("SELECT id, provider, label FROM app_accounts WHERE user_id = ? AND provider IN ('google', 'microsoft')", uid(c)),
  }));
  /** Makes an encrypted backup, proves it opens and restores, and keeps it on this device. */
  r.post('/backup', backupLimit, async (c) => backupErr(async () => {
    const i = z.object({ passphrase: z.string().max(200) }).parse(await body(c));
    const pass = backup.checkPassphrase(i.passphrase);
    const now = c.var.services.now();
    const payload = backup.collect(db(c), uid(c), now);
    const file = await backup.encryptBackup(payload, pass);
    const check = await backup.decryptBackup(file, pass);
    backup.testRestore(db(c), uid(c), dataDir(c), check);
    const name = backup.backupName(now);
    backup.saveLocal(dataDir(c), uid(c), name, file);
    return c.json({ name, size: file.length, verified: true, records: Object.values(payload.manifest.tables).reduce((a, t) => a + t.count, 0), files: Object.keys(payload.manifest.files).length }, 201);
  }));
  r.get('/backup/files/:name', (c) => {
    const file = (() => {
      try {
        return backup.readLocal(dataDir(c), uid(c), c.req.param('name'));
      } catch (e: any) {
        throw notFound('Backup');
      }
    })();
    c.header('Content-Disposition', `attachment; filename="${c.req.param('name')}"`);
    return c.body(file as any, 200, { 'content-type': 'application/octet-stream' });
  });
  r.delete('/backup/files/:name', (c) => {
    backup.deleteLocal(dataDir(c), uid(c), c.req.param('name'));
    return c.json({ deleted: true });
  });
  /** Opens a backup and says what restoring it would do. Changes nothing. */
  r.post('/backup/inspect', backupLimit, async (c) => backupErr(async () => {
    const i = await backupInput(c);
    const p = await backup.decryptBackup(i.file, i.passphrase);
    return c.json(backup.preview(db(c), uid(c), p));
  }));
  /** Restores a backup, after saving what's here now as an encrypted safety copy (to undo it). */
  r.post('/backup/restore', backupLimit, async (c) => backupErr(async () => {
    const i = await backupInput(c);
    if (i.mode !== 'merge' && i.mode !== 'replace') throw badRequest('Choose how to restore: add what’s missing, or replace everything.');
    if (!i.confirm) throw badRequest('Confirm the restore first.');
    const p = await backup.decryptBackup(i.file, i.passphrase);
    const now = c.var.services.now();
    const safety = backup.backupName(now, 'before-restore');
    backup.saveLocal(dataDir(c), uid(c), safety, await backup.encryptBackup(backup.collect(db(c), uid(c), now), backup.checkPassphrase(i.passphrase)));
    const counts = backup.restore(db(c), uid(c), dataDir(c), p, i.mode);
    return c.json({ restored: counts, undo: safety, note: 'Sign in to your apps again in My apps; sign-ins aren’t kept in backups.' });
  }));
  /** Opt-in: saves a copy of a backup to the user's Google Drive or OneDrive (it stays encrypted). */
  r.post('/backup/cloud', backupLimit, async (c) => backupErr(async () => {
    const i = z.object({ name: z.string().max(200), account_id: z.string().max(64) }).parse(await body(c));
    const acct = db(c).getOwned('app_accounts', uid(c), i.account_id);
    if (!acct || !['google', 'microsoft'].includes(String(acct.provider))) throw badRequest('Choose a Google or Microsoft account from My apps.');
    const file = Buffer.from(backup.readLocal(dataDir(c), uid(c), i.name));
    const res = acct.provider === 'google'
      ? await (await import('../services/apps/google.ts')).driveUploadBytes(c.var.services, acct, i.name, 'application/octet-stream', file)
      : await (await import('../services/apps/microsoft.ts')).upload(c.var.services, acct, i.name, 'application/octet-stream', file);
    return c.json({ ...res, where: acct.provider === 'google' ? 'Google Drive' : 'OneDrive/Carino' });
  }));

  // ---------- Data export ----------
  r.get('/export', (c) => {
    const u = uid(c);
    const d = db(c);
    const tables = ['workspaces', 'projects', 'project_items', 'tasks', 'task_dependencies', 'reminders', 'place_reminders', 'expenses', 'budgets', 'money_books', 'income', 'bills', 'debts', 'debt_payments', 'savings_goals', 'savings_moves', 'applications', 'application_items', 'application_events', 'notes', 'memories', 'conversations', 'routines', 'actions', 'activity', 'links'];
    const data: Record<string, unknown> = { exported_at: new Date().toISOString(), format: 'carino-export-v1', user: c.var.user, settings: getSettings(d, u) };
    for (const t of tables) data[t] = d.all(`SELECT * FROM ${t} WHERE user_id = ?`, u);
    data.messages = d.all("SELECT id, conversation_id, role, content, created_at FROM messages WHERE user_id = ? AND role IN ('user','assistant')", u);
    data.documents = d.all('SELECT id, filename, kind, size, summary, key_points, tags, folder, created_at FROM documents WHERE user_id = ?', u);
    for (const conv of data.conversations as any[]) delete conv.system_prompt;
    c.header('Content-Disposition', `attachment; filename="carino-export-${new Date().toISOString().slice(0, 10)}.json"`);
    return c.json(data);
  });

  return r;
}
