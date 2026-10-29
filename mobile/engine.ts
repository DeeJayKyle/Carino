// Runs Carino's server inside the phone app: the same API code, answering in-process instead of
// over the network, with SQLite (WebAssembly) and files saved on the device. Nothing needs a
// separate server or tunnel; the AI provider is called directly with the user's own key.
import './globals.ts';
import { Buffer } from './buffer.ts';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import sqliteWasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url';
import { configureSqlite, type DatabaseSync } from './shims/sqlite.ts';
import { flushFiles, loadFiles, preloadFiles, seedFile } from './shims/fs.ts';
import { idbDeleteAll, idbGet, idbWrite } from './idb.ts';
import { makeNetFetch, notify, setAlarms, isNative } from './native.ts';
import { configToEnv, maskConfig, PRESETS, type DeviceConfig } from './presets.ts';
import { loadConfig } from '../server/config.ts';
import { Db } from '../server/db/index.ts';
import { createRegistry } from '../server/ai/providers.ts';
import { createSearchService } from '../server/services/search.ts';
import { startScheduler } from '../server/services/scheduler.ts';
import { startTelegram } from '../server/services/telegram.ts';
import { createApp } from '../server/app.ts';
import { createSession, resolveSession } from '../server/auth.ts';
import { updateSettings } from '../server/services/settings.ts';
import type { Services } from '../server/context.ts';
import type { PushService } from '../server/services/push.ts';

const MIGRATIONS = import.meta.glob('../server/db/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const DATA_DIR = '/data';
const MIGRATIONS_DIR = '/app/migrations';
// Short, so closing the app right after a change doesn't lose it (the first change in a burst starts the timer).
const SAVE_DELAY_MS = 150;

let services!: Services;
let app!: ReturnType<typeof createApp>;
let device: DeviceConfig = { provider: null };
let token: string | undefined;

function envFor(c: DeviceConfig) {
  return {
    NODE_ENV: 'production', DATA_DIR, PUBLIC_URL: location.origin, ALLOW_SIGNUP: 'true', MAX_USERS: '1',
    MAX_UPLOAD_MB: '100', DAILY_TOKEN_LIMIT: '2000000', ...configToEnv(c),
  };
}

/** Applies a new AI / service configuration without restarting. */
function applyDevice(c: DeviceConfig) {
  device = c;
  const config = loadConfig(envFor(c));
  services.config = config;
  services.providers = createRegistry(config);
  services.search = createSearchService({ searxngUrl: config.SEARXNG_URL, braveKey: config.BRAVE_SEARCH_API_KEY });
}

// --- Saving -----------------------------------------------------------------------------------
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let erased = false;
let saving: Promise<void> = Promise.resolve();

function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (erased) return saving;
  const bytes = (services.db.raw as unknown as DatabaseSync).serialize();
  saving = saving.then(() => idbWrite([{ store: 'db', key: 'main', value: bytes }])).catch((err) => console.error('Saving failed', err));
  syncAlarms();
  return saving;
}

