// Carino's sign-in helper (a Cloudflare Worker).
//
// 1. One-tap sign-in. Carino's apps are registered once with Google, Microsoft, Meta, X,
//    LinkedIn and TikTok. Their client secrets live here, not in the APK. The provider sends the
//    browser to /callback/<provider>; this page hands the one-time code to the phone (its
//    loopback listener), and the phone trades it for tokens through /token. Nothing is stored.
// 2. The shared WhatsApp number (like Toqi's). People link their WhatsApp by sending a 6-digit
//    code from Carino. Each linked person's messages wait here until their own phone collects
//    them with its secret key; replies go back only to that person's number.
import { DurableObject } from 'cloudflare:workers';

const GRAPH = 'https://graph.facebook.com/v23.0';
const MS_SCOPES = 'offline_access openid email profile User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Files.ReadWrite.All';

/** Where each provider's tokens come from, and which secrets it uses. */
const PROVIDERS = {
  google: { token: 'https://oauth2.googleapis.com/token', id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
  microsoft: { token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', id: 'MS_CLIENT_ID', secret: 'MS_CLIENT_SECRET', refreshScope: MS_SCOPES },
  facebook: { token: `${GRAPH}/oauth/access_token`, id: 'META_APP_ID', secret: 'META_APP_SECRET', meta: true },
  instagram: { token: `${GRAPH}/oauth/access_token`, id: 'META_APP_ID', secret: 'META_APP_SECRET', meta: true },
  x: { token: 'https://api.x.com/2/oauth2/token', id: 'X_CLIENT_ID', secret: 'X_CLIENT_SECRET', basic: true },
  linkedin: { token: 'https://www.linkedin.com/oauth/v2/accessToken', id: 'LINKEDIN_CLIENT_ID', secret: 'LINKEDIN_CLIENT_SECRET' },
  tiktok: { token: 'https://open.tiktokapis.com/v2/oauth/token/', id: 'TIKTOK_CLIENT_KEY', secret: 'TIKTOK_CLIENT_SECRET', idParam: 'client_key' },
};

const LOOPBACK = 'http://127.0.0.1:47823/callback';
const PKG = 'app.carino';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Secrets pasted with a stray space or line break still work. */
const tidy = (env) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));

const configured = (env, p) => !!(env[PROVIDERS[p].id] && env[PROVIDERS[p].secret]);
const waConfigured = (env) => !!(env.WA_PHONE_NUMBER_ID && env.WA_ACCESS_TOKEN && env.META_APP_SECRET);

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Meta signs every webhook delivery with the app secret. */
async function metaSignatureOk(secret, body, header) {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return same(hex, header.slice(7));
}

// ---- Sign-in ---------------------------------------------------------------------------------

/** The page the provider sends the browser to: it passes the code to Carino on the phone. */
function callbackPage(provider, url) {
  const q = new URLSearchParams();
  for (const k of ['code', 'state', 'error', 'error_description']) {
    const v = url.searchParams.get(k);
    if (v) q.set(k, v.slice(0, 4000));
  }
  q.set('provider', provider);
  const toPhone = `${LOOPBACK}?${q}`;
  const toApp = `intent://oauth#Intent;scheme=carino;package=${PKG};end`;
  const failed = url.searchParams.get('error');
  const html = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<meta name=referrer content=no-referrer><title>Back to Carino</title>
<style>body{font-family:system-ui,sans-serif;background:#faf7f2;color:#1f1b2e;display:grid;place-items:center;min-height:90vh;margin:0;padding:24px;text-align:center}
a{display:inline-block;margin-top:16px;padding:14px 22px;border-radius:999px;background:#1f1b2e;color:#fff;text-decoration:none;font-weight:600}</style></head>
<body><div><h1>${failed ? 'Sign-in didn’t finish' : 'Almost done'}</h1><p>${failed ? esc(url.searchParams.get('error_description') || failed) : 'Handing your sign-in to Carino…'}</p>
<a href="${esc(toPhone)}" id=go>Back to Carino</a></div>
<script>setTimeout(function(){location.replace(${JSON.stringify(toPhone)})},150);setTimeout(function(){location.href=${JSON.stringify(toApp)}},2500)</script></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

async function tokenRequest(env, provider, params) {
  const p = PROVIDERS[provider];
  const id = env[p.id];
  const secret = env[p.secret];
  const body = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (p.basic) headers.authorization = `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}`;
  else body.set('client_secret', secret);
  body.set(p.idParam ?? 'client_id', id);
  const res = await fetch(p.token, { method: 'POST', headers, body });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) {
    const why = d.error_description ?? d.error?.message ?? d.error ?? d.message ?? `error ${res.status}`;
    return { error: String(typeof why === 'string' ? why : JSON.stringify(why)).slice(0, 300) };
  }
  let out = { access_token: d.access_token, refresh_token: d.refresh_token, expires_in: d.expires_in };
  if (p.meta) {
    // Meta's sign-in gives an hour; swap it for the 60-day kind.
    const u = new URL(`${GRAPH}/oauth/access_token`);
    u.search = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: id, client_secret: secret, fb_exchange_token: d.access_token }).toString();
    const long = await fetch(u).then((r) => r.json()).catch(() => ({}));
    if (long.access_token) out = { access_token: long.access_token, expires_in: long.expires_in };
  }
  return out;
}

