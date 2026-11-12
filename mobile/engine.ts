// Runs Carino's server inside the phone app: the same API code, answering in-process instead of
// over the network, with SQLite (WebAssembly) and files saved on the device. Nothing needs a
// separate server or tunnel; the AI provider is called directly with the user's own key.
import './globals.ts';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import sqliteWasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url';
import { configureSqlite, type DatabaseSync } from './shims/sqlite.ts';
import { existsSync, flushFiles, loadFiles, preloadFiles, readFileSync, rmSync, seedFile } from './shims/fs.ts';
import { Vault, openConfig, sealConfig, type VaultPlatform } from './vault.ts';
import { idbDeleteAll, idbGet, idbWrite } from './idb.ts';
import { makeNetFetch, notify, setAlarms, setPlaceAlerts, setWidgetData, takeReminderEvents, isNative, keepListening, pickFolder, forgetFolder, canPickFolders, saveFile, shareFile, shareText, openExternal, openSignIn, appInfo, askPlacesPermission, speakNative, stopSpeakingNative, listen, stopListening } from './native.ts';
import { getSettings } from '../server/services/settings.ts';
import { addDays, localDate, safeTimeZone, startOfLocalDay } from '../server/services/time.ts';
import { firePlaceReminder } from '../server/services/tasks.ts';
import { notify as notifyInApp } from '../server/services/activity.ts';
import { configToEnv, connectionSpecs, maskConfig, PRESETS, ON_DEVICE_BASE_URL, type DeviceConfig, type ExtraConnection } from './presets.ts';
import { discover, type Probe } from './discover.ts';
import { startFlutterLink } from './flutter-link.ts';
import { refreshModels } from '../server/ai/catalog.ts';
import { refreshAll } from '../server/services/connections.ts';
import { speedTest } from './speedtest.ts';
import { loadConfig } from '../server/config.ts';
import { Db } from '../server/db/index.ts';
import { createRegistry } from '../server/ai/providers.ts';
import { createSearchService } from '../server/services/search.ts';
import { startScheduler } from '../server/services/scheduler.ts';
import { startTelegram } from '../server/services/telegram.ts';
import { pollRelay } from '../server/services/whatsapp-relay.ts';
import { createApp } from '../server/app.ts';
import { createSession, resolveSession } from '../server/auth.ts';
import { createAccount, NO_PASSWORD } from '../server/routes/auth.ts';
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
let vault!: Vault;
/** Saved keys from before couldn't be opened on this device (the user is asked to enter them again). */
let keysUnreadable = false;

/** The system's key store: Android Keystore, Windows DPAPI, or a browser-held key. */
function vaultPlatform(): VaultPlatform {
  const nb = (globalThis as any).CarinoNative;
  const tauri = (globalThis as any).__TAURI__;
  const native = (out: string) => {
    const r = JSON.parse(out);
    if (!r.ok) throw new Error(r.error);
    return r.value as string;
  };
  if (nb?.vaultSeal) return { name: 'android-keystore', seal: async (x) => native(nb.vaultSeal(x)), open: async (x) => native(nb.vaultOpen(x)) };
  if (tauri?.core?.invoke) return { name: 'windows-dpapi', seal: (plain) => tauri.core.invoke('vault_seal', { plain }), open: (sealed) => tauri.core.invoke('vault_open', { sealed }) };
  return { name: 'browser' };
}

/** Saves the configuration with its credentials sealed. */
async function saveDevice(c: DeviceConfig) {
  await idbWrite([{ store: 'kv', key: 'device', value: await sealConfig(vault, c as any) }]);
}

/**
 * The key that protects account sign-ins (server/services/secrets.ts) lives only in memory;
 * what is stored is that key sealed by the vault. An older plain copy is moved over and deleted.
 */
async function protectSecretKey() {
  const path = `${DATA_DIR}/secret.key`;
  const sealed = await idbGet<string>('kv', 'secretKey');
  let plain = sealed ? await vault.open(sealed) : null;
  let changed = !plain;
  if (existsSync(path)) {
    if (!plain) plain = String(readFileSync(path, 'utf8')).trim() || null;
    rmSync(path);
  }
  if (!plain) {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    plain = btoa(String.fromCharCode(...raw));
    changed = true;
  }
  if (changed) await idbWrite([{ store: 'kv', key: 'secretKey', value: await vault.seal(plain) }]);
  seedFile(path, plain);
}

