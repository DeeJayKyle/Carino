// Memory-leak check: walk the main screens many times, in-app (no reloads), and compare the
// JS heap after forced garbage collection at the start, middle and end.
const { chromium } = require('playwright');
const [URL_, AI, ROUNDS = '30'] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true }); const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page); await cdp.send('Performance.enable');
  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); await page.waitForTimeout(300); await cdp.send('HeapProfiler.collectGarbage'); const m = (await cdp.send('Performance.getMetrics')).metrics; const g = (n) => m.find((x) => x.name === n)?.value; return { heapMB: +(g('JSHeapUsedSize') / 1048576).toFixed(1), nodes: g('Nodes'), listeners: g('JSEventListeners') }; };
  await page.goto(URL_ + '/'); await page.waitForTimeout(2500);
  await page.evaluate(async (AI) => { const h = { 'content-type': 'application/json', 'x-hailey': '1', 'x-carino': '1' };
    await fetch('/api/settings', { method: 'PATCH', headers: h, body: JSON.stringify({ onboarded: true, profile: { displayName: 'Herbert' } }) });
    await fetch('/api/device/config', { method: 'PUT', headers: h, body: JSON.stringify({ provider: 'custom', baseUrl: AI, model: 'qa-model' }) });
    for (let i = 0; i < 30; i++) await fetch('/api/tasks', { method: 'POST', headers: h, body: JSON.stringify({ title: 'Task ' + i }) });
    await globalThis.__flushEngine(); }, AI);
  await page.reload(); await page.waitForTimeout(2000);
  const routes = ['/', '/discover', '/tasks', '/chat/new', '/memory', '/stuff', '/me', '/settings', '/routines', '/ramble'];
  const go = (r) => page.evaluate((r) => { history.pushState(null, '', r); dispatchEvent(new PopStateEvent('popstate')); }, r);
  const walk = async (n) => { for (let i = 0; i < n; i++) for (const r of routes) { await go(r); await page.waitForTimeout(80); } };
  await walk(3); const start = await heap();
  await walk(+ROUNDS / 2); const mid = await heap();
  await walk(+ROUNDS / 2); const end = await heap();
  const perRound = ((end.heapMB - mid.heapMB) / (+ROUNDS / 2)).toFixed(3);
  console.log(JSON.stringify({ visits: routes.length * (+ROUNDS + 3), start, mid, end, growthPerRoundMB: perRound }));
  await b.close();
})();
