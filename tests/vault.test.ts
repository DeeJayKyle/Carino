import { describe, it, expect } from 'vitest';
import { Vault, openConfig, sealConfig, type VaultPlatform, type VaultStore } from '../mobile/vault.ts';

const memStore = (): VaultStore & { data: Map<string, any> } => {
  const data = new Map<string, any>();
  return { data, get: async (k) => data.get(k), set: async (k, v) => { data.set(k, v); } };
};
/** A stand-in for the Android Keystore / DPAPI: seals with its own hidden key. */
const fakeKeystore = (name: VaultPlatform['name'] = 'android-keystore') => {
  const hidden = crypto.getRandomValues(new Uint8Array(32));
  const xor = (b64: string) => btoa(String.fromCharCode(...Uint8Array.from(atob(b64), (c, i) => c.charCodeAt(0) ^ hidden[i % 32])));
  let broken = false;
  return {
    name, seal: async (x: string) => `S${xor(x)}`,
    open: async (x: string) => { if (broken || !x.startsWith('S')) throw new Error('key gone'); return xor(x.slice(1)); },
    breakIt: () => { broken = true; },
  };
};

describe('credential vault', () => {
  it('seals and opens, and another device cannot open it', async () => {
    const ks = fakeKeystore();
    const v = await Vault.load(memStore(), ks);
    expect(v.protection).toBe('android-keystore');
    const s = await v.seal('sk-test-1234567890');
    expect(s).not.toContain('sk-test');
    expect(await v.open(s)).toBe('sk-test-1234567890');
    const other = await Vault.load(memStore(), fakeKeystore());
    expect(await other.open(s)).toBeNull();
    expect(await v.open('vault1:AAAA')).toBeNull();
  });

  it('keeps the same master key across restarts, sealed by the system key store', async () => {
    const store = memStore();
    const ks = fakeKeystore('windows-dpapi');
    const s = await (await Vault.load(store, ks)).seal('secret');
    expect(JSON.stringify(store.data.get('vault'))).not.toMatch(/secret/);
    const again = await Vault.load(store, ks);
    expect(again.protection).toBe('windows-dpapi');
    expect(again.lost).toBe(false);
    expect(await again.open(s)).toBe('secret');
  });

  it('says so when the system key was reset, and starts a new key', async () => {
    const store = memStore();
    const ks = fakeKeystore();
    const s = await (await Vault.load(store, ks)).seal('secret');
    ks.breakIt();
    const after = await Vault.load(store, ks);
    expect(after.lost).toBe(true);
    expect(await after.open(s)).toBeNull();
  });

  it('falls back to a browser-held key when there is no system key store, or it fails', async () => {
    const store = memStore();
    const v = await Vault.load(store, { name: 'browser' });
    expect(v.protection).toBe('browser');
    const s = await v.seal('x');
    expect(await (await Vault.load(store, { name: 'browser' })).open(s)).toBe('x');
    const failing: VaultPlatform = { name: 'android-keystore', seal: async () => { throw new Error('no'); }, open: async () => { throw new Error('no'); } };
    expect((await Vault.load(memStore(), failing)).protection).toBe('browser');
  });

  it('stores configurations without any credential in readable form, and moves old plain ones over', async () => {
    const v = await Vault.load(memStore(), fakeKeystore());
    const plain = {
      provider: 'groq', model: 'm', apiKey: 'gsk_LIVEKEY_abcdef123456', braveKey: 'BSA-brave-999', baseUrl: 'https://api.groq.com/openai/v1',
      connections: [{ id: 'c1', preset: 'gemini', apiKey: 'AIza-gemini-key-777' }, { id: 'c2', preset: 'custom', baseUrl: 'http://localhost:11434/v1' }],
    };
    const stored = await sealConfig(v, plain);
    const text = JSON.stringify(stored);
    for (const k of ['gsk_LIVEKEY', 'BSA-brave', 'AIza-gemini']) expect(text).not.toContain(k);
    expect(stored).toMatchObject({ provider: 'groq', model: 'm' });
    const back = await openConfig<any>(v, stored);
    expect(back.legacy).toBe(false);
    expect(back.unreadable).toBe(false);
    expect(back.config).toEqual(plain);
    const old = await openConfig<any>(v, plain);
    expect(old.legacy).toBe(true);
    expect(old.config.apiKey).toBe('gsk_LIVEKEY_abcdef123456');
  });

  it('reports keys that can no longer be opened instead of failing', async () => {
    const stored = await sealConfig(await Vault.load(memStore(), fakeKeystore()), { provider: 'groq', apiKey: 'k1', connections: [{ id: 'a', apiKey: 'k2' }] });
    const r = await openConfig<any>(await Vault.load(memStore(), fakeKeystore()), stored);
    expect(r.unreadable).toBe(true);
    expect(r.config.apiKey).toBeUndefined();
    expect(r.config.connections[0]).toEqual({ id: 'a' });
  });
});
