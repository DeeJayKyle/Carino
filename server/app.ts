import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ZodError } from 'zod';
import type { AppEnv, Services } from './context.ts';
import { HttpError } from './context.ts';
import { verifyWebhook, signatureValid, queueWhatsApp } from './services/whatsapp.ts';
import { ProviderError } from './ai/types.ts';
import { securityHeaders, csrfGuard, requireAuth, rateLimit, clientIp, offlineReplay } from './middleware.ts';
import { authRoutes } from './routes/auth.ts';
import { dataRoutes } from './routes/data.ts';
import { chatRoutes } from './routes/chat.ts';
import { fileRoutes } from './routes/files.ts';
import { miscRoutes } from './routes/misc.ts';

export function createApp(services: Services) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('services', services);
    await next();
  });
  app.use('*', securityHeaders);

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, code: err.code }, err.status as any);
    if (err instanceof ZodError) {
      return c.json({ error: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '), code: 'validation' }, 400);
    }
    if (err instanceof ProviderError) {
      const status = err.kind === 'not_configured' ? 503 : err.kind === 'rate_limited' ? 429 : err.kind === 'bad_request' ? 400 : 502;
      return c.json({ error: err.message, code: err.kind, retryable: err.retryable }, status);
    }
    if ((err as any)?.name === 'BodyLimitError') return c.json({ error: 'Upload is too large.', code: 'too_large' }, 413);
    // Never leak internals: log server-side, return a generic message.
    console.error('[error]', c.req.method, c.req.path, (err as Error)?.stack ?? err);
    return c.json({ error: 'Something went wrong on the server. Please try again.', code: 'internal' }, 500);
  });

  // WhatsApp Cloud API webhook: public, but every delivery must carry Meta's signature.
  const hookLimit = rateLimit({ name: 'hooks', windowMs: 60_000, max: 300, key: clientIp });
  app.get('/hooks/whatsapp/:id', hookLimit, (c) => {
    const ch = services.db.get("SELECT * FROM channels WHERE id = ? AND kind = 'whatsapp'", c.req.param('id'));
    const challenge = ch ? verifyWebhook(ch, c.req.query()) : null;
    return challenge === null ? c.text('Forbidden', 403) : c.text(challenge);
  });
  app.post('/hooks/whatsapp/:id', hookLimit, bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const ch = services.db.get("SELECT * FROM channels WHERE id = ? AND kind = 'whatsapp'", c.req.param('id'));
    const raw = await c.req.text();
    if (!ch || !signatureValid(services, ch, raw, c.req.header('x-hub-signature-256'))) return c.text('Forbidden', 403);
    if (ch.enabled) {
      try {
        queueWhatsApp(services, ch, JSON.parse(raw));
      } catch {
        return c.text('Bad request', 400);
      }
    }
    return c.text('OK');
  });

  // Shares normally go to the service worker; this only runs if it isn't installed yet.
  app.post('/share-target', (c) => c.redirect('/share?error=no-sw', 303));

  app.get('/api/health', (c) => c.json({ ok: true, time: services.now().toISOString() }));

  const api = new Hono<AppEnv>();
  api.use('*', csrfGuard);
  // Protects the PC server from floods over the network. The phone app's engine serves a single
  // person in-process, so it doesn't limit itself (bulk actions there must not hit a 429).
  if (!services.deviceSession) api.use('*', rateLimit({ name: 'api', windowMs: 60_000, max: 600, key: clientIp }));
  api.use('/documents', bodyLimit({ maxSize: (services.config.MAX_UPLOAD_MB + 1) * 1024 * 1024, onError: (c) => c.json({ error: `File is too large. The limit is ${services.config.MAX_UPLOAD_MB} MB.`, code: 'too_large' }, 413) }));
  api.use('*', async (c, next) => {
    if (c.req.path.endsWith('/documents') && c.req.method === 'POST') return next();
    return bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (cc) => cc.json({ error: 'Request is too large.', code: 'too_large' }, 413) })(c, next);
  });
  api.route('/auth', authRoutes());
  const priv = new Hono<AppEnv>();
  priv.use('*', requireAuth);
  priv.use('*', offlineReplay);
  priv.route('/', dataRoutes());
  priv.route('/', chatRoutes());
  priv.route('/', fileRoutes());
  priv.route('/', miscRoutes());
  api.route('/', priv);
  app.route('/api', api);
  app.all('/api/*', (c) => c.json({ error: 'Not found', code: 'not_found' }, 404));

  return app;
}
