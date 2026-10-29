import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAccount, NO_PASSWORD } from '../server/routes/auth.ts';
import { setup, signup, Client, type TestCtx } from './helpers.ts';
import { hashPassword, verifyPassword } from '../server/auth.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

describe('authentication', () => {
  it('signs up, sets an httpOnly session cookie and returns the profile', async () => {
    const c = new Client(ctx.app);
    const r = await c.post('/api/auth/signup', { name: 'Herbert', email: 'Herb@Example.com', password: 'a long passphrase' });
    expect(r.status).toBe(201);
    expect(r.headers.get('set-cookie')).toMatch(/carino_session=.*HttpOnly.*SameSite=Lax/i);
    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.data.user.email).toBe('herb@example.com');
    expect(me.data.settings.profile.displayName).toBe('Herbert');
    expect(me.data.settings.dashboard.widgets.filter((w: any) => w.visible)).toHaveLength(8);
    // Secrets are never sent to the browser.
    expect(JSON.stringify(me.data)).not.toMatch(/password_hash|api[_-]?key|VAPID_PRIVATE/i);
  });

  it('creates the built-in routines (off) for a new user', async () => {
    const c = await signup(ctx);
    const routines = await c.get('/api/routines');
    expect(routines.data.routines.every((r: any) => r.enabled === false)).toBe(true);
  });

  it('stores passwords hashed, never in plain text', async () => {
    await signup(ctx);
    const row = ctx.services.db.get('SELECT password_hash FROM users LIMIT 1')!;
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain('correct horse battery');
    const h = await hashPassword('secret-pass-123');
    expect(await verifyPassword('secret-pass-123', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('rejects short passwords and duplicate emails', async () => {
    const c = new Client(ctx.app);
    expect((await c.post('/api/auth/signup', { name: 'A', email: 'a@b.co', password: 'short' })).status).toBe(400);
    await c.post('/api/auth/signup', { name: 'A', email: 'a@b.co', password: 'long enough pass' });
    const dup = await new Client(ctx.app).post('/api/auth/signup', { name: 'B', email: 'A@B.co', password: 'long enough pass' });
    expect(dup.status).toBe(409);
  });

  it('logs in with the right password only, with a generic error', async () => {
    const u = await signup(ctx);
    const c = new Client(ctx.app);
    const bad = await c.post('/api/auth/login', { email: u.email, password: 'nope nope nope' });
    expect(bad.status).toBe(401);
    const unknown = await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'nope nope nope' });
    expect(unknown.data.error).toBe(bad.data.error);
    const ok = await c.post('/api/auth/login', { email: u.email, password: 'correct horse battery' });
    expect(ok.status).toBe(200);
    expect((await c.get('/api/tasks')).status).toBe(200);
  });

  it('logout invalidates the session server-side', async () => {
    const c = await signup(ctx);
    const cookie = c.cookie;
    await c.post('/api/auth/logout');
    const replay = new Client(ctx.app);
    replay.cookie = cookie;
    expect((await replay.get('/api/tasks')).status).toBe(401);
  });

  it('expires sessions after their lifetime', async () => {
    const c = await signup(ctx);
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 31 * 86400_000);
    expect((await c.get('/api/tasks')).status).toBe(401);
  });

  it('requires authentication for private routes', async () => {
    const c = new Client(ctx.app);
    for (const p of ['/api/tasks', '/api/notes', '/api/memories', '/api/conversations', '/api/documents', '/api/export', '/api/settings']) {
      expect((await c.get(p)).status, p).toBe(401);
    }
  });

  it('closes sign-up when the user limit is reached', async () => {
    const small = setup({ env: { MAX_USERS: '1' } });
    try {
      await signup(small);
      const c = new Client(small.app);
      expect((await c.get('/api/auth/status')).data.signupOpen).toBe(false);
      const r = await c.post('/api/auth/signup', { name: 'X', email: 'x@y.co', password: 'long enough pass' });
      expect(r.status).toBe(403);
    } finally {
      small.cleanup();
    }
  });

  it('changing password signs out other devices', async () => {
    const a = await signup(ctx);
    const b = new Client(ctx.app);
    await b.post('/api/auth/login', { email: a.email, password: 'correct horse battery' });
    const r = await a.post('/api/auth/password', { current: 'correct horse battery', next: 'brand new passphrase' });
    expect(r.status).toBe(200);
    expect((await b.get('/api/tasks')).status).toBe(401);
    expect((await a.get('/api/tasks')).status).toBe(200);
  });

  it('deletes the account and all its data with the password', async () => {
    const c = await signup(ctx);
    await c.post('/api/tasks', { title: 'Secret task' });
    await c.post('/api/notes', { title: 'Secret note', body: 'findable words' });
    expect((await c.post('/api/auth/delete-account', { password: 'wrong', confirm: 'DELETE' })).status).toBe(400);
    const r = await c.post('/api/auth/delete-account', { password: 'correct horse battery', confirm: 'DELETE' });
    expect(r.status).toBe(200);
    const db = ctx.services.db;
    expect(db.get('SELECT COUNT(*) AS n FROM tasks')!.n).toBe(0);
    expect(db.get('SELECT COUNT(*) AS n FROM notes')!.n).toBe(0);
    expect(db.get('SELECT COUNT(*) AS n FROM search_index')!.n).toBe(0);
    expect((await c.get('/api/tasks')).status).toBe(401);
  });
});

describe('request protections', () => {
  it('rejects state-changing requests without the CSRF header', async () => {
    const c = await signup(ctx);
    const r = await c.req('POST', '/api/tasks', { title: 'x' }, { 'x-carino': '' });
    expect(r.status).toBe(403);
  });

  it('rejects cross-origin requests', async () => {
    const c = await signup(ctx);
    const r = await c.req('POST', '/api/tasks', { title: 'x' }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    const ok = await c.req('POST', '/api/tasks', { title: 'x' }, { origin: 'http://localhost' });
    expect(ok.status).toBe(201);
  });

  it('sends security headers', async () => {
    const r = await new Client(ctx.app).get('/api/health');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
  });

  it('rate-limits repeated login attempts', async () => {
    const c = new Client(ctx.app);
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await c.post('/api/auth/login', { email: 'a@b.co', password: 'x' })).status;
    expect(last).toBe(429);
  });

  it('returns validation errors without leaking internals', async () => {
    const c = await signup(ctx);
    const r = await c.post('/api/tasks', { title: '' });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/title/);
    expect(JSON.stringify(r.data)).not.toMatch(/at .*\.ts:\d+/);
  });

  it('rejects oversized JSON bodies', async () => {
    const c = await signup(ctx);
    const r = await c.post('/api/notes', { title: 'big', body: 'x'.repeat(3 * 1024 * 1024) });
    expect(r.status).toBe(413);
  });
});

describe('accounts without a password (the phone app)', () => {
  it('can never be signed into with a password, not even an empty one', async () => {
    for (const guess of ['', NO_PASSWORD, '!no-password', 'password', 'scrypt']) expect(await verifyPassword(guess, NO_PASSWORD)).toBe(false);
    const u = createAccount(ctx.services.db, { email: 'me@this-phone.app', name: 'Friend' }, NO_PASSWORD);
    expect(u.id).toBeTruthy();
    const c = (await signup(ctx, 'Someone else'));
    void c;
    const r = await ctx.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hailey': '1', 'x-carino': '1', origin: 'http://localhost' }, body: JSON.stringify({ email: 'me@this-phone.app', password: NO_PASSWORD }) });
    expect(r.status).toBe(401);
  });
});
