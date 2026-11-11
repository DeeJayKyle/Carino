/**
 * Saved credentials (AI keys, search keys, the key that protects account sign-ins) are kept
 * encrypted. One random master key encrypts them (AES-256-GCM, WebCrypto); the master key itself
 * is sealed by the system:
 *   - Android: a key in the Android Keystore that can't be read or exported, even by Carino;
 *   - Windows: DPAPI, so only this Windows account on this PC can open it;
 *   - a plain browser: a non-extractable WebCrypto key (scripts can use it but never read it).
 * Credentials are decrypted into memory only while the app runs, and are never shown again
 * (the app shows the last four characters).
 */

export type Protection = 'android-keystore' | 'windows-dpapi' | 'browser';

export interface VaultPlatform {
  name: Protection;
  /** base64 in, sealed base64 out (absent: no system key store; a browser key is used). */
  seal?: (b64: string) => Promise<string>;
  open?: (b64: string) => Promise<string>;
}

export interface VaultStore {
  get(key: string): Promise<any>;
  set(key: string, value: unknown): Promise<void>;
}

const PREFIX = 'vault1:';
const STORE_KEY = 'vault';

const b64 = (u: Uint8Array) => {
  let s = '';
  for (const c of u) s += String.fromCharCode(c);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const subtle = () => globalThis.crypto.subtle;
const importKey = (raw: Uint8Array) => subtle().importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);

export class Vault {
  /** True when saved credentials from before couldn't be opened (e.g. the system key was reset). */
  lost = false;

  private key: CryptoKey;
  readonly protection: Protection;

  private constructor(key: CryptoKey, protection: Protection) {
    this.key = key;
    this.protection = protection;
  }

  /** Opens the master key, creating it on first use. */
  static async load(store: VaultStore, platform: VaultPlatform): Promise<Vault> {
    const saved = await store.get(STORE_KEY);
    if (saved?.kind && saved.kind !== 'browser' && saved.sealed && platform.open) {
      try {
        return new Vault(await importKey(unb64(await platform.open(saved.sealed))), saved.kind);
      } catch {
        return Vault.create(store, platform, true);
      }
    }
    if (saved?.kind === 'browser' && saved.key) {
      // A browser-held key can't be moved into a system key store (it can't be read), so it stays.
      return new Vault(saved.key as CryptoKey, 'browser');
    }
    if (saved?.kind && saved.kind !== 'browser') return Vault.create(store, platform, true); // sealed by a store we can't reach now
    return Vault.create(store, platform, false);
  }

  private static async create(store: VaultStore, platform: VaultPlatform, lost: boolean): Promise<Vault> {
    if (platform.seal && platform.open) {
      try {
        const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
        const sealed = await platform.seal(b64(raw));
        // Prove it round-trips before relying on it.
        const back = unb64(await platform.open(sealed));
        if (b64(back) !== b64(raw)) throw new Error('round trip');
        await store.set(STORE_KEY, { kind: platform.name, sealed });
        const v = new Vault(await importKey(raw), platform.name);
        raw.fill(0);
        v.lost = lost;
        return v;
      } catch {
        // The system key store failed: fall back to a browser-held key rather than not saving at all.
      }
    }
    const key = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await store.set(STORE_KEY, { kind: 'browser', key });
    const v = new Vault(key, 'browser');
    v.lost = lost;
    return v;
  }

  static isSealed(v: unknown): v is string {
    return typeof v === 'string' && v.startsWith(PREFIX);
  }

  async seal(text: string): Promise<string> {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const body = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, this.key, new TextEncoder().encode(text)));
    const out = new Uint8Array(12 + body.length);
    out.set(iv);
    out.set(body, 12);
    return PREFIX + b64(out);
  }

  /** null when it can't be opened (wrong device, reset key store, damaged data). */
  async open(sealed: string): Promise<string | null> {
    if (!Vault.isSealed(sealed)) return null;
    try {
      const all = unb64(sealed.slice(PREFIX.length));
      const plain = await subtle().decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12) }, this.key, all.subarray(12));
      return new TextDecoder().decode(plain);
    } catch {
      return null;
    }
  }
}

/** The fields of a saved configuration that are credentials. */
export const SECRET_FIELDS = ['apiKey', 'groqKey', 'braveKey', 'githubToken'] as const;

/**
 * Splits credentials out of a configuration and seals them; the rest stays readable (provider,
 * model, address). Connections (several AI services) carry their own sealed keys the same way.
 */
export async function sealConfig<T extends Record<string, any>>(vault: Vault, c: T): Promise<Record<string, unknown>> {
  const secrets: Record<string, string> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if ((SECRET_FIELDS as readonly string[]).includes(k)) { if (v) secrets[k] = String(v); } else if (k === 'connections' && Array.isArray(v)) {
      rest.connections = await Promise.all(v.map(async (x: any) => {
        const { apiKey, ...plain } = x;
        return apiKey ? { ...plain, sealedKey: await vault.seal(String(apiKey)) } : plain;
      }));
    } else rest[k] = v;
  }
  if (Object.keys(secrets).length) rest.sealed = await vault.seal(JSON.stringify(secrets));
  return rest;
}

/** Reverses sealConfig. Plain (older) configurations come back unchanged, ready to be re-saved sealed. */
export async function openConfig<T>(vault: Vault, stored: Record<string, any>): Promise<{ config: T; legacy: boolean; unreadable: boolean }> {
  const { sealed, ...rest } = stored;
  const legacy = SECRET_FIELDS.some((k) => typeof stored[k] === 'string' && stored[k]) || (Array.isArray(stored.connections) && stored.connections.some((x: any) => typeof x.apiKey === 'string' && x.apiKey));
  let unreadable = false;
  if (sealed) {
    const opened = await vault.open(sealed);
    if (opened) Object.assign(rest, JSON.parse(opened));
    else unreadable = true;
  }
  if (Array.isArray(rest.connections)) {
    rest.connections = await Promise.all(rest.connections.map(async (x: any) => {
      if (!x.sealedKey) return x;
      const { sealedKey, ...plain } = x;
      const key = await vault.open(sealedKey);
      if (key === null) unreadable = true;
      return key === null ? plain : { ...plain, apiKey: key };
    }));
  }
  return { config: rest as T, legacy, unreadable };
}