function envFor(c: DeviceConfig) {
  return {
    NODE_ENV: 'production', DATA_DIR, PUBLIC_URL: location.origin, ALLOW_SIGNUP: 'true', MAX_USERS: '1',
    MAX_UPLOAD_MB: '100', DAILY_TOKEN_LIMIT: '2000000', CARINO_HELPER_URL: import.meta.env.VITE_CARINO_HELPER ?? '', ...configToEnv(c),
  };
}

// The on-phone model's code (and its WebAssembly) loads only when it's used.
const onDevice = () => import('./ondevice.ts');
/** fetch for the AI provider: the on-phone model is answered here, everything else goes out as usual. */
const aiFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(ON_DEVICE_BASE_URL)) return (await onDevice()).onDeviceFetch(input, init);
  return fetch(input, init);
};

/** Applies a new AI / service configuration without restarting. */
function applyDevice(c: DeviceConfig) {
  device = c;
  const config = loadConfig(envFor(c));
  services.config = config;
  services.providers = createRegistry(config, aiFetch, connectionSpecs(c));
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
  syncPlaces();
  syncWidget();
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

let lastWidget = '';
/** Gives the home-screen widget today's to-dos and the next reminder (only when they change). */
function syncWidget() {
  if (!isNative || !services) return;
  const user = services.db.get('SELECT id FROM users ORDER BY created_at LIMIT 1');
  if (!user) return;
  const now = services.now();
  const tz = safeTimeZone(getSettings(services.db, user.id).regional.timeZone);
  const startToday = startOfLocalDay(localDate(now, tz), tz).toISOString();
  const endToday = startOfLocalDay(addDays(localDate(now, tz), 1), tz).toISOString();
  const due = services.db.all(
    "SELECT title, due_at FROM tasks WHERE user_id = ? AND status = 'open' AND due_at IS NOT NULL AND due_at < ? ORDER BY due_at LIMIT 200", user.id, endToday,
  );
  const next = services.db.get("SELECT title, remind_at FROM reminders WHERE user_id = ? AND status = 'scheduled' AND remind_at >= ? ORDER BY remind_at LIMIT 1", user.id, now.toISOString());
  const data = {
    total: due.length,
    overdue: due.filter((t) => t.due_at < startToday).length,
    todos: due.slice(0, 4).map((t) => String(t.title).slice(0, 80)),
    next: next ? { title: String(next.title).slice(0, 80), at: Date.parse(next.remind_at) } : null,
  };
  const json = JSON.stringify(data);
  if (json === lastWidget) return;
  lastWidget = json;
  setWidgetData(data);
}

/** Hands active place reminders to Android, which rings on arriving. */
function syncPlaces() {
  if (!isNative || !services) return;
  const rows = services.db.all("SELECT id, title, body, place_name, lat, lon, radius_m FROM place_reminders WHERE status = 'active' ORDER BY created_at DESC LIMIT 50");
  setPlaceAlerts(rows.map((r) => ({ id: r.id, title: r.title, body: r.body || `You're at ${r.place_name}`, lat: r.lat, lon: r.lon, radius: r.radius_m })));
}

/** Applies what happened on Android while the app was closed: Snooze / Done, places arrived at. */
let syncing = false;
/** Syncs with each paired PC that can be reached; quietly (problems show in Settings → Devices). */
async function syncDevices() {
  if (syncing) return;
  syncing = true;
  try {
    const { syncWith } = await import('../server/services/sync.ts');
    for (const p of services.db.all("SELECT device_id, user_id FROM sync_peers WHERE confirmed = 1 AND role = 'listener'")) {
      await syncWith(services, String(p.user_id), String(p.device_id)).catch(() => undefined);
    }
    scheduleSave();
  } finally {
    syncing = false;
  }
}

function applyReminderEvents() {
  if (!isNative || !services) return;
  const events = takeReminderEvents();
  if (!events.length) return;
  for (const e of events) {
    const owner = services.db.get('SELECT user_id FROM reminders WHERE id = ? UNION SELECT user_id FROM place_reminders WHERE id = ?', e.id, e.id);
    if (!owner) continue;
    try {
      if (e.type === 'arrived') {
        const p = firePlaceReminder(services.db, owner.user_id, e.id, new Date(e.at));
        if (p) notifyInApp(services.db, owner.user_id, { kind: 'reminder', title: `📍 ${p.title}`, body: p.body || `You're at ${p.place_name}`, link: '/tasks' });
      }
      // 'snooze': Android rings it again itself in 10 minutes (rescheduling here too would ring twice).
      // 'done': nothing to do; the reminder already rang (a repeating one has moved on).
    } catch (err) {
      console.warn('Reminder event not applied', e, err);
    }
  }
  scheduleSave();
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
    // First start: create the phone's one account. It has no password: the app signs in with its
    // own session (no slow password hashing on a phone for a password nobody types).
    const u = createAccount(services.db, { email: 'me@this-phone.app', name: 'Friend', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language }, NO_PASSWORD);
    token = createSession(services.db, u.id, 'Phone', services.now()).token;
    const uid = services.db.get('SELECT id FROM users LIMIT 1')!.id;
    updateSettings(services.db, uid, { notifications: { push: true } });
  }
  await idbWrite([{ store: 'kv', key: 'session', value: { token } }]);
}

