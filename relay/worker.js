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
/** Posts a minute from one address before it's turned away (Meta sends from many addresses). */
const PER_MINUTE = 120;

/** Meta signs every delivery with the app secret; only checked here if you chose to give the relay the secret (APP_SECRET). */
async function metaSignatureOk(secret, body, header) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return same(hex, header.slice(7));
}

/** Looks like a WhatsApp Business delivery (cheap check that turns away most junk). */
function looksLikeWhatsApp(body, phoneId) {
  let d;
  try {
    d = JSON.parse(body);
  } catch {
    return false;
  }
  if (d?.object !== 'whatsapp_business_account' || !Array.isArray(d.entry)) return false;
  if (!phoneId) return true;
  return d.entry.some((e) => (e?.changes ?? []).some((c) => c?.value?.metadata?.phone_number_id === phoneId));
}

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
    this.recent = new Map();
  }

  /** True when this address has posted too often in the last minute. */
  limited(req) {
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const now = Date.now();
    const r = this.recent.get(ip);
    if (!r || now - r.start > 60_000) {
      if (this.recent.size > 5000) this.recent.clear();
      this.recent.set(ip, { start: now, n: 1 });
      return false;
    }
    r.n++;
    return r.n > PER_MINUTE;
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
      if (q.get('hub.mode') === 'subscribe' && token && same(q.get('hub.verify_token') ?? '', token)) return new Response(q.get('hub.challenge') ?? '', { headers: { 'content-type': 'text/plain' } });
      return new Response('Forbidden', { status: 403 });
    }

    if (path === '/webhook' && req.method === 'POST') {
      const sig = req.headers.get('x-hub-signature-256') ?? '';
      if (!sig.startsWith('sha256=')) return new Response('Missing signature', { status: 401 });
      if (this.limited(req)) return new Response('Too many requests', { status: 429 });
      const body = await req.text();
      if (body.length > MAX_BODY) return new Response('Too large', { status: 413 });
      // With the app secret, junk is refused outright; without it, only things shaped like a delivery are kept.
      const secret = typeof this.env?.APP_SECRET === 'string' ? this.env.APP_SECRET.trim() : '';
      if (secret ? !(await metaSignatureOk(secret, body, sig)) : !looksLikeWhatsApp(body, this.conf('phone_number_id'))) return new Response('Not a WhatsApp delivery', { status: 403 });
      const now = Date.now();
      this.sql.exec('DELETE FROM items WHERE at < ?', now - KEEP_MS);
      const n = this.sql.exec('SELECT COUNT(*) AS n FROM items').one().n;
      // Full: turn new deliveries away (Meta tries again for days) rather than dropping waiting ones.
      if (n >= MAX_ITEMS) return new Response('Inbox full', { status: 503 });
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
      // A relay deployed by hand can require a setup code (SETUP_CODE) to be claimed the first time.
      const code = typeof this.env?.SETUP_CODE === 'string' ? this.env.SETUP_CODE.trim() : '';
      if (!owner && !claimed && code && !same(req.headers.get('x-setup-code') ?? '', code)) return json({ error: 'This relay needs its setup code.' }, 403);
      const { verify_token, phone_number_id } = await req.json().catch(() => ({}));
      if (typeof verify_token !== 'string' || verify_token.length < 8) return json({ error: 'Missing verify token.' }, 400);
      this.sql.exec('INSERT OR REPLACE INTO conf (k, v) VALUES (?, ?)', 'key_hash', hash);
      this.sql.exec('INSERT OR REPLACE INTO conf (k, v) VALUES (?, ?)', 'verify_token', verify_token);
      if (typeof phone_number_id === 'string' && /^\d{5,30}$/.test(phone_number_id)) this.sql.exec('INSERT OR REPLACE INTO conf (k, v) VALUES (?, ?)', 'phone_number_id', phone_number_id);
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
