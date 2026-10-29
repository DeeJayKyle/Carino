import { randomBytes } from 'node:crypto';
import type { Services } from '../context.ts';
import { badRequest } from '../context.ts';
import type { Row } from '../db/index.ts';
import { parseJson, nowIso } from '../db/index.ts';
import { encryptSecret } from './secrets.ts';
import { channelSecret } from './channels.ts';
import { signatureValid, processWhatsAppPayload, type WaConfig } from './whatsapp.ts';

/**
 * WhatsApp on the phone. Meta only delivers messages to a web address that's always online, so
 * the user deploys a tiny free relay (relay/ in this repository, on Cloudflare Workers). The
 * relay keeps each delivery — exactly as Meta signed it — until the phone collects it; the phone
 * checks Meta's signature with the app secret (which never leaves the phone), answers, and
 * removes it from the relay. Replies go straight from the phone to WhatsApp.
 */
export interface RelayItem { id: number; at: number; sig: string; body: string }

type Secret = { access_token: string; app_secret: string; relay_key?: string };

const fetcher = (services: Services) => services.netFetch ?? fetch;

export function relayAddress(raw: string) {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw badRequest('Paste the relay’s address, e.g. https://carino-whatsapp-relay.yourname.workers.dev');
  }
  if (u.protocol !== 'https:') throw badRequest('The relay address must start with https://');
  return u.origin;
}

async function relayCall(services: Services, base: string, key: string, path: string, body?: unknown) {
  let res: Response;
  try {
    res = await fetcher(services)(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('Could not reach your WhatsApp relay. Check the address and your internet connection.');
  }
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new Error('Your WhatsApp relay refused Carino’s key. If you reinstalled Carino, set up a fresh relay (see the steps).');
  if (res.status === 409) throw new Error('That relay is already linked to another Carino. Deploy your own relay, or delete and redeploy this one to reset it.');
  if (!res.ok) throw new Error(`Your WhatsApp relay answered with error ${res.status}${data?.error ? `: ${data.error}` : ''}.`);
  return data;
}

/** Links the user's WhatsApp channel to their relay: claims it with a new key and tells it the verify token. */
export async function connectRelay(services: Services, userId: string, rawUrl: string, newKey?: string) {
  const ch = services.db.get("SELECT * FROM channels WHERE user_id = ? AND kind = 'whatsapp'", userId);
  if (!ch) throw badRequest('Connect WhatsApp first (phone number ID, token and app secret).');
  const base = relayAddress(rawUrl);
  const secret = channelSecret<Secret>(services, ch);
  if (!secret) throw badRequest('The saved WhatsApp details can no longer be read. Connect WhatsApp again.');
  const cfg = parseJson<WaConfig>(ch.config, {} as WaConfig);
  // Re-linking the same relay keeps the key it already knows.
  const key = newKey ?? (cfg.relay_url === base && secret.relay_key ? secret.relay_key : randomBytes(24).toString('base64url'));
  try {
    await relayCall(services, base, key, '/setup', { verify_token: cfg.verify_token });
  } catch (e: any) {
    throw badRequest(e.message);
  }
  services.db.run(
    'UPDATE channels SET secret = ?, config = ?, last_error = NULL, updated_at = ? WHERE id = ?',
    encryptSecret(services.config.DATA_DIR, JSON.stringify({ ...secret, relay_key: key })),
    JSON.stringify({ ...cfg, relay_url: base }), nowIso(), ch.id,
  );
  return services.db.get('SELECT * FROM channels WHERE id = ?', ch.id)!;
}

/** Recently handled deliveries, so one is never answered twice if an acknowledgement was lost. */
const handled = new Set<number>();
let busy: Promise<number> | null = null;

/** Collects and answers waiting WhatsApp messages from the relay. Returns how many were handled. */
export function pollRelay(services: Services): Promise<number> {
  busy ??= pollAll(services).finally(() => (busy = null));
  return busy;
}

async function pollAll(services: Services) {
  let n = 0;
  for (const ch of services.db.all("SELECT * FROM channels WHERE kind = 'whatsapp' AND enabled = 1")) {
    const cfg = parseJson<WaConfig>(ch.config, {} as WaConfig);
    const secret = cfg.relay_url ? channelSecret<Secret>(services, ch) : null;
    if (!cfg.relay_url || !secret?.relay_key) continue;
    try {
      n += await pollOne(services, ch, cfg.relay_url, secret.relay_key);
      if (ch.last_error) services.db.run('UPDATE channels SET last_error = NULL WHERE id = ?', ch.id);
    } catch (e: any) {
      services.db.run('UPDATE channels SET last_error = ? WHERE id = ?', String(e?.message ?? e).slice(0, 300), ch.id);
    }
  }
  return n;
}

async function pollOne(services: Services, ch: Row, base: string, key: string) {
  const { items = [] } = (await relayCall(services, base, key, '/inbox')) as { items?: RelayItem[] };
  if (!items.length) return 0;
  const done: number[] = [];
  for (const item of items) {
    done.push(item.id);
    if (handled.has(item.id)) continue;
    handled.add(item.id);
    if (handled.size > 2000) handled.delete(handled.values().next().value!);
    // Anyone can post to the relay's public address; only Meta's signed deliveries count.
    if (!signatureValid(services, ch, item.body, item.sig)) continue;
    const payload = parseJson<any>(item.body, null);
    if (payload) await processWhatsAppPayload(services, ch, payload);
  }
  await relayCall(services, base, key, '/ack', { ids: done });
  return done.length;
}
