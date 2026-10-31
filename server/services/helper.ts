import type { Services } from '../context.ts';

/**
 * Carino's sign-in helper (auth/worker.js), when the build has one: one-tap sign-in for My apps
 * and the shared WhatsApp number. Its /config says which apps are set up there.
 */
export interface HelperConfig {
  url: string;
  providers: Record<string, { client_id: string }>;
  whatsapp: { number: string | null } | null;
}

let cached: { at: number; url: string; value: HelperConfig | null } | null = null;

export const helperUrl = (services: Services) => services.config.CARINO_HELPER_URL.replace(/\/+$/, '');

/** The helper's offer, cached for a few minutes (a failed check is retried sooner). */
export async function helperConfig(services: Services): Promise<HelperConfig | null> {
  const url = helperUrl(services);
  if (!url) return null;
  const now = Date.now();
  if (cached && cached.url === url && now - cached.at < (cached.value ? 5 * 60_000 : 30_000)) return cached.value;
  let value: HelperConfig | null = null;
  try {
    const res = await (services.netFetch ?? fetch)(`${url}/config`, { signal: AbortSignal.timeout(10_000) });
    const d: any = res.ok ? await res.json() : null;
    if (d?.providers) value = { url, providers: d.providers, whatsapp: d.whatsapp ?? null };
  } catch {
    value = null;
  }
  cached = { at: now, url, value };
  return value;
}

/** For tests: forget the cached offer. */
export const resetHelperCache = () => void (cached = null);

/** POST to the helper; throws with its own message on failure. */
export async function helperPost<T = any>(services: Services, path: string, body: unknown, key?: string): Promise<T> {
  let res: Response;
  try {
    res = await (services.netFetch ?? fetch)(`${helperUrl(services)}${path}`, {
      method: 'POST', body: JSON.stringify(body ?? {}),
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('Could not reach Carino’s sign-in helper. Check your internet connection.');
  }
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(d?.error ?? `Carino’s sign-in helper answered with error ${res.status}.`), { status: res.status });
  return d as T;
}

export async function helperGet<T = any>(services: Services, path: string, key: string): Promise<T> {
  let res: Response;
  try {
    res = await (services.netFetch ?? fetch)(`${helperUrl(services)}${path}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error('Could not reach Carino’s sign-in helper. Check your internet connection.');
  }
  if (!res.ok) {
    const d: any = await res.json().catch(() => ({}));
    throw Object.assign(new Error(d?.error ?? `Carino’s sign-in helper answered with error ${res.status}.`), { status: res.status });
  }
  return res as unknown as T;
}
