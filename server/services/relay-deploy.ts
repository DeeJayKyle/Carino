import { randomBytes } from 'node:crypto';
import type { Services } from '../context.ts';
import { badRequest } from '../context.ts';
import RELAY_SOURCE from '../../relay/worker.js?raw';

/**
 * "Create my relay": puts relay/worker.js on the user's own free Cloudflare account through
 * Cloudflare's API, with a token they create (Workers Scripts: Edit). The token is used once
 * and not stored. Returns the relay's address.
 */
const CF = 'https://api.cloudflare.com/client/v4';
export const RELAY_NAME = 'carino-whatsapp-relay';
const COMPAT_DATE = '2025-09-01';

async function cf(services: Services, token: string, path: string, init: { method?: string; body?: BodyInit; json?: unknown } = {}) {
  let res: Response;
  try {
    res = await (services.netFetch ?? fetch)(`${CF}${path}`, {
      method: init.method ?? (init.body || init.json ? 'POST' : 'GET'),
      headers: { authorization: `Bearer ${token}`, ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw badRequest('Could not reach Cloudflare. Check your internet connection.');
  }
  const d: any = await res.json().catch(() => ({}));
  return { ok: res.ok && d.success !== false, status: res.status, result: d.result, errors: (d.errors ?? []) as { code: number; message: string }[] };
}

const why = (r: { errors: { message: string }[]; status: number }) => r.errors.map((e) => e.message).join('; ') || `error ${r.status}`;

/** `claimKey` is stored as the relay's secret, so this Carino can claim it even if another once did. */
export async function deployRelay(services: Services, rawToken: string, claimKey: string) {
  const token = rawToken.trim();
  if (token.length < 20) throw badRequest('Paste the Cloudflare API token you created.');
  const accounts = await cf(services, token, '/accounts?per_page=5');
  if (accounts.status === 401 || accounts.status === 403) throw badRequest('Cloudflare refused that token. Create one with the “Edit Cloudflare Workers” template.');
  const account = accounts.result?.[0]?.id as string | undefined;
  if (!account) throw badRequest(`Cloudflare didn’t list an account for that token (${why(accounts)}).`);

  // The module and its Durable Object (where messages wait), with its storage created on first upload.
  const upload = async (withMigration: boolean) => {
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify({
      main_module: 'worker.js', compatibility_date: COMPAT_DATE,
      bindings: [{ type: 'durable_object_namespace', name: 'INBOX', class_name: 'Inbox' }, { type: 'secret_text', name: 'CLAIM_KEY', text: claimKey }],
      ...(withMigration ? { migrations: { new_tag: 'v1', new_sqlite_classes: ['Inbox'] } } : {}),
    })], { type: 'application/json' }));
    form.set('worker.js', new Blob([RELAY_SOURCE], { type: 'application/javascript+module' }), 'worker.js');
    return cf(services, token, `/accounts/${account}/workers/scripts/${RELAY_NAME}`, { method: 'PUT', body: form });
  };
  let up = await upload(true);
  // Already created before: its storage exists, so upload the code again without creating it.
  if (!up.ok && /migration/i.test(why(up))) up = await upload(false);
  if (!up.ok) throw badRequest(`Cloudflare didn’t accept the relay: ${why(up)}`);

  // A workers.dev address: the account's own subdomain (made once if it has none yet).
  let sub = await cf(services, token, `/accounts/${account}/workers/subdomain`);
  let subdomain = sub.ok ? (sub.result?.subdomain as string | undefined) : undefined;
  if (!subdomain) {
    sub = await cf(services, token, `/accounts/${account}/workers/subdomain`, { method: 'PUT', json: { subdomain: `carino-${randomBytes(4).toString('hex')}` } });
    subdomain = sub.result?.subdomain;
    if (!subdomain) throw badRequest(`Cloudflare couldn’t give the relay a web address: ${why(sub)}`);
  }
  const on = await cf(services, token, `/accounts/${account}/workers/scripts/${RELAY_NAME}/subdomain`, { method: 'POST', json: { enabled: true, previews_enabled: false } });
  if (!on.ok) throw badRequest(`Cloudflare couldn’t switch on the relay’s address: ${why(on)}`);
  return `https://${RELAY_NAME}.${subdomain}.workers.dev`;
}
