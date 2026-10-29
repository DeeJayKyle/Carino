// Start-up time at phone speed (CPU slowed 4x): first run and a returning run with data.
const { chromium } = require('playwright');
const [URL_, RATE = '4'] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 400, height: 860 }, isMobile: true }); const page = await ctx.newPage();
  const logs = []; page.on('console', (m) => { if (/engine ready/.test(m.text())) logs.push(m.text()); });
  const cdp = await ctx.newCDPSession(page);
  const run = async (label) => {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: +RATE });
    const t0 = Date.now(); await page.goto(URL_ + '/');
    await page.locator('h1, h2, label').first().waitFor({ timeout: 60000 });
    const ms = Date.now() - t0;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.waitForTimeout(500);
    console.log(label, 'first screen', ms, 'ms |', logs.at(-1));
  };
  await run('first run   ');
  await page.evaluate(async () => { const h = { 'content-type': 'application/json', 'x-hailey': '1', 'x-carino': '1' };
    await fetch('/api/settings', { method: 'PATCH', headers: h, body: JSON.stringify({ onboarded: true }) });
    for (let i = 0; i < 300; i++) await fetch('/api/tasks', { method: 'POST', headers: h, body: JSON.stringify({ title: 'T' + i }) });
    await globalThis.__flushEngine(); });
  await run('returning   ');
  await run('returning 2 ');
  await b.close();
})();