// --- Messaging in the background -------------------------------------------------------------
let listenWanted = true;
let lastPoll = 0;

const hasChannels = () => !!services.db.get('SELECT 1 FROM channels WHERE enabled = 1 LIMIT 1');

/** The ongoing "Carino is listening" notification, while there's a chat app to answer. */
function syncListening() {
  keepListening(listenWanted && hasChannels());
}

/** Collects WhatsApp messages waiting on the user's relay (see server/services/whatsapp-relay.ts). */
function pollWhatsApp() {
  if (Date.now() - lastPoll < 3000) return;
  lastPoll = Date.now();
  void pollRelay(services).then((n) => {
    // In the background timers are slowed down, so save straight away.
    if (n && document.visibilityState === 'hidden') void flush();
  }).catch(() => undefined);
}

// --- Requests ---------------------------------------------------------------------------------
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** Settings only the phone has: which AI service to use, and its key. */
async function deviceRoute(req: Request, path: string): Promise<Response> {
  if (path === '/api/device/config' && req.method === 'GET') return json({ config: maskConfig(device), presets: PRESETS, native: isNative, protection: vault.protection, keysUnreadable });
  if (path === '/api/device/local') {
    // The AI that runs on the phone: which models are downloaded, and downloading or removing one.
    const od = await onDevice();
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { action?: string; model?: string };
      try {
        if (body.action === 'download' && body.model) od.startDownload(body.model);
        else if (body.action === 'cancel') od.cancelDownload();
        else if (body.action === 'remove' && body.model) await od.removeModel(body.model);
        else if (body.action === 'unload') await od.unload();
        else return json({ error: 'Unknown action' }, 400);
      } catch (err: any) {
        return json({ error: String(err?.message ?? err) }, 400);
      }
    }
    return json(await od.localStatus());
  }
  if (path === '/api/device/models') {
    // The models a key can use, so the app can mark which free models work (and offer others
    // when names change). POST checks the form's values before they're saved.
    const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Partial<DeviceConfig>) : {};
    const p = PRESETS.find((x) => x.id === (body.provider ?? device.provider));
    if (!p || p.hidden) return json({ models: [] });
    if (p.onDevice) return json({ models: (await (await onDevice()).localStatus()).models.filter((m) => m.downloaded).map((m) => m.id) });
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
  if (path === '/api/device/speedtest' && req.method === 'POST') {
    // Times each free model with this key, from this phone, and returns them fastest first.
    const body = (await req.json().catch(() => ({}))) as Partial<DeviceConfig> & { models?: string[] };
    const p = PRESETS.find((x) => x.id === (body.provider ?? device.provider));
    if (!p || p.hidden || p.onDevice) return json({ results: [] });
    const masked = !body.apiKey || body.apiKey.startsWith('••••');
    const key = (masked && body.provider === device.provider) || !body.provider ? device.apiKey : body.apiKey;
    const base = (p.ownAddress ? (body.baseUrl || device.baseUrl) : p.baseUrl)?.replace(/\/$/, '');
    if (!base) return json({ results: [] });
    const models = (Array.isArray(body.models) && body.models.length ? body.models : p.models.map((m) => m.id)).map(String);
    return json({ results: await speedTest(fetch, base, key, models) });
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
      connections: device.connections,
    };
    // A different main service: its old model list and test results no longer apply.
    if (next.provider !== device.provider || next.baseUrl !== device.baseUrl) {
      services.db.run("DELETE FROM ai_models WHERE conn_id = 'openai_compat'");
      services.db.run("DELETE FROM connection_status WHERE kind = 'ai' AND ref = 'openai_compat'");
    }
    await saveDevice(next);
    keysUnreadable = false;
    applyDevice(next);
    return json({ config: maskConfig(next) });
  }
  if (path === '/api/device/listen') {
    // Whether to keep answering WhatsApp and Telegram while the app is in the background.
    if (req.method === 'PUT') {
      const body = (await req.json().catch(() => ({}))) as { on?: boolean };
      listenWanted = body.on !== false;
      await idbWrite([{ store: 'kv', key: 'listen', value: { on: listenWanted } }]);
    }
    syncListening();
    return json({ on: listenWanted, native: isNative, active: listenWanted && hasChannels() });
  }
  // --- More AI services, and AI found on the user's own devices ---
  if (path === '/api/device/connections' && req.method === 'GET') {
    return json({ connections: (device.connections ?? []).map((x) => ({ ...x, apiKey: x.apiKey ? `••••${x.apiKey.slice(-4)}` : '' })) });
  }
  if (path === '/api/device/connections' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as Partial<ExtraConnection>;
    const p = PRESETS.find((x) => x.id === body.preset);
    if (!p || p.id === 'anthropic') return json({ error: 'Choose a service to add.' }, 400);
    if (p.keyUrl && !p.ownAddress && !String(body.apiKey ?? '').trim()) return json({ error: `Paste your ${p.label} key.` }, 400);
    if (p.ownAddress && !/^https?:\/\/[^\s]+$/.test(String(body.baseUrl ?? ''))) return json({ error: 'Enter the server’s address, like http://localhost:11434/v1.' }, 400);
    if ((device.connections ?? []).length >= 12) return json({ error: 'You can add up to 12 services.' }, 400);
    const conn: ExtraConnection = {
      id: `c_${crypto.getRandomValues(new Uint32Array(2)).join('').slice(0, 10)}`, preset: p.id,
      label: String(body.label ?? '').trim().slice(0, 60) || undefined,
      baseUrl: p.ownAddress ? String(body.baseUrl).trim().replace(/\/$/, '') : undefined,
      apiKey: String(body.apiKey ?? '').trim() || undefined,
    };
    const next = { ...device, connections: [...(device.connections ?? []), conn] };
    applyDevice(next);
    // Check it works (and read its models) before keeping it; a rejected key isn't saved.
    const check = await refreshModels(services, conn.id);
    if (!check.ok && /rejected/i.test(check.error ?? '')) {
      applyDevice(device);
      services.db.run('DELETE FROM ai_models WHERE conn_id = ?', conn.id);
      services.db.run("DELETE FROM connection_status WHERE kind = 'ai' AND ref = ?", conn.id);
      return json({ error: `${p.label} rejected that key. Check it and try again.` }, 400);
    }
    await saveDevice(next);
    scheduleSave();
    return json({ connection: { ...conn, apiKey: conn.apiKey ? `••••${conn.apiKey.slice(-4)}` : '' }, check }, 201);
  }
  const connDel = /^\/api\/device\/connections\/([\w-]+)$/.exec(path);
  if (connDel && req.method === 'DELETE') {
    const id = connDel[1];
    if (!(device.connections ?? []).some((x) => x.id === id)) return json({ error: 'Not found', code: 'not_found' }, 404);
    // Removing a service deletes its saved key from this device.
    const next = { ...device, connections: (device.connections ?? []).filter((x) => x.id !== id) };
    await saveDevice(next);
    applyDevice(next);
    services.db.run('DELETE FROM ai_models WHERE conn_id = ?', id);
    services.db.run("DELETE FROM connection_status WHERE kind = 'ai' AND ref = ?", id);
    scheduleSave();
    return json({ removed: true });
  }
  // The phone's own abilities, for the Flutter screens: a fixed list, nothing else can be called.
  if (path === '/api/device/native' && req.method === 'POST') {
    const b = (await req.json().catch(() => ({}))) as Record<string, any>;
    const fromB64 = (b64: string, type: string) => new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type });
    switch (b.action) {
      case 'info': return json({ ...appInfo(), canPickFolders: canPickFolders(), native: isNative });
      case 'pickFolder': return json({ folder: await pickFolder() });
      case 'forgetFolder': forgetFolder(String(b.root ?? '')); return json({ ok: true });
      case 'saveFile': return json({ message: await saveFile(fromB64(String(b.b64 ?? ''), String(b.mime ?? 'application/octet-stream')), String(b.name ?? 'file')) });
      case 'shareFile': return json({ message: await shareFile(fromB64(String(b.b64 ?? ''), String(b.mime ?? 'application/octet-stream')), String(b.name ?? 'file'), String(b.text ?? '')) });
      case 'shareText': await shareText(String(b.text ?? '')); return json({ ok: true });
      case 'openExternal': openExternal(String(b.url ?? '')); return json({ ok: true });
      case 'openSignIn': return json({ error: openSignIn(String(b.url ?? '')) });
      case 'askPlacesPermission': return json({ permission: await askPlacesPermission() });
      case 'speak': speakNative(String(b.text ?? ''), String(b.lang ?? 'en-US'), () => (globalThis as any).__carinoFlutterEmit?.('spoken', {})); return json({ ok: true });
      case 'stopSpeaking': stopSpeakingNative(); return json({ ok: true });
      case 'listen':
        // The phone's speech recognition; what it hears goes to the Flutter screens as "speech" events.
        listen(String(b.lang ?? 'en-US'), (e) => (globalThis as any).__carinoFlutterEmit?.('speech', e));
        return json({ ok: true });
      case 'stopListening': stopListening(); return json({ ok: true });
      default: return json({ error: 'Unknown action' }, 400);
    }
  }
  if (path === '/api/device/discover') {
    return json({ found: await discoverHere() });
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

/** AI on this device, the paired PC, and the on-phone models. */
async function discoverHere() {
  const tauri = (globalThis as any).__TAURI__;
  const nb = (globalThis as any).CarinoNative;
  const timeout = (ms: number) => AbortSignal.timeout(ms);
  const viaFetch: Probe = async (host, port, p) => {
    const res = await fetch(`http://${host}:${port}${p}`, { signal: timeout(2500) }).catch(() => null);
    return res?.ok ? res.json().catch(() => null) : null;
  };
  // On Windows the window can't read other local ports itself (CORS): a narrow command reads the listing.
  const probe: Probe = tauri?.core?.invoke
    ? async (host, port, p) => {
      if (host !== '127.0.0.1') return viaFetch(host, port, p);
      const body = await tauri.core.invoke('probe_local_ai', { port, path: p }).catch(() => null);
      return body ? JSON.parse(body) : null;
    }
    : viaFetch;
  const pairedHosts = [...new Set(services.db.all("SELECT address FROM sync_peers WHERE confirmed = 1 AND address IS NOT NULL AND address != ''")
    .map((r) => { try { return new URL(String(r.address).includes('://') ? r.address : `http://${r.address}`).hostname; } catch { return ''; } })
    .filter(Boolean))];
  const phoneModels = nb ? (await (await onDevice()).localStatus()).models.filter((m) => m.downloaded).map((m) => m.id) : [];
  return discover({
    probe, pairedHosts, thisDevice: !nb, phoneModels,
    // The app's own requests (CORS on Windows and in a browser; Android's requests aren't limited).
    appCanReach: nb ? undefined : async (base) => !!(await fetch(`${base}/models`, { signal: timeout(2500) }).catch(() => null))?.ok,
  });
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
/** How long each start-up step took, for the "engine ready" log line. */
const timings: Record<string, number> = {};
let mark = performance.now();
const lap = (name: string) => { const t = performance.now(); timings[name] = Math.round(t - mark); mark = t; };

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
  lap('sqlite');
  for (const [file, sql] of Object.entries(MIGRATIONS)) seedFile(`${MIGRATIONS_DIR}/${file.split('/').pop()}`, sql);
  configureSqlite(sqlite3, { initial: await idbGet<Uint8Array>('db', 'main'), onWrite: scheduleSave });
  lap('load');

  vault = await Vault.load({ get: (k) => idbGet('kv', k), set: (k, v) => idbWrite([{ store: 'kv', key: k, value: v }]) }, vaultPlatform());
  await protectSecretKey();
  const stored = await idbGet<Record<string, any>>('kv', 'device');
  if (stored) {
    const opened = await openConfig<DeviceConfig>(vault, stored);
    device = opened.config;
    keysUnreadable = opened.unreadable || vault.lost;
    // Keys saved by an older version in plain form: seal them now.
    if (opened.legacy) await saveDevice(device);
  } else device = { provider: null };
  lap('vault');
  const config = loadConfig(envFor(device));
  const db = new Db(`${DATA_DIR}/carino.db`, MIGRATIONS_DIR);
  lap('open');
  services = {
    db, config,
    providers: createRegistry(config, aiFetch, connectionSpecs(device)),
    online: () => navigator.onLine,
    search: createSearchService({ searxngUrl: config.SEARXNG_URL, braveKey: config.BRAVE_SEARCH_API_KEY }),
    push: phonePush,
    loadFiles: preloadFiles,
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
  lap('server');
  await ensureOwner();
  // Saved in the background (a fresh install's first save takes about a second on a phone).
  // If the app closes before it lands, the next start simply rebuilds the same empty setup.
  scheduleSave();
  lap('owner');

  startScheduler(services);
  // Keep authorised connections fresh: shortly after opening, then once a day while open.
  const refreshConnections = () => {
    const owner = services.db.get('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (owner && navigator.onLine) void refreshAll(services, owner.id).then(scheduleSave).catch(() => undefined);
  };
  setTimeout(refreshConnections, 5000);
  setInterval(refreshConnections, 24 * 3600_000);
  startTelegram(services);
  listenWanted = (await idbGet<{ on?: boolean }>('kv', 'listen'))?.on !== false;
  syncListening();
  setInterval(() => document.visibilityState === 'visible' && pollWhatsApp(), 4000);
  // Snooze / Done on notifications and arrivals at places, recorded by Android while closed.
  applyReminderEvents();
  setInterval(applyReminderEvents, 5000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && applyReminderEvents());
  // The background listener (Android) nudges the app every few seconds while it's hidden.
  window.addEventListener('carino-tick', pollWhatsApp);
  // Channels are added and removed in Messaging; keep the notification in step.
  setInterval(syncListening, 30_000);
  // Carino for Windows (desktop/app): answer a paired phone's sync requests, passed in by the window's
  // local-network listener, and tell the Devices screen this PC's addresses.
  const tauri = (globalThis as any).__TAURI__;
  if (tauri?.event?.listen && tauri?.core?.invoke) {
    const { handleSyncRequest, identity, renameDevice } = await import('../server/services/sync.ts');
    const me = await identity(services);
    if (me.name === 'This device') renameDevice(services.db, 'PC');
    (globalThis as any).CarinoDesktop = {
      isDesktop: true,
      lanAddresses: () => tauri.core.invoke('lan_addresses'),
      pickFolder: () => tauri.core.invoke('pick_folder'),
      forgetFolder: (root: string) => tauri.core.invoke('forget_folder', { root }),
    };
    services.localFs = (await import('./localfs-native.ts')).tauriLocalFs(tauri.core.invoke);
    services.localApps = {
      list: () => tauri.core.invoke('list_apps'),
      openApp: (id, root, rel) => tauri.core.invoke('open_app', { id, root, rel }),
      openFile: (root, rel) => tauri.core.invoke('open_file', { root, rel }),
    };
    Object.assign((globalThis as any).CarinoDesktop, {
      listApps: () => tauri.core.invoke('list_apps'),
      pickApp: () => tauri.core.invoke('pick_app'),
      forgetApp: (id: string) => tauri.core.invoke('forget_app', { id }),
    });
    await tauri.event.listen('carino-sync-request', async (e: { payload: { id: number; body: string } }) => {
      const out = await handleSyncRequest(services, e.payload.body);
      await tauri.core.invoke('sync_reply', { id: e.payload.id, body: out });
      scheduleSave();
    });
  }
  // Android: folders picked in the system's folder picker.
  const nb = (globalThis as any).CarinoNative;
  if (nb?.folderList) {
    services.localFs = (await import('./localfs-native.ts')).androidLocalFs(nb);
    services.localApps = {
      list: async () => [],
      openApp: async () => { throw new Error('Opening apps is only on Carino for Windows.'); },
      openFile: async (root, rel) => {
        const r = JSON.parse(nb.folderOpen(root, rel));
        if (!r.ok) throw new Error(r.error);
      },
    };
  }
  // Paired PC on the same Wi-Fi: keep in step every minute while the app is open, and on opening it.
  syncDevices();
  setInterval(() => document.visibilityState === 'visible' && syncDevices(), 60_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && syncDevices());

  const toBackground = () => void flush();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && toBackground());
  window.addEventListener('pagehide', toBackground);
  // Lets tests (and the Android check) wait for everything to be saved, as a normal close does.
  (globalThis as any).__flushEngine = flush;
}

const ready = boot().then(() => console.info(`Carino engine ready (${Object.entries(timings).map(([k, v]) => `${k} ${v} ms`).join(', ')})`));
// Inside the Flutter app: its screens reach the engine through this link.
ready.then(() => startFlutterLink(handle));
export const engineReady = ready;
