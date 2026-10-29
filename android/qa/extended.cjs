// Extended QA for the phone apps (browser build of the on-phone engine):
// startup and load speed, every screen at four widths and with large text, accessibility (axe-core),
// console errors, AI failures (bad key, rate limit, outage, offline, slow stream + Stop),
// automatic model switching, the speed test, hostile HTML in replies and titles, long and
// non-Latin content, big data sets, offline use, export and erase.
// Usage: node extended.cjs <hailey|carino> <appUrl> <aiUrl> <outDir>
const { chromium } = require('playwright');
const fs = require('fs');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const [APP, URL_, AI, OUT] = process.argv.slice(2);
const CARINO = APP === 'carino';
const NAME = CARINO ? 'Carino' : 'Hailey';
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const findings = [];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  // Groq, standing in: requests to the real address go to the stand-in AI, so the real preset
  // (with its automatic model switching) is exercised. `groqMode` scripts outages.
  let groqMode = 'normal';
  const groqCalls = [];
  await ctx.route('https://api.groq.com/**', async (route) => {
    const req = route.request();
    let model = '';
    try { model = JSON.parse(req.postData() || '{}').model ?? ''; } catch {}
    groqCalls.push(model);
    if (groqMode === 'offline') return route.abort('internetdisconnected');
    if (groqMode === 'down') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"overloaded"}}' });
    if (groqMode === 'first-limited' && model === 'openai/gpt-oss-120b') return route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":{"message":"Rate limit reached"}}' });
    const url = req.url().replace('https://api.groq.com/openai/v1', AI);
    const res = await route.fetch({ url });
    return route.fulfill({ response: res });
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|status of 4\d\d|status of 5\d\d/.test(m.text())) errors.push('console: ' + m.text().slice(0, 200)); });
  page.on('dialog', (d) => { findings.push(`A dialog opened: "${d.message()}"`); d.dismiss(); });

  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? '' });
      console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
    } catch (e) {
      const msg = String(e.message ?? e).split('\n')[0].slice(0, 400);
      results.push({ name, ok: false, ms: Date.now() - t0, detail: msg });
      console.log(`FAIL  ${name} — ${msg}`);
      await page.screenshot({ path: `${OUT}/FAIL-${name.replace(/\W+/g, '-').slice(0, 50)}.png` }).catch(() => {});
    }
  };
  const expect = (c, m) => { if (!c) throw new Error(m); };
  const api = (method, path, body) => page.evaluate(async ([m, p, b]) => {
    const r = await fetch('/api' + p, { method: m, headers: { 'content-type': 'application/json', 'x-hailey': '1', 'x-carino': '1' }, body: b === undefined ? undefined : JSON.stringify(b) });
    const t = await r.text();
    try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, data: t }; }
  }, [method, path, body]);
  const settle = () => page.evaluate(() => globalThis.__flushEngine?.()).catch(() => {});
  const go = async (path) => { await settle(); await page.goto(URL_ + path); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(500); };
  const setAI = async (cfg) => { const r = await api('PUT', '/device/config', cfg); expect(r.status === 200, 'config saved ' + r.status); await settle(); };
  const newChat = async () => { await go('/chat/new'); await page.locator('textarea').last().waitFor(); };
  const send = async (text) => {
    await page.locator('textarea').last().fill(text);
    await page.getByRole('button', { name: 'Send' }).click();
  };
  const lastAssistant = () => page.locator('.msg.assistant').last();
  const visibleText = () => page.evaluate(() => document.querySelector('.chat-thread')?.innerText ?? document.body.innerText);

  // ---- Start-up -----------------------------------------------------------------------------
  await step('Cold start: first screen appears quickly', async () => {
    const t0 = Date.now();
    await page.goto(URL_ + '/');
    await page.getByLabel('What should I call you?').waitFor();
    const ms = Date.now() - t0;
    expect(ms < 6000, `took ${ms} ms`);
    return `setup screen in ${ms} ms`;
  });
  await api('PATCH', '/settings', { onboarded: true, profile: { displayName: 'Herbert', interests: ['food'] } });
  await setAI({ provider: 'custom', baseUrl: AI, model: 'qa-model' });

  // ---- Speed test ------------------------------------------------------------------------------
  await step('Speed test: times each model and picks the fastest (UI)', async () => {
    await go('/settings#ai');
    await page.getByRole('button', { name: 'Check my key' }).click();
    await page.getByText(/free model\(s\) available/).waitFor();
    await page.getByRole('button', { name: 'Test speed' }).click();
    await page.getByText('Fastest · chosen').waitFor({ timeout: 30000 });
    const rows = await page.locator('.speed-row').allInnerTexts();
    expect(rows[0].includes('qa-vision'), 'qa-vision (40 ms) should beat qa-model (250 ms): ' + rows.join(' | '));
    expect((await page.locator('#dai-model').inputValue()) === 'qa-vision', 'fastest model selected');
    await page.screenshot({ path: `${OUT}/speed-test.png`, fullPage: false });
    return rows.map((r) => r.replace(/\s+/g, ' ')).join(' | ');
  });
  await step('Speed test: Groq’s free models are timed through the real preset', async () => {
    groqMode = 'normal';
    const r = await api('POST', '/device/speedtest', { provider: 'groq', apiKey: 'gsk_test' });
    expect(r.data.results.length === 3 && r.data.results.every((x) => x.ok), JSON.stringify(r.data).slice(0, 200));
    return r.data.results.map((x) => `${x.model} ${x.totalMs} ms`).join(', ');
  });
  await step('Speed test: a rejected key is reported once, not per model', async () => {
    const r = await api('POST', '/device/speedtest', { provider: 'custom', baseUrl: AI, apiKey: 'bad-key' });
    expect(r.data.results.length === 1 && r.data.results[0].error === 'key not accepted', JSON.stringify(r.data));
    return 'stopped after the first model: "key not accepted"';
  });
  await setAI({ provider: 'custom', baseUrl: AI, model: 'qa-model' });

  // ---- AI failures ------------------------------------------------------------------------------
  await step('Bad key: chat explains the key was rejected and how to fix it', async () => {
    await setAI({ provider: 'custom', baseUrl: AI, model: 'qa-model', apiKey: 'bad-key' });
    await newChat();
    await send('Hello');
    await page.locator('.callout.danger, .msg.assistant .error, [role=alert]').first().waitFor({ timeout: 20000 });
    const t = await visibleText();
    expect(/key|401|rejected|invalid/i.test(t), 'message: ' + t.slice(-300));
    await page.screenshot({ path: `${OUT}/bad-key.png` });
    return t.split('\n').filter((l) => /key|401|rejected|invalid/i.test(l))[0]?.slice(0, 160);
  });
  await step('Rate limit on the best model: switches to the next free one by itself', async () => {
    await setAI({ provider: 'groq', apiKey: 'gsk_test', model: 'openai/gpt-oss-120b' });
    groqMode = 'first-limited';
    groqCalls.length = 0;
    await newChat();
    await send('Hello there');
    await lastAssistant().filter({ hasText: 'Reply to:' }).waitFor({ timeout: 25000 });
    const tried = [...new Set(groqCalls)];
    expect(tried[0] === 'openai/gpt-oss-120b' && tried.length >= 2, 'tried: ' + tried.join(', '));
    return 'tried ' + tried.join(' → ');
  });
  await step('Service down (503 on every model): clear message, app keeps working', async () => {
    groqMode = 'down';
    await newChat();
    await send('Are you there?');
    await page.locator('.callout.danger, [role=alert]').first().waitFor({ timeout: 30000 });
    const t = await visibleText();
    expect(/busy|down|try again/i.test(t), 'message: ' + t.slice(-300));
    const task = await api('POST', '/tasks', { title: 'Works while AI is down' });
    expect(task.status === 201, 'local features still work');
    return t.split('\n').filter((l) => /busy|down|try again/i.test(l))[0]?.slice(0, 200);
  });
  await step('No internet to the AI service: clear message', async () => {
    groqMode = 'offline';
    await newChat();
    await send('Hello?');
    await page.locator('.callout.danger, [role=alert]').first().waitFor({ timeout: 30000 });
    const t = await visibleText();
    expect(/reach|connect|internet|offline|network/i.test(t), 'message: ' + t.slice(-300));
    groqMode = 'normal';
    return t.split('\n').filter((l) => /reach|connect|internet|offline|network/i.test(l))[0]?.slice(0, 200);
  });
  await setAI({ provider: 'custom', baseUrl: AI, model: 'qa-model' });
  await step('Slow reply streams word by word, and Stop ends it', async () => {
    await newChat();
    await send('SLOW please');
    await page.getByRole('button', { name: 'Stop generating' }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(1500);
    const before = (await lastAssistant().innerText()).length;
    expect(before > 0, 'text is streaming');
    await page.getByRole('button', { name: 'Stop generating' }).click();
    await lastAssistant().filter({ hasText: 'You stopped this reply' }).waitFor({ timeout: 10000 });
    const after = (await lastAssistant().innerText()).length;
    await page.waitForTimeout(2000);
    const later = (await lastAssistant().innerText()).length;
    expect(later === after, `kept growing after Stop (${after} → ${later})`);
    expect(/arrives slowly/.test(await lastAssistant().innerText()), 'the words already shown were kept');
    await send('ECHO still working');
    await lastAssistant().filter({ hasText: 'still working' }).waitFor({ timeout: 15000 });
    return `streamed ${before} chars, Stop kept them (marked "You stopped this reply"), next message works`;
  });
  await step('Send pressed twice quickly: one message, one reply', async () => {
    await newChat();
    await page.locator('textarea').last().fill('ECHO once only');
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Send' || x.textContent === 'Send'); b.click(); b.click(); });
    await lastAssistant().filter({ hasText: 'once only' }).waitFor();
    await page.waitForTimeout(800);
    const users = await page.locator('.msg.user').count();
    expect(users === 1, `${users} copies sent`);
    return 'sent once';
  });

  // ---- Security -----------------------------------------------------------------------------
  await step('Hostile HTML in an AI reply is shown as text, never run', async () => {
    await newChat();
    await send('XSS test');
    await lastAssistant().filter({ hasText: 'done.' }).waitFor();
    await page.waitForTimeout(500);
    const bad = await page.evaluate(() => ({
      xss: window.__xss,
      scripts: document.querySelectorAll('.chat-thread script, .chat-thread iframe, .chat-thread img[onerror]').length,
      jsLinks: [...document.querySelectorAll('.chat-thread a')].filter((a) => /^\s*javascript:/i.test(a.getAttribute('href') || '')).length,
    }));
    const links = page.locator('.chat-thread a', { hasText: /tap me|link/ });
    for (let i = 0; i < await links.count(); i++) await links.nth(i).click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => window.__xss);
    expect(!bad.xss && !after && !bad.scripts && !bad.jsLinks, JSON.stringify({ ...bad, after }));
    return 'no script ran; <script>, <iframe>, onerror and javascript: links neutralised';
  });
  await step('Hostile HTML in a to-do title, memory and note is shown as text', async () => {
    const evil = '<img src=x onerror="window.__xss=9">Pay <b>rent</b>';
    await api('POST', '/tasks', { title: evil });
    await api('POST', '/memories', { content: evil });
    if (!CARINO) await api('POST', '/notes', { title: evil, body: '<script>window.__xss=10</script>' });
    for (const p of ['/tasks?view=all', '/memory', '/', ...(CARINO ? [] : ['/knowledge'])]) {
      await go(p);
      const x = await page.evaluate(() => window.__xss);
      expect(!x, `script ran on ${p}`);
    }
    return 'shown literally on To-dos, Memory, Home' + (CARINO ? '' : ', Notes');
  });

  // ---- Content -------------------------------------------------------------------------------
  await step('Long reply (60 lines, table, code) fits the phone width', async () => {
    await newChat();
    await send('LONG plan');
    await lastAssistant().locator('table').waitFor({ timeout: 20000 });
    await page.waitForTimeout(800);
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(o.sw <= o.cw + 1, `page scrolls sideways: ${o.sw} > ${o.cw}`);
    return 'table and code scroll inside their own box';
  });
  await step('Very long message (20,000 characters) sends and comes back', async () => {
    await newChat();
    const long = 'ECHO ' + 'word '.repeat(4000);
    const t0 = Date.now();
    await send(long);
    await lastAssistant().filter({ hasText: 'word word' }).waitFor({ timeout: 30000 });
    return `${Date.now() - t0} ms round trip`;
  });
  await step('Emoji, Arabic, Chinese and accents are saved, shown and searchable', async () => {
    const title = 'Kulika 🎉 مرحبا 你好 Ñandú';
    const r = await api('POST', '/tasks', { title });
    expect(r.status === 201, 'saved');
    await go('/tasks?view=all');
    await page.getByText(title).first().waitFor();
    const s = await api('GET', '/search?q=' + encodeURIComponent('مرحبا'));
    expect(s.data.results.some((x) => (x.title ?? '').includes('مرحبا')), 'search found it: ' + JSON.stringify(s.data).slice(0, 200));
    return 'round-trips exactly';
  });

  // ---- Load ----------------------------------------------------------------------------------
  let loadDetail = '';
  await step('Large data: 1,000 to-dos, 300 memories and 200 chats stay fast', async () => {
    const t0 = Date.now();
    await page.evaluate(async () => {
      const h = { 'content-type': 'application/json', 'x-hailey': '1', 'x-carino': '1' };
      const post = (p, b) => fetch('/api' + p, { method: 'POST', headers: h, body: JSON.stringify(b) });
      for (let i = 0; i < 1000; i++) await post('/tasks', { title: `Bulk task ${i}`, priority: (i % 3) + 1, due_at: new Date(Date.now() + (i % 40 - 10) * 864e5).toISOString() });
      for (let i = 0; i < 300; i++) await post('/memories', { content: `Bulk memory ${i}: Herbert likes item ${i}` });
      for (let i = 0; i < 200; i++) await post('/conversations', { title: `Bulk chat ${i}` });
    });
    const fill = Date.now() - t0;
    const t1 = Date.now(); await settle(); const flush = Date.now() - t1;
    const timeRoute = async (p, wait) => { const s = Date.now(); await page.goto(URL_ + p); await wait(); return Date.now() - s; };
    const tasksMs = await timeRoute('/tasks?view=all', () => page.getByText(/^Bulk task \d+$/).first().waitFor());
    const countShown = () => page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => /^Bulk task \d+$/.test(e.textContent ?? '') && e.children.length === 0).length);
    await page.getByText(/Showing 500 of 1,0\d\d (tasks|to-dos)/).waitFor();
    const m0 = Date.now();
    await page.getByRole('button', { name: 'Show more' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('*')].filter((e) => /^Bulk task \d+$/.test(e.textContent ?? '') && e.children.length === 0).length >= 1000, null, { timeout: 15000 });
    const moreMs = Date.now() - m0;
    const shown = await countShown();
    expect(shown >= 1000, `To-dos shows ${shown} of 1,000 after Show more`);
    const memMs = await timeRoute('/memory', () => page.getByText(/Bulk memory/).first().waitFor());
    // On phones the chat list sits behind the "Chats" button in the chat screen's header.
    const chatsMs = await timeRoute('/chat', async () => { await page.locator('.topbar').getByRole('button', { name: /Chats/ }).click(); await page.getByText(/Bulk chat/).filter({ visible: true }).first().waitFor(); });
    const homeMs = await timeRoute('/', () => page.getByText('Herbert').filter({ visible: true }).first().waitFor());
    const s0 = Date.now(); const s = await api('GET', '/search?q=item%20299'); const searchMs = Date.now() - s0;
    expect(s.data.results.length > 0, 'search works on large data');
    loadDetail = `created in ${(fill / 1000).toFixed(1)} s; save ${flush} ms; To-dos ${tasksMs} ms (first 500, Show more ${moreMs} ms), Memory ${memMs} ms, Chats ${chatsMs} ms, Home ${homeMs} ms (each including app reload); search ${searchMs} ms`;
    expect(tasksMs < 5000 && memMs < 5000 && homeMs < 5000 && searchMs < 1000, loadDetail);
    return loadDetail;
  });
  await step('Large data: kept after closing and reopening', async () => {
    await go('/');
    const t0 = Date.now();
    await page.reload();
    await page.getByText('Herbert').filter({ visible: true }).first().waitFor();
    const reopen = Date.now() - t0;
    const t = (await api('GET', '/tasks?view=all')).data.total;
    expect(t >= 1000, `${t} to-dos after reopen`);
    return `${t} to-dos back after reopen (${reopen} ms)`;
  });
  await step('Export all data includes everything (large data)', async () => {
    const r = await page.evaluate(async () => { const x = await fetch('/api/export', { headers: { 'x-hailey': '1', 'x-carino': '1' } }); return { status: x.status, size: (await x.text()).length }; });
    expect(r.status === 200 && r.size > 100_000, JSON.stringify(r));
    return `${(r.size / 1024).toFixed(0)} KB export`;
  });

  // ---- Every screen: widths, large text, accessibility, errors ------------------------------
  const ids = {};
  if (!CARINO) {
    ids.project = (await api('POST', '/projects', { name: 'QA project' })).data.id;
    ids.note = (await api('POST', '/notes', { title: 'QA note', body: 'Body' })).data.id;
  }
  ids.chat = (await api('GET', '/conversations')).data.conversations?.[0]?.id;
  const routes = ['/', '/chat', '/chat/new', `/chat/${ids.chat}`, '/tasks', '/memory', '/actions', '/notifications', '/settings', '/settings#ai', '/settings#privacy', '/routines', '/ramble', '/share', '/connectors', '/messaging', '/discover', '/stuff', '/me',
    ...(CARINO ? [] : ['/projects', `/projects/${ids.project}`, '/knowledge', `/knowledge/notes/${ids.note}`, '/research'])];
  const overflow = [];
  const errPages = [];
  await step(`Every screen (${routes.length}) at 320, 400, 768 and 1280 px wide: no sideways scrolling`, async () => {
    for (const w of [320, 400, 768, 1280]) {
      await page.setViewportSize({ width: w, height: 860 });
      for (const r of routes) {
        const before = errors.length;
        await go(r);
        const o = await page.evaluate(() => {
          const cw = document.documentElement.clientWidth;
          const wide = [...document.querySelectorAll('body *')].filter((el) => {
            const b = el.getBoundingClientRect();
            if (!b.width || getComputedStyle(el).position === 'fixed') return false;
            let p = el.parentElement;
            while (p) { const ox = getComputedStyle(p).overflowX; if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return false; p = p.parentElement; }
            return b.right > cw + 1;
          }).slice(0, 3).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
          return { sw: document.documentElement.scrollWidth, cw, wide };
        });
        if (o.sw > o.cw + 1) overflow.push(`${r} @${w}px (${o.sw}>${o.cw}: ${o.wide.join(', ')})`);
        if (errors.length > before) errPages.push(`${r} @${w}: ${errors.slice(before).join(' / ').slice(0, 200)}`);
      }
    }
    await page.setViewportSize({ width: 400, height: 860 });
    expect(!overflow.length, overflow.join('; '));
    return `${routes.length * 4} screen/width combinations checked`;
  });
  await step('Every screen with large text at 360 px: no sideways scrolling', async () => {
    await api('PATCH', '/settings', { appearance: { textSize: 'large' } });
    await page.setViewportSize({ width: 360, height: 800 });
    const bad = [];
    for (const r of routes) {
      await go(r);
      const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      if (o.sw > o.cw + 1) bad.push(`${r} (${o.sw}>${o.cw})`);
    }
    await api('PATCH', '/settings', { appearance: { textSize: 'normal' } });
    await page.setViewportSize({ width: 400, height: 860 });
    expect(!bad.length, bad.join('; '));
    return 'all screens fit';
  });
  await step('No script errors on any screen', async () => {
    expect(!errPages.length, errPages.slice(0, 5).join(' | '));
    return 'clean console on every screen and width';
  });
  const axeReport = {};
  await step('Accessibility (axe-core, WCAG 2.2 AA) on every screen, light and dark', async () => {
    const serious = [];
    for (const theme of ['light', 'dark']) {
      await api('PATCH', '/settings', { appearance: { theme } });
      for (const r of routes) {
        await go(r);
        await page.addScriptTag({ content: AXE });
        const v = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] })).violations
          .map((x) => ({ id: x.id, impact: x.impact, help: x.help, n: x.nodes.length, target: x.nodes.slice(0, 2).map((n) => n.target.join(' ')) })));
        for (const x of v) {
          const k = `${x.id}`;
          axeReport[k] ??= { help: x.help, impact: x.impact, pages: new Set(), targets: new Set() };
          axeReport[k].pages.add(`${r} (${theme})`);
          x.target.forEach((t) => axeReport[k].targets.add(t));
          if (x.impact === 'serious' || x.impact === 'critical') serious.push(`${x.id} on ${r} ${theme}: ${x.target[0]}`);
        }
      }
    }
    await api('PATCH', '/settings', { appearance: { theme: 'light' } });
    fs.writeFileSync(`${OUT}/axe.json`, JSON.stringify(Object.fromEntries(Object.entries(axeReport).map(([k, v]) => [k, { ...v, pages: [...v.pages], targets: [...v.targets].slice(0, 8) }])), null, 2));
    expect(!serious.length, `${serious.length} serious: ` + [...new Set(serious.map((s) => s.split(' on ')[0]))].join(', '));
    return Object.keys(axeReport).length ? `only minor: ${Object.keys(axeReport).join(', ')}` : 'no violations';
  });

  // ---- Offline, keyboard, navigation ---------------------------------------------------------
  await step('Phone offline: everything local keeps working; chat says the AI needs internet', async () => {
    // (In the APK the app itself is stored on the phone; here only outside traffic is cut.)
    await go('/');
    const cut = (route) => (/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(route.request().url()) && !route.request().url().includes(':9996') ? route.fallback() : route.abort('internetdisconnected'));
    await ctx.route('**/*', cut);
    try {
      const r = await api('POST', '/tasks', { title: 'Added offline' });
      expect(r.status === 201, 'to-do added offline');
      await page.evaluate(() => { history.pushState(null, '', '/chat/new'); dispatchEvent(new PopStateEvent('popstate')); });
      await page.getByText('How can I help?').waitFor();
      await page.locator('textarea').last().fill('Hello offline');
      await page.getByRole('button', { name: 'Send' }).click();
      await page.locator('.callout.danger, [role=alert]').first().waitFor({ timeout: 30000 });
      const t = await visibleText();
      expect(/reach|connect|internet|offline|network/i.test(t), 'message: ' + t.slice(-200));
      return 'to-dos saved offline; chat explained the AI service could not be reached';
    } finally {
      await ctx.unroute('**/*', cut);
    }
  });
  await step('Keyboard: Tab reaches the ask bar and shows a visible focus ring', async () => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await go('/');
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      await page.keyboard.press('Tab');
      found = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || !a.closest('.ask')) return false;
        const s = getComputedStyle(a);
        return s.outlineStyle !== 'none' || s.boxShadow !== 'none' || getComputedStyle(a.closest('.ask')).boxShadow !== 'none';
      });
    }
    await page.setViewportSize({ width: 400, height: 860 });
    expect(found, 'ask bar not reachable by Tab or no focus style');
    return 'reachable with a visible focus style';
  });
  await step('Back and forward move between pages (with page transitions on)', async () => {
    await go('/');
    await page.locator('.bottom-nav').getByText('Discover', { exact: true }).click();
    await page.waitForURL(/discover/);
    await page.locator('.bottom-nav').getByText('Me', { exact: true }).click();
    await page.waitForURL(/\/me/);
    await page.goBack(); await page.waitForURL(/discover/);
    await page.goBack(); await page.waitForURL((u) => new URL(u).pathname === '/');
    await page.goForward(); await page.waitForURL(/discover/);
    return 'history works';
  });
  await step('Erase everything after large data: quick and complete', async () => {
    const t0 = Date.now();
    await api('POST', '/device/reset', {});
    await page.goto(URL_ + '/');
    await page.getByLabel('What should I call you?').waitFor({ timeout: 20000 });
    const t = (await api('GET', '/tasks?view=all')).data.tasks?.length ?? 0;
    expect(t === 0, `${t} to-dos left`);
    return `erased and back at setup in ${Date.now() - t0} ms`;
  });

  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ app: NAME, at: new Date().toISOString(), results, findings, errors: errors.slice(0, 50) }, null, 2));
  console.log(`\n${NAME} extended: ${results.filter((r) => r.ok).length}/${results.length} passed`);
  if (findings.length) console.log('Findings: ' + findings.join(' | '));
  await browser.close();
})().catch((e) => { console.log('CRASH ' + e.stack); process.exit(1); });