async function signIn(req, env, url, path) {
  const cb = path.match(/^\/callback\/([a-z]+)$/);
  if (cb && req.method === 'GET') {
    if (!PROVIDERS[cb[1]]) return new Response('Unknown app', { status: 404 });
    return callbackPage(cb[1], url);
  }
  if ((path === '/token' || path === '/refresh') && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const provider = String(b.provider ?? '');
    if (!PROVIDERS[provider]) return json({ error: 'Unknown app.' }, 404);
    if (!configured(env, provider)) return json({ error: 'This app isn’t set up on Carino’s sign-in helper yet.' }, 503);
    const r = path === '/token'
      ? await tokenRequest(env, provider, {
        grant_type: 'authorization_code', code: String(b.code ?? '').slice(0, 4000),
        redirect_uri: `${url.origin}/callback/${provider}`, code_verifier: b.code_verifier ? String(b.code_verifier).slice(0, 200) : undefined,
      })
      : await tokenRequest(env, provider, { grant_type: 'refresh_token', refresh_token: String(b.refresh_token ?? '').slice(0, 4000), scope: PROVIDERS[provider].refreshScope });
    return json(r, r.error ? 400 : 200);
  }
  return null;
}

// ---- The shared WhatsApp number --------------------------------------------------------------

async function graph(env, path, init = {}) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${env.WA_ACCESS_TOKEN}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

const sendText = (env, to, text) => graph(env, `${env.WA_PHONE_NUMBER_ID}/messages`, { body: { messaging_product: 'whatsapp', to, type: 'text', text: { body: text.slice(0, 4096), preview_url: false } } });

const CODE_TTL_MS = 15 * 60_000;
const KEEP_MS = 7 * 86400_000;

