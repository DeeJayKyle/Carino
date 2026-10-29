import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { AppEnv } from '../context.ts';
import { HttpError } from '../context.ts';
import { sha256 } from '../auth.ts';
import { rateLimit } from '../middleware.ts';
import { complete, recordUsage } from '../ai/agent.ts';
import { ProviderError } from '../ai/types.ts';
import { SearchUnavailableError } from '../services/search.ts';

/** AI connection test and notification subscriptions. */
export function miscRoutes() {
  const r = new Hono<AppEnv>();
  const uid = (c: any) => c.var.user.id as string;
  const db = (c: any) => c.var.services.db as AppEnv['Variables']['services']['db'];

  // ---------- AI provider health ----------
  /** Sends a tiny fixed prompt (no user data) to each configured provider and reports latency or the error. */
  r.post('/ai/test', rateLimit({ name: 'aitest', windowMs: 60_000, max: 6, key: (c) => c.var.user.id }), async (c) => {
    const { providers, now } = c.var.services;
    const body = z.object({ provider: z.string().max(40).optional() }).parse(await c.req.json().catch(() => ({})));
    const targets = providers.list().filter((p) => p.configured && (!body.provider || p.id === body.provider));
    const results = await Promise.all(targets.map(async (info) => {
      const started = performance.now();
      try {
        const res = await providers.get(info.id)!.chat({
          system: 'You are a connection test. Reply with the single word OK.',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          tools: [], maxTokens: 256, signal: AbortSignal.timeout(20_000),
        });
        recordUsage(c.var.services, uid(c), info.id, res.model, res.usage, info.pricing, 'health_check');
        return { id: info.id, label: info.label, model: res.model, ok: true, latencyMs: Math.round(performance.now() - started) };
      } catch (err: any) {
        const pe = err instanceof ProviderError ? err : null;
        return { id: info.id, label: info.label, model: info.model, ok: false, kind: pe?.kind ?? (err?.name === 'TimeoutError' ? 'unavailable' : 'error'), error: pe?.message ?? (err?.name === 'TimeoutError' ? 'No response within 20 seconds.' : 'Connection failed.') };
      }
    }));
    return c.json({ results, testedAt: now().toISOString() });
  });

  // ---------- Push ----------
  r.post('/push/subscribe', async (c) => {
    const i = z.object({
      endpoint: z.string().url().max(2000).refine((u) => u.startsWith('https://'), 'Push endpoint must be HTTPS'),
      keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
      label: z.string().max(100).optional(),
    }).parse(await c.req.json());
    db(c).run(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, device_label) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device_label = excluded.device_label`,
      crypto.randomUUID(), uid(c), i.endpoint, i.keys.p256dh, i.keys.auth, i.label ?? '',
    );
    return c.json({ subscribed: true });
  });
  r.post('/push/unsubscribe', async (c) => {
    const { endpoint } = z.object({ endpoint: z.string().max(2000) }).parse(await c.req.json());
    db(c).run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint, uid(c));
    return c.json({ unsubscribed: true });
  });
  r.get('/push/devices', (c) => c.json({ devices: db(c).all('SELECT id, device_label, created_at FROM push_subscriptions WHERE user_id = ?', uid(c)) }));
  r.delete('/push/devices/:id', (c) => {
    db(c).deleteOwned('push_subscriptions', uid(c), c.req.param('id'));
    return c.json({ removed: true });
  });
  r.post('/push/test', async (c) => {
    if (!c.var.services.push.configured()) throw new HttpError(503, 'Push is not configured on the server (VAPID keys missing). Run `npm run setup`.', 'push_unconfigured');
    const res = await c.var.services.push.sendToUser(uid(c), { title: 'Carino notifications work', body: 'You will get reminders here.', url: '/settings' });
    return c.json(res);
  });

  return r;
}

/** Public, token-protected ICS feed of tasks with due dates (no session needed so calendar apps can poll it). */
