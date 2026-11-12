import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as browser from '../server/services/browser.ts';

// Uses a real Chromium when Playwright is installed on this machine; skipped otherwise.
const pw: any = (() => {
  const req = createRequire(import.meta.url);
  for (const id of ['playwright', '/opt/node-tools/node_modules/playwright/index.js']) {
    try { return req(id); } catch { /* try the next */ }
  }
  return null;
})();

let b: any;
let page: any;
beforeAll(async () => {
  if (!pw) return;
  b = await pw.chromium.launch();
  page = await b.newPage();
});
afterAll(async () => b?.close());

const html = `<!doctype html><title>Shop</title><h1>Basket</h1>
  <label for="nm">Your name</label><input id="nm">
  <input type="password" name="pw" placeholder="Password">
  <input name="cardnumber" placeholder="Card number">
  <select id="size"><option>Small</option><option>Large</option></select>
  <button onclick="document.title='added'">Add to basket</button>
  <button onclick="document.title='ordered'">Place order</button>`;

// A host backed by a real browser page, like the phone's hidden WebView.
const services: any = {
  browser: {
    open: async () => { await page.setContent(html); },
    eval: async (js: string) => JSON.stringify(await page.evaluate(js)),
    back: async () => {},
  },
};

describe.skipIf(!pw)('browser agent', () => {
  it('lists what can be used, types, chooses, and holds back risky and secret things', async () => {
    await services.browser.open('x');
    const snap = await browser.look(services);
    const byLabel = (l: string) => snap.elements.find((e: any) => e.label === l);
    expect(snap.title).toBe('Shop');
    expect(byLabel('Place order').risky).toBe(true);
    expect(byLabel('Password').secret).toBe(true);

    expect((await browser.act(services, byLabel('Your name').n, 'type', 'Herbert', false) as any).done.ok).toBe(true);
    expect(await page.inputValue('#nm')).toBe('Herbert');
    expect((await browser.act(services, byLabel('Password').n, 'type', 'hunter2', false) as any).error).toMatch(/never types passwords/);
    expect((await browser.act(services, byLabel('Card number').n, 'type', '4111', false) as any).error).toMatch(/card/);
    await browser.act(services, (await browser.look(services)).elements.find((e: any) => e.kind === 'select').n, 'select', 'Large', false);
    expect(await page.inputValue('#size')).toBe('Large');

    const n = (await browser.look(services)).elements.find((e: any) => e.label === 'Place order').n;
    const held: any = await browser.act(services, n, 'click', undefined, false);
    expect(held.needs_confirmation).toBe(true);
    expect(await page.title()).toBe('Shop');
    await browser.act(services, n, 'click', undefined, true);
    expect(await page.title()).toBe('ordered');
  }, 30_000);

  it('only opens public websites', async () => {
    await expect(browser.open(services, 'http://127.0.0.1:8080/admin')).rejects.toThrow(/public websites/);
    await expect(browser.open(services, 'file:///etc/passwd')).rejects.toThrow();
  });
});