export class WaHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, tidy(env));
    this.env = tidy(env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS links (key_hash TEXT PRIMARY KEY, wa_id TEXT, name TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, key_hash TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, key_hash TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media (media_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS nudged (wa_id TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
  }

  one(sql, ...p) {
    return this.sql.exec(sql, ...p).toArray()[0] ?? null;
  }

  /** The phone's key, checked against the stored hash; returns the link row. */
  async who(req) {
    const key = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (key.length < 24) return null;
    return this.one('SELECT * FROM links WHERE key_hash = ?', await sha256(key));
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const env = this.env;
    const now = Date.now();

    if (path === '/whatsapp/webhook') return this.webhook(await req.text(), now);

    if (path === '/wa/register' && req.method === 'POST') {
      // A phone asks for a linking code. Its key (random, kept on the phone) identifies it from now on.
      const key = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (key.length < 24) return json({ error: 'A longer key is needed.' }, 400);
      const hash = await sha256(key);
      this.sql.exec('DELETE FROM codes WHERE expires < ? OR key_hash = ?', now, hash);
      if (!this.one('SELECT 1 FROM links WHERE key_hash = ?', hash)) this.sql.exec('INSERT INTO links (key_hash, wa_id, name, created) VALUES (?, NULL, NULL, ?)', hash, now);
      let code;
      do code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
      while (this.one('SELECT 1 FROM codes WHERE code = ?', code));
      this.sql.exec('INSERT INTO codes (code, key_hash, expires) VALUES (?, ?, ?)', code, hash, now + CODE_TTL_MS);
      return json({ code, expires_in: CODE_TTL_MS / 1000 });
    }

    const link = await this.who(req);
    if (!link) return json({ error: 'Not linked. Get a new code in Carino.' }, 401);

    if (path === '/wa/status') return json({ linked: !!link.wa_id, wa_id: link.wa_id, name: link.name });
    if (path === '/wa/inbox') {
      const items = this.sql.exec('SELECT id, at, body FROM items WHERE key_hash = ? ORDER BY id LIMIT 50', link.key_hash).toArray();
      return json({ items: items.map((i) => ({ id: i.id, at: i.at, ...JSON.parse(i.body) })) });
    }
    if (path === '/wa/ack' && req.method === 'POST') {
      const { ids } = await req.json().catch(() => ({}));
      for (const id of (Array.isArray(ids) ? ids : []).filter(Number.isInteger).slice(0, 500)) this.sql.exec('DELETE FROM items WHERE id = ? AND key_hash = ?', id, link.key_hash);
      return json({ ok: true });
    }
    if (path === '/wa/send' && req.method === 'POST') {
      // Replies only ever go to the number linked to this phone.
      if (!link.wa_id) return json({ error: 'WhatsApp isn’t linked yet.' }, 409);
      const b = await req.json().catch(() => ({}));
      const message = b.buttons?.length
        ? { type: 'interactive', interactive: { type: 'button', body: { text: String(b.text ?? '').slice(0, 1000) }, action: { buttons: b.buttons.slice(0, 3).map((x) => ({ type: 'reply', reply: { id: String(x.id).slice(0, 256), title: String(x.title).slice(0, 20) } })) } } }
        : { type: 'text', text: { body: String(b.text ?? '').slice(0, 4096), preview_url: false } };
      const r = await graph(env, `${env.WA_PHONE_NUMBER_ID}/messages`, { body: { messaging_product: 'whatsapp', to: link.wa_id, ...message } });
      return json(r.ok ? { sent: true } : { error: r.data?.error?.message ?? `error ${r.status}` }, r.ok ? 200 : 502);
    }
    const m = path.match(/^\/wa\/media\/([A-Za-z0-9_.-]{1,100})$/);
    if (m) {
      // Voice notes and photos: only ones sent by this phone's own linked number.
      if (!this.one('SELECT 1 FROM media WHERE media_id = ? AND key_hash = ?', m[1], link.key_hash)) return json({ error: 'Not found.' }, 404);
      const meta = await graph(env, m[1]);
      if (!meta.data?.url) return json({ error: 'WhatsApp didn’t return the file.' }, 502);
      const file = await fetch(meta.data.url, { headers: { authorization: `Bearer ${env.WA_ACCESS_TOKEN}` } });
      return new Response(file.body, { status: file.status, headers: { 'content-type': meta.data.mime_type ?? 'application/octet-stream' } });
    }
    if (path === '/wa/unlink' && req.method === 'POST') {
      this.sql.exec('DELETE FROM items WHERE key_hash = ?', link.key_hash);
      this.sql.exec('DELETE FROM media WHERE key_hash = ?', link.key_hash);
      this.sql.exec('DELETE FROM links WHERE key_hash = ?', link.key_hash);
      return json({ ok: true });
    }
    return json({ error: 'Not found.' }, 404);
  }

  /** A delivery from Meta (already signature-checked): link, queue, or point strangers to Carino. */
  async webhook(raw, now) {
    const env = this.env;
    const payload = JSON.parse(raw);
    this.sql.exec('DELETE FROM items WHERE at < ?', now - KEEP_MS);
    this.sql.exec('DELETE FROM media WHERE at < ?', now - KEEP_MS);
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const names = new Map((value.contacts ?? []).map((c) => [String(c.wa_id), String(c.profile?.name ?? '')]));
        for (const msg of value.messages ?? []) {
          const from = String(msg.from ?? '');
          if (!from) continue;
          const text = String(msg.text?.body ?? '').trim();
          const code = text.match(/^(?:link\s+)?(\d{6})$/i)?.[1];
          const pending = code ? this.one('SELECT * FROM codes WHERE code = ? AND expires >= ?', code, now) : null;
          if (pending) {
            // One phone per number: linking again moves the number to the new phone.
            this.sql.exec('UPDATE links SET wa_id = NULL WHERE wa_id = ?', from);
            this.sql.exec('UPDATE links SET wa_id = ?, name = ? WHERE key_hash = ?', from, names.get(from) ?? '', pending.key_hash);
            this.sql.exec('DELETE FROM codes WHERE code = ?', code);
            await sendText(env, from, 'All set — this WhatsApp is linked to your Carino. Message me any time: text, voice notes or photos.');
            continue;
          }
          const link = this.one('SELECT key_hash FROM links WHERE wa_id = ?', from);
          if (!link) {
            const nudged = this.one('SELECT at FROM nudged WHERE wa_id = ?', from);
            if (!nudged || nudged.at < now - 3600_000) {
              this.sql.exec('INSERT OR REPLACE INTO nudged (wa_id, at) VALUES (?, ?)', from, now);
              await sendText(env, from, code ? 'That code is wrong or has expired. Open Carino → Messaging → WhatsApp for a new one.' : 'Hi! To chat with your Carino here, open Carino → Messaging → WhatsApp and send me the 6-digit code it shows.');
            }
            continue;
          }
          for (const kind of ['audio', 'voice', 'image', 'document', 'video', 'sticker']) {
            if (msg[kind]?.id) this.sql.exec('INSERT OR REPLACE INTO media (media_id, key_hash, at) VALUES (?, ?, ?)', String(msg[kind].id), link.key_hash, now);
          }
          this.sql.exec('INSERT INTO items (key_hash, at, body) VALUES (?, ?, ?)', link.key_hash, now, JSON.stringify({ from, name: names.get(from) ?? '', message: msg }));
        }
      }
    }
    return new Response('ok');
  }
}