function scheduleSave() {
  if (!saveTimer) saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

/** Saves everything now (when the app goes to the background). */
export async function flush() {
  if (saveTimer) await save();
  await Promise.all([saving, flushFiles()]);
}

// --- Notifications ----------------------------------------------------------------------------
const phonePush: PushService = {
  configured: () => true,
  publicKey: () => null,
  async sendToUser(_userId, p) {
    notify({ tag: p.tag ?? `n-${Date.now()}`, title: p.title, body: p.body, url: p.url });
    return { sent: 1, failed: 0, errors: [] };
  },
};

/** Hands upcoming reminders to Android, so they still ring while the app is closed. */
function syncAlarms() {
  if (!isNative || !services) return;
  const soon = new Date(services.now().getTime() + 14 * 86400_000).toISOString();
  const rows = services.db.all("SELECT id, title, body, remind_at, task_id FROM reminders WHERE status = 'scheduled' AND remind_at <= ? ORDER BY remind_at LIMIT 60", soon);
  setAlarms(rows.map((r) => ({
    tag: `reminder-${r.id}`, title: `⏰ ${r.title}`, body: r.body || 'Reminder from Carino',
    url: r.task_id ? `/tasks?focus=${r.task_id}` : '/tasks', at: Date.parse(r.remind_at),
  })));
}

// --- The owner's account ----------------------------------------------------------------------
async function ensureOwner() {
  const kv = await idbGet<{ token?: string }>('kv', 'session');
  token = kv?.token;
  if (resolveSession(services.db, token, services.now())) return;
  const user = services.db.get('SELECT id FROM users ORDER BY created_at LIMIT 1');
  if (user) {
    token = createSession(services.db, user.id, 'Phone', services.now()).token;
  } else {
    // First start: create the phone's one account. Its password is random and never needed.
    const password = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
    const res = await app.fetch(new Request(`${location.origin}/api/auth/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-carino': '1' },
      body: JSON.stringify({ email: 'me@this-phone.app', password, name: 'Friend', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language }),
    }));
    if (!res.ok) throw new Error(`Could not set up the app (${res.status})`);
    const uid = services.db.get('SELECT id FROM users LIMIT 1')!.id;
    updateSettings(services.db, uid, { notifications: { push: true } });
  }
  await idbWrite([{ store: 'kv', key: 'session', value: { token } }]);
}

// --- Requests ---------------------------------------------------------------------------------
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** Settings only the phone has: which AI service to use, and its key. */
async function deviceRoute(req: Request, path: string): Promise<Response> {
  if (path === '/api/device/config' && req.method === 'GET') return json({ config: maskConfig(device), presets: PRESETS, native: isNative });
  if (path === '/api/device/models') {
    // The models a key can use, so the app can mark which free models work (and offer others
    // when names change). POST checks the form's values before they're saved.
    const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Partial<DeviceConfig>) : {};
    const p = PRESETS.find((x) => x.id === (body.provider ?? device.provider));
    if (!p || p.hidden) return json({ models: [] });
    const masked = !body.apiKey || body.apiKey.startsWith('••••');
    const key = (masked && body.provider === device.provider) || !body.provider ? device.apiKey : body.apiKey;
    const base = (p.ownAddress ? (body.baseUrl || device.baseUrl) : p.baseUrl)?.replace(/\/$/, '');
    if (!base) return json({ models: [] });
    try {
      const res = await fetch(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15_000) });
      if (res.status === 401 || res.status === 403) return json({ models: [], error: `${p.label} rejected the key.` });
      const data: any = await res.json().catch(() => ({}));
      const list: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
      // OpenRouter lists paid models too: keep only the ones that cost nothing.
      const free = p.id === 'openrouter'
        ? list.filter((m) => Number(m?.pricing?.prompt) === 0 && Number(m?.pricing?.completion) === 0)
        : list;
      const ids = free.map((m) => String(m?.id ?? m?.name ?? '').replace(/^models\//, '')).filter(Boolean);
      return json({ models: [...new Set<string>(ids)].sort() });
    } catch {
      return json({ models: [], error: `Could not reach ${p.label}.` });
    }
  }
  if (path === '/api/device/config' && req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as Partial<DeviceConfig>;
    const keep = (k: keyof DeviceConfig) => (typeof body[k] === 'string' && (body[k] as string).startsWith('••••') ? device[k] : body[k]);
    const next: DeviceConfig = {
      provider: typeof body.provider === 'string' && PRESETS.some((p) => p.id === body.provider) ? body.provider : body.provider === null ? null : device.provider,
      apiKey: (keep('apiKey') as string | undefined)?.trim() || undefined,
      baseUrl: body.baseUrl?.trim() || undefined,
      model: body.model?.trim() || undefined,
      vision: typeof body.vision === 'boolean' ? body.vision : undefined,
      groqKey: (keep('groqKey') as string | undefined)?.trim() || undefined,
      searxngUrl: body.searxngUrl?.trim() || undefined,
      braveKey: (keep('braveKey') as string | undefined)?.trim() || undefined,
      githubToken: (keep('githubToken') as string | undefined)?.trim() || undefined,
    };
    await idbWrite([{ store: 'kv', key: 'device', value: next }]);
    applyDevice(next);
    return json({ config: maskConfig(next) });
  }
  if (path === '/api/device/reset' && req.method === 'POST') {
    // Erase everything; the app reloads and starts fresh.
    erased = true;
    await Promise.all([saving, flushFiles()]);
    await idbDeleteAll();
    setAlarms([]);
    return json({ erased: true });
  }
  return json({ error: 'Not found', code: 'not_found' }, 404);
}

/** Files that are only loaded when needed (large uploads and exports). */
async function warmFiles(path: string) {
  const doc = /^\/api\/documents\/([^/]+)\/(download|preview)$/.exec(path);
  const exp = /^\/api\/exports\/([^/]+)\/download$/.exec(path);
  const row = doc ? services.db.get('SELECT storage_path FROM documents WHERE id = ?', doc[1])
    : exp ? services.db.get('SELECT storage_path FROM exports WHERE id = ?', exp[1]) : null;
  if (row?.storage_path) await preloadFiles([row.storage_path]);
}

export async function handle(req: Request): Promise<Response> {
  await ready;
  const path = new URL(req.url).pathname;
  if (path.startsWith('/api/device/')) return deviceRoute(req, path);
  await warmFiles(path);
  return app.fetch(req);
}

// --- Start ------------------------------------------------------------------------------------
async function boot() {
  const webFetch = window.fetch.bind(window);
  const netFetch = makeNetFetch(webFetch);

  // Outbound calls (AI, Telegram, connectors) go through Android; in-app API calls are answered here.
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin === location.origin) {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ics/')) return handle(new Request(input, init));
      return webFetch(input, init);
    }
    return netFetch(input, init);
  };

  const [sqlite3] = await Promise.all([
    (sqlite3InitModule as any)({ locateFile: () => sqliteWasmUrl, print: () => {}, printErr: (m: string) => console.warn(m) }),
    loadFiles(),
  ]);
  for (const [file, sql] of Object.entries(MIGRATIONS)) seedFile(`${MIGRATIONS_DIR}/${file.split('/').pop()}`, sql);
  configureSqlite(sqlite3, { initial: await idbGet<Uint8Array>('db', 'main'), onWrite: scheduleSave });

  device = (await idbGet<DeviceConfig>('kv', 'device')) ?? { provider: null };
  const config = loadConfig(envFor(device));
  const db = new Db(`${DATA_DIR}/carino.db`, MIGRATIONS_DIR);
  services = {
    db, config,
    providers: createRegistry(config),
    search: createSearchService({ searxngUrl: config.SEARXNG_URL, braveKey: config.BRAVE_SEARCH_API_KEY }),
    push: phonePush,
    now: () => new Date(),
    deviceSession: {
      get: () => token,
      set: (t) => {
        token = t ?? undefined;
        void idbWrite([{ store: 'kv', key: 'session', value: { token } }]);
      },
    },
  };
  app = createApp(services);
  await ensureOwner();
  await save();

  startScheduler(services);
  startTelegram(services);

  const toBackground = () => void flush();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && toBackground());
  window.addEventListener('pagehide', toBackground);
  // Lets tests (and the Android check) wait for everything to be saved, as a normal close does.
  (globalThis as any).__flushEngine = flush;
}

const ready = boot().then(() => console.info('Carino engine ready'));
export const engineReady = ready;
