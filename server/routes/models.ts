import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../context.ts';
import { HttpError, badRequest } from '../context.ts';
import { rateLimit } from '../middleware.ts';
import { getSettings } from '../services/settings.ts';
import { listCatalog, refreshModels, setPrice, syncCatalog, testCostUsd, testModel, usageSummary } from '../ai/catalog.ts';
import { blockedReason, budgetState, recommend } from '../ai/router.ts';
import { modelRef, parseRef } from '../ai/providers.ts';
import { ProviderError } from '../ai/types.ts';
import { connectionList, refreshAll } from '../services/connections.ts';

/** Models, their tests and recommendations; spending; connection status. */
export function modelRoutes() {
  const r = new Hono<AppEnv>();
  const uid = (c: any) => c.var.user.id as string;
  const testLimit = rateLimit({ name: 'modeltest', windowMs: 60_000, max: 10, key: (c) => c.var.user.id });

  r.get('/models', (c) => {
    const services = c.var.services;
    syncCatalog(services);
    const settings = getSettings(services.db, uid(c));
    const budget = budgetState(services, uid(c), settings);
    let main: string | null = null;
    try {
      const i = services.providers.resolve(settings.ai).info();
      main = modelRef(i.id, i.model);
    } catch {}
    const models = listCatalog(services).map((m) => ({
      ...m, main: m.ref === main, test_cost_usd: m.paid === false ? 0 : testCostUsd(m),
      blocked: blockedReason(m, settings, main, budget, { text: '', attachments: 0, historyChars: 0 }) || null,
    }));
    return c.json({ models, main, recommendations: recommend(services, uid(c), settings), budget, connections: connectionList(services, uid(c)).ai });
  });

  r.post('/models/refresh', testLimit, async (c) => {
    const i = z.object({ conn_id: z.string().max(80).optional() }).parse(await c.req.json().catch(() => ({})));
    const services = c.var.services;
    const ids = i.conn_id ? [i.conn_id] : services.providers.connections().map((x) => x.id);
    const results = await Promise.all(ids.map(async (id) => ({ id, ...(await refreshModels(services, id)) })));
    return c.json({ results });
  });

  /**
   * Tests a model. Free and local ones just run. One that costs (or may cost) money runs only
   * when the user approved that service and confirmed the estimated cost shown first.
   */
  r.post('/models/test', testLimit, async (c) => {
    const i = z.object({ ref: z.string().max(240), confirm_cost: z.boolean().optional() }).parse(await c.req.json());
    const services = c.var.services;
    const p = parseRef(i.ref);
    if (!p) throw badRequest('Unknown model');
    syncCatalog(services);
    const m = listCatalog(services).find((x) => x.ref === i.ref);
    if (!m) throw new HttpError(404, 'Model not found', 'not_found');
    const settings = getSettings(services.db, uid(c));
    if (m.paid !== false) {
      let main: string | null = null;
      try {
        const inf = services.providers.resolve(settings.ai).info();
        main = modelRef(inf.id, inf.model);
      } catch {}
      if (m.ref !== main && !settings.ai.approvedPaid.includes(m.conn_id)) {
        throw new HttpError(403, `${m.connection} may charge for this. Approve paid use of ${m.connection} first.`, 'approval_needed');
      }
      const budget = budgetState(services, uid(c), settings);
      if (!budget.allowed) throw new HttpError(402, `Not tested: your ${budget.reason}.`, 'spend_limit');
      if (!i.confirm_cost) return c.json({ needs_confirmation: true, estimate_usd: testCostUsd(m), note: m.price_in === null ? 'The price of this model isn’t known; enter it to see an estimate.' : undefined }, 409);
    }
    try {
      return c.json({ result: await testModel(services, uid(c), p.connId, p.model) });
    } catch (err) {
      if (err instanceof ProviderError) throw new HttpError(400, err.message, err.kind);
      throw err;
    }
  });

  r.post('/models/price', async (c) => {
    const i = z.object({ ref: z.string().max(240), input: z.number().min(0).max(10_000), output: z.number().min(0).max(10_000) }).parse(await c.req.json());
    const p = parseRef(i.ref);
    if (!p) throw badRequest('Unknown model');
    setPrice(c.var.services.db, p, i.input, i.output);
    return c.json({ ok: true });
  });

  r.get('/usage/summary', (c) => {
    const services = c.var.services;
    const settings = getSettings(services.db, uid(c));
    const s = usageSummary(services.db, uid(c), services.now());
    const { dailyUsd, monthlyUsd } = settings.ai.spend ?? {};
    const warn = (spent: number, cap?: number | null) => (typeof cap === 'number' && cap > 0 ? (spent >= cap ? 'reached' : spent >= cap * 0.8 ? 'near' : null) : null);
    return c.json({ ...s, limits: { dailyUsd: dailyUsd ?? null, monthlyUsd: monthlyUsd ?? null }, warning: { today: warn(s.today, dailyUsd), month: warn(s.month, monthlyUsd) } });
  });

  r.get('/connections', (c) => c.json(connectionList(c.var.services, uid(c))));
  r.post('/connections/refresh', rateLimit({ name: 'connrefresh', windowMs: 60_000, max: 6, key: (c) => c.var.user.id }), async (c) => {
    const result = await refreshAll(c.var.services, uid(c), { force: true });
    return c.json({ result, ...connectionList(c.var.services, uid(c)) });
  });

  // Content kept on the user's devices.
  r.patch('/conversations/:id/local-only', async (c) => {
    const i = z.object({ local_only: z.boolean() }).parse(await c.req.json());
    const db = c.var.services.db;
    const conv = db.getOwned('conversations', uid(c), c.req.param('id'));
    if (!conv) throw new HttpError(404, 'Conversation not found', 'not_found');
    // 2 = local-only content was used here: its history would carry that content to an online
    // model, so it stays private. 1 = the user's own choice, which they can undo.
    if (!i.local_only && conv.local_only === 2) {
      throw badRequest('This chat used content you keep on your devices, so it stays private. Start a new chat to use an online AI.');
    }
    if (i.local_only && conv.local_only === 2) return c.json({ local_only: true, locked: true });
    db.run('UPDATE conversations SET local_only = ? WHERE id = ?', i.local_only ? 1 : 0, conv.id);
    return c.json({ local_only: i.local_only });
  });

  return r;
}