export default {
  async fetch(req, rawEnv) {
    const env = tidy(rawEnv);
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (path === '/') return new Response('Carino sign-in helper is running.', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    if (path === '/config') {
      // What the app can offer: client IDs aren't secret (they appear in every sign-in link).
      const providers = {};
      for (const p of Object.keys(PROVIDERS)) if (configured(env, p)) providers[p] = { client_id: env[PROVIDERS[p].id] };
      return json({ providers, whatsapp: waConfigured(env) ? { number: env.WA_DISPLAY_NUMBER || null } : null });
    }

    const signed = await signIn(req, env, url, path);
    if (signed) return signed;

    if (path === '/whatsapp/webhook') {
      if (!waConfigured(env)) return new Response('WhatsApp is not set up', { status: 503 });
      if (req.method === 'GET') {
        const q = url.searchParams;
        if (q.get('hub.mode') === 'subscribe' && env.WA_VERIFY_TOKEN && q.get('hub.verify_token') === env.WA_VERIFY_TOKEN) return new Response(q.get('hub.challenge') ?? '');
        return new Response('Forbidden', { status: 403 });
      }
      const raw = await req.text();
      if (raw.length > 1024 * 1024) return new Response('Too large', { status: 413 });
      if (!(await metaSignatureOk(env.META_APP_SECRET, raw, req.headers.get('x-hub-signature-256')))) return new Response('Bad signature', { status: 401 });
      return env.WA.get(env.WA.idFromName('hub')).fetch(new Request(`${url.origin}/whatsapp/webhook`, { method: 'POST', body: raw }));
    }
    if (path.startsWith('/wa/')) {
      if (!waConfigured(env)) return json({ error: 'WhatsApp isn’t set up on Carino’s helper yet.' }, 503);
      return env.WA.get(env.WA.idFromName('hub')).fetch(req);
    }
    return new Response('Not found', { status: 404 });
  },
};
