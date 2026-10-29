// Carino's WhatsApp relay. Meta delivers WhatsApp messages to a web address that is always
// online; a phone isn't one. This Worker is that address: it keeps each delivery exactly as Meta
// signed it until your Carino app collects it (with its secret key), then forgets it. It can't
// read your Meta app secret or send anything — Carino checks Meta's signature and replies
// straight from the phone. Messages that nobody collects are deleted after 7 days.
import { DurableObject } from 'cloudflare:workers';

const KEEP_MS = 7 * 86400_000;
const MAX_ITEMS = 5000;
const MAX_BODY = 1024 * 1024;
const BATCH = 50;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two hex strings. */
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class Inbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, sig TEXT NOT NULL, body TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS conf (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  }

  conf(k) {
    return this.sql.exec('SELECT v FROM conf WHERE k = ?', k).toArray()[0]?.v ?? null;
  }

  async authorized(req) {
    const key = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const want = this.conf('key_hash');
    return !!key && !!want && same(await sha256(key), want);
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/webhook' && req.method === 'GET') {
      // Meta's one-time check when you save the webhook in its dashboard.
      const q = url.searchParams;
      const token = this.conf('verify_token');
      if (q.get('hub.mode') === 'subscribe' && token && q.get('hub.verify_token') === token) return new Response(q.get('hub.challenge') ?? '', { headers: { 'content-type': 'text/plain' } });
      return new Response('Forbidden', { status: 403 });
    }

    if (path === '/webhook' && req.method === 'POST') {
      const sig = req.headers.get('x-hub-signature-256') ?? '';
      if (!sig.startsWith('sha256=')) return new Response('Missing signature', { status: 401 });
      const body = await req.text();
      if (body.length > MAX_BODY) return new Response('Too large', { status: 413 });
      const now = Date.now();
      this.sql.exec('DELETE FROM items WHERE at < ?', now - KEEP_MS);
      const n = this.sql.exec('SELECT COUNT(*) AS n FROM items').one().n;
      if (n >= MAX_ITEMS) this.sql.exec('DELETE FROM items WHERE id IN (SELECT id FROM items ORDER BY id LIMIT ?)', n - MAX_ITEMS + 1);
      this.sql.exec('INSERT INTO items (at, sig, body) VALUES (?, ?, ?)', now, sig, body);
      return new Response('ok');
    }

    if (path === '/setup' && req.method === 'POST') {
      // The first Carino to call this claims the relay with its key; after that only that key works.
      const key = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (key.length < 24) return json({ error: 'A longer key is needed.' }, 400);
      const hash = await sha256(key);
      const owner = this.conf('key_hash');
      // CLAIM_KEY is set by Carino's "Create my relay" (only possible with access to the Cloudflare account).
      const claimed = typeof this.env?.CLAIM_KEY === 'string' && same(this.env.CLAIM_KEY, key);
      if (owner && !same(owner, hash) && !claimed) return json({ error: 'This relay already belongs to another Carino.' }, 409);
      const { verify_token } = await req.json().catch(() => ({}));
      if (typeof verify_token !== 'string' || verify_token.length < 8) return json({ error: 'Missing verify token.' }, 400);
      this.sql.exec('INSERT OR REPLACE INTO conf (k, v) VALUES (?, ?)', 'key_hash', hash);
      this.sql.exec('INSERT OR REPLACE INTO conf (k, v) VALUES (?, ?)', 'verify_token', verify_token);
      return json({ ok: true });
    }

    if (path === '/inbox' && req.method === 'GET') {
      if (!(await this.authorized(req))) return json({ error: 'Not allowed.' }, 401);
      const items = this.sql.exec('SELECT id, at, sig, body FROM items ORDER BY id LIMIT ?', BATCH).toArray();
      return json({ items });
    }

    if (path === '/ack' && req.method === 'POST') {
      if (!(await this.authorized(req))) return json({ error: 'Not allowed.' }, 401);
      const { ids } = await req.json().catch(() => ({}));
      const list = Array.isArray(ids) ? ids.filter(Number.isInteger).slice(0, 500) : [];
      for (const id of list) this.sql.exec('DELETE FROM items WHERE id = ?', id);
      return json({ removed: list.length });
    }

    if (path === '/') return new Response('Carino WhatsApp relay is running. Paste this address into Carino → Messaging → WhatsApp.', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response('Not found', { status: 404 });
  }
}

export default {
  fetch(req, env) {
    // One inbox per relay: everything goes to the same Durable Object.
    return env.INBOX.get(env.INBOX.idFromName('inbox')).fetch(req);
  },
};
