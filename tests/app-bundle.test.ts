import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Checks the bundle that goes inside the APK. Run `npm run build` first (CI does).
const www = resolve('android/app/src/main/assets/www');
const built = existsSync(resolve(www, 'index.html'));

describe.skipIf(!built)('app bundle for the APK', () => {
  const assets = built ? readdirSync(resolve(www, 'assets')) : [];

  it('ships the database engine and the on-phone server', () => {
    expect(assets.some((f) => f.endsWith('.wasm'))).toBe(true);
    expect(assets.some((f) => f.startsWith('engine-') && f.endsWith('.js'))).toBe(true);
  });

  it('includes responsive layout rules for phones and dark mode', () => {
    const css = readFileSync(resolve(www, 'assets', assets.find((f) => f.endsWith('.css'))!), 'utf8');
    expect(css).toContain('.bottom-nav');
    expect(css).toContain('safe-area-inset-bottom');
    expect(css).toMatch(/prefers-color-scheme:\s?dark/);
  });

  it('loads nothing from other websites', () => {
    const html = readFileSync(resolve(www, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
    expect(html).toContain('<title>Carino</title>');
  });
});
