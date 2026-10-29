import type { Db } from '../db/index.ts';
import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppEnv } from '../context.ts';
import { HttpError } from '../context.ts';
import { hashPassword, verifyPassword, createSession, destroySession, SESSION_COOKIE } from '../auth.ts';
import { requireAuth, rateLimit, clientIp } from '../middleware.ts';
import { updateSettings, getSettings } from '../services/settings.ts';
import { safeTimeZone } from '../services/time.ts';

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(10, 'Use at least 10 characters').max(200),
});

// A real hash to compare against when the email is unknown, so timing doesn't reveal accounts.
let dummyHash: Promise<string> | null = null;

export function authRoutes() {
  const r = new Hono<AppEnv>();
  const limiter = rateLimit({ name: 'auth', windowMs: 15 * 60_000, max: 20, key: clientIp });

  function setSessionCookie(c: any, token: string, expires: Date) {
    c.var.services.deviceSession?.set(token);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'Lax', path: '/', expires,
      secure: c.var.services.config.isProd || new URL(c.var.services.config.PUBLIC_URL).protocol === 'https:',
    });
  }

  r.get('/status', (c) => {
    const { db, config } = c.var.services;
    const users = Number(db.get('SELECT COUNT(*) AS n FROM users')!.n);
    return c.json({ signupOpen: config.allowSignup && users < config.MAX_USERS, hasUsers: users > 0 });
  });

  r.post('/signup', limiter, async (c) => {
    const { db, config, now } = c.var.services;
    const body = await c.req.json().catch(() => ({}));
    const input = credentials.extend({
      name: z.string().trim().min(1).max(80),
      timeZone: z.string().max(64).optional(),
      locale: z.string().max(20).optional(),
    }).parse(body);
    const users = Number(db.get('SELECT COUNT(*) AS n FROM users')!.n);
    if (!config.allowSignup || users >= config.MAX_USERS) throw new HttpError(403, 'New sign-ups are closed on this Carino server.', 'signup_closed');
    if (db.get('SELECT 1 FROM users WHERE email = ?', input.email)) throw new HttpError(409, 'An account with this email already exists.', 'conflict');
    const hash = await hashPassword(input.password);
    const user = createAccount(db, input, hash);
    const { token, expires } = createSession(db, user.id, c.req.header('user-agent'), now());
    setSessionCookie(c, token, expires);
    return c.json({ user: { id: user.id, email: user.email, name: user.name } }, 201);
  });

  r.post('/login', limiter, async (c) => {
    const { db, now } = c.var.services;
    const input = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) }).parse(await c.req.json().catch(() => ({})));
    const user = db.get('SELECT * FROM users WHERE email = ?', input.email);
    dummyHash ??= hashPassword('not-a-real-password');
    const ok = await verifyPassword(input.password, user?.password_hash ?? (await dummyHash));
    if (!user || !ok) throw new HttpError(401, 'Email or password is incorrect.', 'invalid_credentials');
    const { token, expires } = createSession(db, user.id, c.req.header('user-agent'), now());
    setSessionCookie(c, token, expires);
    return c.json({ user: { id: user.id, email: user.email, name: user.name } });
  });

  r.post('/logout', requireAuth, (c) => {
    destroySession(c.var.services.db, c.var.sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    c.var.services.deviceSession?.set(null);
    return c.json({ ok: true });
  });

  r.get('/me', requireAuth, (c) => {
    const { db, providers, search, push } = c.var.services;
    const settings = getSettings(db, c.var.user.id);
    return c.json({
      user: c.var.user,
      settings,
      server: {
        providers: providers.list(),
        search: search.available(),
        push: { configured: push.configured(), publicKey: push.publicKey() },
      },
    });
  });

  r.post('/password', requireAuth, limiter, async (c) => {
    const { db, now } = c.var.services;
    const input = z.object({ current: z.string().max(200), next: credentials.shape.password }).parse(await c.req.json());
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', c.var.user.id)!;
    if (!(await verifyPassword(input.current, row.password_hash))) throw new HttpError(400, 'Current password is incorrect.', 'invalid_credentials');
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(input.next), c.var.user.id);
    // Sign out every other device.
    db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', c.var.user.id, c.var.sessionId);
    void now;
    return c.json({ ok: true });
  });

  r.get('/sessions', requireAuth, (c) => {
    const rows = c.var.services.db.all('SELECT id, created_at, expires_at, user_agent FROM sessions WHERE user_id = ? ORDER BY created_at DESC', c.var.user.id);
    return c.json({ sessions: rows.map((s) => ({ ...s, id: s.id.slice(0, 12), current: s.id === c.var.sessionId })) });
  });

  r.post('/sessions/revoke-others', requireAuth, (c) => {
    const res = c.var.services.db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', c.var.user.id, c.var.sessionId);
    return c.json({ revoked: Number(res.changes) });
  });

  /** Deletes the account and every stored record and file. Requires the password. */
  r.post('/delete-account', requireAuth, limiter, async (c) => {
    const { db, config } = c.var.services;
    const input = z.object({ password: z.string().max(200), confirm: z.literal('DELETE') }).parse(await c.req.json());
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', c.var.user.id)!;
    if (!(await verifyPassword(input.password, row.password_hash))) throw new HttpError(400, 'Password is incorrect.', 'invalid_credentials');
    const uid = c.var.user.id;
    db.tx(() => {
      db.run('DELETE FROM search_index WHERE user_id = ?', uid);
      db.run('DELETE FROM users WHERE id = ?', uid);
    });
    for (const sub of ['uploads', 'exports']) rmSync(resolve(config.DATA_DIR, sub, uid), { recursive: true, force: true });
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    c.var.services.deviceSession?.set(null);
    return c.json({ deleted: true });
  });

  return r;
}

/**
 * Creates an account with its default routines and settings. The PC server passes a scrypt hash;
 * the phone app passes NO_PASSWORD (it signs in with its own device session).
 */
export function createAccount(db: Db, input: { email: string; name: string; timeZone?: string; locale?: string }, passwordHash: string) {
  return db.tx(() => {
    const u = db.insert('users', { email: input.email, name: input.name, password_hash: passwordHash });
    db.insert('routines', { user_id: u.id, kind: 'morning_briefing', time_local: '07:00', enabled: 0 });
    db.insert('routines', { user_id: u.id, kind: 'evening_review', time_local: '19:00', enabled: 0 });
    updateSettings(db, u.id, {
      profile: { displayName: input.name },
      regional: { timeZone: safeTimeZone(input.timeZone), locale: input.locale?.match(/^[a-z]{2}(-[A-Z]{2})?$/) ? input.locale : 'en-GB' },
    });
    return u;
  });
}

/** A password hash that never matches, for accounts that don't sign in with a password. */
export const NO_PASSWORD = '!no-password';
