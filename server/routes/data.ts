import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../context.ts';
import { notFound, badRequest } from '../context.ts';
import { parseJson } from '../db/index.ts';
import * as tasks from '../services/tasks.ts';
import * as memory from '../services/memory.ts';
import * as routines from '../services/routines.ts';
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
import { connectRelay, pollRelay } from '../services/whatsapp-relay.ts';
import { deployRelay } from '../services/relay-deploy.ts';
import { startSharedLink, sharedLinkStatus, unlinkShared, isShared } from '../services/whatsapp-shared.ts';
import { helperConfig } from '../services/helper.ts';
import { transcriptionConfigured } from '../services/transcribe.ts';
import { getSettings, updateSettings } from '../services/settings.ts';
import { buildOverview, briefingText, suggestions } from '../services/briefing.ts';
import { searchIndex } from '../services/indexer.ts';
import { localDate, startOfLocalDay, addDays, safeTimeZone, localClock, parseWhen, formatLocal } from '../services/time.ts';
import { approveAction, rejectAction, TOOLS } from '../tools/registry.ts';
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

  // ---------- Memories ----------
  r.get('/memories', (c) => {
    const { status, category, q } = c.req.query();
    const where = ['user_id = ?'];
    const params: any[] = [uid(c)];
    if (status) { where.push('status = ?'); params.push(status); }
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
  r.delete('/apps/accounts/:id', (c) => c.json(apps.disconnect(c.var.services, uid(c), c.req.param('id'))));
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
    const i = z.object({ url: z.string().trim().min(8).max(300) }).parse(await body(c));
    const ch = await connectRelay(c.var.services, uid(c), i.url);
    return c.json({ ...channels.presentChannel(db(c), ch, c.var.services.now()), webhook_url: webhookUrl(c.var.services, ch) });
  });
  /** Phone app: create the relay on the user's own Cloudflare account, then link it. */
  r.post('/channels/whatsapp/relay/create', connectLimit, async (c) => {
    const i = z.object({ token: z.string().trim().min(20).max(300) }).parse(await body(c));
    if (!db(c).get("SELECT 1 FROM channels WHERE user_id = ? AND kind = 'whatsapp'", uid(c))) throw badRequest('Connect WhatsApp first (phone number ID, token and app secret).');
    const key = randomBytes(24).toString('base64url');
    const url = await deployRelay(c.var.services, i.token, key);
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
    const i = z.object({ muted: z.boolean() }).parse(await body(c));
    channels.setChatMuted(db(c), uid(c), c.req.param('id'), i.muted);
    return c.json({ ok: true });
  });
  r.delete('/channel-chats/:id', (c) => {
    channels.unlinkChat(db(c), uid(c), c.req.param('id'));
    return c.json({ deleted: true });
  });

  // ---------- Ramble (brain-dump → tasks, reminders, notes) ----------
  r.post('/ramble/extract', aiLimit, async (c) => {
    const i = z.object({ text: z.string().max(MAX_RAMBLE_CHARS + 1000) }).parse(await body(c));
    return c.json(await extractRamble(c.var.services, uid(c), i.text));
  });
  r.post('/ramble/apply', async (c) => c.json(applyRamble(db(c), uid(c), await body(c), c.var.services.now()), 201));

  // ---------- Data export ----------
  r.get('/export', (c) => {
    const u = uid(c);
    const d = db(c);
    const tables = ['workspaces', 'projects', 'project_items', 'tasks', 'task_dependencies', 'reminders', 'notes', 'memories', 'conversations', 'routines', 'actions', 'activity', 'links'];
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
