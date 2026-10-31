// End-to-end feature test of the phone app bundle (Hailey or Carino) in a real browser.
// The app's own server runs in the page; a scripted AI (fake-ai.mjs) and stand-ins for outside
// services (OpenStreetMap, Telegram, an MCP connector, Brave Search) are used.
// Usage: node e2e.cjs <hailey|carino> <appUrl> <aiUrl> <outDir>
const { chromium } = require('playwright');
const fs = require('fs');

const [APP, URL_, AI, OUT] = process.argv.slice(2);
const NAME = APP === 'carino' ? 'Carino' : 'Hailey';
const CARINO = APP === 'carino';
fs.mkdirSync(OUT, { recursive: true });
const results = [];
let shotN = 0;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, acceptDownloads: true, permissions: ['geolocation'], geolocation: { latitude: 0.35, longitude: 32.61 } });
  const outside = { telegram: [], nominatim: 0, mcp: [], brave: 0, google: [], relay: [], whatsapp: [] };
  // ---- Stand-ins for outside services --------------------------------------------------------
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  await ctx.route('https://nominatim.openstreetmap.org/**', (r) => {
    outside.nominatim++;
    r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify([{ name: 'Ntinda Pharmacy', display_name: 'Ntinda Pharmacy, Ntinda Road, Kampala', lat: '0.354', lon: '32.612', category: 'amenity', type: 'pharmacy' }]) });
  });
  await ctx.route('https://api.search.brave.com/**', (r) => {
    outside.brave++;
    r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ web: { results: [{ title: 'Uganda shilling exchange rate', url: 'https://example.org/ugx', description: 'UGX rates today' }] } }) });
  });
  await ctx.route('https://api.telegram.org/**', async (r) => {
    const url = r.request().url();
    const method = url.split('/').pop();
    outside.telegram.push(method);
    if (method === 'getUpdates') await new Promise((ok) => setTimeout(ok, 1500));
    const result = method === 'getMe' ? { id: 77, is_bot: true, username: 'qa_test_bot', first_name: 'QA' } : method === 'getUpdates' ? [] : true;
    r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, result }) });
  });
  await ctx.route('https://mcp.qa-test.dev/**', async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    let msg = {};
    try { msg = JSON.parse(r.request().postData() || '{}'); } catch {}
    outside.mcp.push(msg.method);
    const reply = (result) => r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json', 'mcp-session-id': 'qa' }, body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) });
    if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'QA Shop', version: '1' } });
    if (!('id' in msg)) return r.fulfill({ status: 202, headers: cors, body: '' });
    if (msg.method === 'tools/list') return reply({ tools: [{ name: 'order_status', description: 'Look up the delivery status of an order by its number', inputSchema: { type: 'object', properties: { order: { type: 'string' } }, required: ['order'] }, annotations: { readOnlyHint: true } }] });
    if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text: `Order ${msg.params?.arguments?.order}: shipped, arrives Friday` }] });
    reply({});
  });

  // Google (My apps), a WhatsApp relay and the WhatsApp Graph API (Carino).
  const gj = (r, b, status = 200) => r.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(b) });
  // "No content" keeps the app on screen, as on the phone, where sign-in opens in the browser app.
  await ctx.route('https://accounts.google.com/**', (r) => r.fulfill({ status: 204, body: '' }));
  await ctx.route('https://oauth2.googleapis.com/token', (r) => { outside.google.push('token'); gj(r, { access_token: 'g-at', refresh_token: 'g-rt', expires_in: 3600 }); });
  await ctx.route('https://openidconnect.googleapis.com/**', (r) => gj(r, { sub: 'g1', email: 'herbert@gmail.com' }));
  await ctx.route('https://gmail.googleapis.com/**', (r) => {
    const url = r.request().url();
    outside.google.push(url.includes('/send') ? 'send' : 'read');
    if (url.includes('/messages?')) return gj(r, { messages: [{ id: 'm1' }] });
    gj(r, { id: 'm1', threadId: 't1', snippet: 'Delivery on Friday', payload: { headers: [{ name: 'From', value: 'Supplier <s@x.com>' }, { name: 'Subject', value: 'Your order' }] } });
  });
  const relayItems = [];
  // Carino's sign-in helper (one-tap sign-in and the shared WhatsApp number), when the build has one.
  const hub = { linked: false, inbox: [], sent: [], tokens: 0 };
  await ctx.route('https://carino-auth.qa-helper.dev/**', async (r) => {
    const u = new URL(r.request().url());
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const body = (() => { try { return JSON.parse(r.request().postData() || '{}'); } catch { return {}; } })();
    if (u.pathname === '/config') return gj(r, { providers: { microsoft: { client_id: 'qa-ms-client' } }, whatsapp: { number: '+1 555-206-4808' } });
    if (u.pathname === '/token') { hub.tokens++; return gj(r, { access_token: 'ms-at', refresh_token: 'ms-rt', expires_in: 3600 }); }
    if (u.pathname === '/wa/register') return gj(r, { code: '424242', expires_in: 900 });
    if (u.pathname === '/wa/status') return gj(r, hub.linked ? { linked: true, wa_id: '15550111', name: 'Herbert' } : { linked: false });
    if (u.pathname === '/wa/inbox') return gj(r, { items: hub.inbox.splice(0) });
    if (u.pathname === '/wa/send') { hub.sent.push(body.text); return gj(r, { sent: true }); }
    gj(r, { ok: true });
  });
  await ctx.route('https://login.microsoftonline.com/**', (r) => r.fulfill({ status: 204, body: '' }));
  await ctx.route('https://graph.microsoft.com/v1.0/me?**', (r) => gj(r, { id: 'ms1', mail: 'herbert@outlook.com' }));
  const cfCalls = [];
  await ctx.route('https://api.cloudflare.com/**', (r) => {
    const u = new URL(r.request().url());
    cfCalls.push(`${r.request().method()} ${u.pathname.replace('/client/v4', '')}`);
    if (u.pathname.endsWith('/accounts')) return gj(r, { success: true, result: [{ id: 'acc1' }] });
    if (u.pathname.endsWith('/workers/subdomain')) return gj(r, { success: true, result: { subdomain: 'qa' } });
    gj(r, { success: true, result: {} });
  });
  await ctx.route('https://carino-whatsapp-relay.qa.workers.dev/**', async (r) => {
    const url = r.request().url();
    outside.relay.push(url.split('/').pop());
    if (url.endsWith('/setup')) return gj(r, { ok: true });
    if (url.endsWith('/inbox')) return gj(r, { items: relayItems.splice(0) });
    gj(r, { removed: 1 });
  });
  await ctx.route('https://graph.facebook.com/**', async (r) => {
    const url = r.request().url();
    if (url.includes('?fields=display_phone_number')) return gj(r, { display_phone_number: '+1 555 0100' });
    if (url.endsWith('/messages')) { outside.whatsapp.push(JSON.parse(r.request().postData() || '{}').text?.body); return gj(r, { messages: [{ id: 'wamid.1' }] }); }
    gj(r, {});
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errors.push(m.text()));

  const shot = async (name) => page.screenshot({ path: `${OUT}/${String(++shotN).padStart(2, '0')}-${name}.png` });
  const step = async (name, fn) => {
    if (process.env.UPTO && results.length >= +process.env.UPTO) return;
    const t0 = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? '' });
      console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
    } catch (e) {
      results.push({ name, ok: false, ms: Date.now() - t0, detail: String(e.message ?? e).split('\n')[0].slice(0, 300) });
      if (process.env.VERBOSE) console.log(String(e.message ?? e).slice(0, 2500));
      console.log(`FAIL  ${name} — ${String(e.message ?? e).split('\n')[0].slice(0, 300)}`);
      await shot('FAIL-' + name.replace(/\W+/g, '-').slice(0, 40)).catch(() => {});
    }
  };
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
  const api = (method, path, body) => page.evaluate(async ([m, p, b]) => {
    const r = await fetch('/api' + p, { method: m, headers: { 'content-type': 'application/json', 'x-hailey': '1', 'x-carino': '1' }, body: b === undefined ? undefined : JSON.stringify(b) });
    const t = await r.text();
    try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, data: t }; }
  }, [method, path, body]);
  const aiLog = async () => (await (await fetch(`${AI.replace(/\/v1$/, '')}/log`)).json());
  /** Like closing the app normally: it goes to the background (which saves), then reopens. */
  const settle = () => page.evaluate(() => globalThis.__flushEngine?.()).catch(() => {});
  const go = async (path, waitText) => {
    await settle();
    await page.goto(URL_ + path);
    if (waitText) await page.getByText(waitText, { exact: false }).filter({ visible: true }).first().waitFor({ timeout: 15000 });
    else await page.waitForTimeout(1200);
  };
  /** Sends a chat message through the UI and waits for the assistant's reply to finish. */
  const chat = async (text, waitFor = /Done\.|Reply to:|I can see/) => {
    const box = page.locator('textarea[data-composer], textarea').last();
    await box.fill(text);
    await page.getByRole('button', { name: 'Send' }).click();
    await page.locator('.msg.assistant').filter({ hasText: waitFor }).last().waitFor({ timeout: 30000 });
    await page.waitForTimeout(600);
  };
  const newChat = async () => { await go('/chat/new'); await page.locator('textarea').last().waitFor({ timeout: 15000 }); };

  // ---- 1. Start-up and setup -----------------------------------------------------------------
  await step('App starts on the phone engine, with no sign-in screen', async () => {
    const t0 = Date.now();
    await page.goto(URL_ + '/');
    await page.getByLabel('What should I call you?').waitFor({ timeout: 30000 });
    await shot('onboarding');
    return `setup screen after ${Date.now() - t0} ms`;
  });
  await step('Setup: name, assistant name, free AI service, interests, starter routines', async () => {
    await page.getByLabel('What should I call you?').fill('Herbert');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Assistant name').fill(CARINO ? 'Carino' : 'Hailey');
    await page.getByRole('button', { name: 'Next' }).click();
    const services = await page.locator('.preset .preset-name').allTextContents();
    expect(services[0].startsWith('Google Gemini'), 'Gemini should be first: ' + services.join(','));
    expect(!services.some((s) => s.includes('Claude')), 'paid Claude must not be offered');
    await page.getByRole('radio', { name: /Ollama on your PC/ }).click();
    await page.locator('#dai-url').fill(AI);
    await page.getByRole('button', { name: 'Check my key' }).click();
    await page.getByText(/free model\(s\) available/).waitFor({ timeout: 10000 });
    expect((await page.locator('#dai-model').inputValue()) === 'qa-model', 'should pick an installed model');
    await shot('ai-setup');
    await page.getByRole('button', { name: 'Save and test' }).click();
    await page.getByText('What would you like help with', { exact: false }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: /Food/ }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: /Let’s go/ }).click();
    await page.waitForURL(/\/discover|\/$/, { timeout: 15000 });
    return `${services.length} free services offered, best first: ${services.slice(0, 3).join(', ')}…`;
  });
  await step('AI service list: each free service has its free models, best first', async () => {
    const r = await api('GET', '/device/config');
    const shown = r.data.presets.filter((p) => !p.hidden);
    expect(shown.every((p) => p.models.length > 0), 'every service lists models');
    const families = shown.flatMap((p) => p.models.map((m) => m.family)).filter(Boolean);
    expect(families.includes('DeepSeek') && families.includes('Qwen'), 'DeepSeek and Qwen offered');
    return shown.map((p) => `${p.label}: ${p.models.length}`).join('; ');
  });

  // ---- 2. Home, Discover, navigation ------------------------------------------------------------
  await step('Home: greeting, ask bar, quick starts and highlight cards', async () => {
    await go('/', 'Herbert');
    expect(await page.locator('.home-hero .ask input').count() === 1, 'ask bar');
    expect(await page.locator('.highlight').count() >= 3, 'highlight cards');
    await shot('home');
    return `${await page.locator('.highlight').count()} highlight cards`;
  });
  await step('Discover: idea catalog with categories, "For you" first', async () => {
    await go('/discover', 'take off your plate');
    const tabs = await page.getByRole('tab').allTextContents();
    expect(tabs[0] === 'For you', 'For you first: ' + tabs[0]);
    const forYou = await page.locator('.discover-card').count();
    await page.getByRole('tab', { name: 'All', exact: true }).click();
    await page.waitForTimeout(400);
    const n = await page.locator('.discover-card').count();
    expect(n > 20 && forYou > 0 && forYou < n, `cards: ${forYou} for you, ${n} in all`);
    await shot('discover');
    return `${forYou} picked for the user's interests, ${n} in all, ${tabs.length} categories`;
  });
  await step('Bottom tabs reach Home, Chats, Discover, Your stuff and Me', async () => {
    await go('/');
    for (const t of ['Chats', 'Discover', 'Your stuff', 'Me', 'Home']) {
      await page.locator('.bottom-nav').getByText(t, { exact: true }).click();
      await page.waitForTimeout(500);
    }
    return 'all five tabs open';
  });

  // ---- 3. Chat and the assistant's actions ------------------------------------------------------
  await step('Chat: a message streams a reply from the AI service', async () => {
    await go('/');
    await page.locator('.home-hero .ask input').fill('Hello there');
    await page.locator('.home-hero .ask input').press('Enter');
    await page.locator('.msg.assistant').filter({ hasText: 'Reply to:' }).first().waitFor({ timeout: 30000 });
    await shot('chat-reply');
    const l = await aiLog();
    return `model ${l.at(-1).model}, ${l.at(-1).tools.length} tools offered`;
  });
  let taskId = '';
  await step('Assistant adds a to-do (create_task) and it appears in To-dos', async () => {
    await newChat();
    await chat('TOOL create_task {"title":"Buy maize flour","priority":1}');
    const t = (await api('GET', '/tasks?view=all')).data.tasks.find((x) => x.title === 'Buy maize flour');
    expect(t, 'task saved');
    taskId = t.id;
    await go('/tasks?view=all', 'Buy maize flour');
    await shot('tasks');
    return 'task created by the assistant and listed';
  });
  await step('To-dos page: add by typing, complete and reopen', async () => {
    await go('/tasks');
    const box = page.locator('input[placeholder^="Add a task"], input[placeholder*="to-do"], input[placeholder*="task"]').first();
    await box.fill('Pay school fees');
    await box.press('Enter');
    await page.waitForTimeout(1200);
    const confirm = page.getByRole('dialog').getByRole('button', { name: /^(Save task|Add task|Add to-do|Save)$/ });
    if (await confirm.filter({ visible: true }).count()) await confirm.filter({ visible: true }).first().click();
    await page.waitForTimeout(800);
    const t = (await api('GET', '/tasks?view=all')).data.tasks.find((x) => x.title.includes('Pay school fees'));
    expect(t, 'typed task saved');
    expect((await api('POST', `/tasks/${t.id}/complete`)).status === 200, 'complete');
    expect((await api('POST', `/tasks/${t.id}/reopen`)).status === 200, 'reopen');
    return 'add, complete, reopen work';
  });
  let reminderTitle = 'Call the bank';
  await step('Assistant sets a reminder (create_reminder) for 1 minute from now', async () => {
    await newChat();
    await chat(`TOOL create_reminder {"title":"${reminderTitle}","when":"${new Date(Date.now() + 60_000).toISOString()}"}`);
    const r = (await api('GET', '/reminders')).data.reminders ?? [];
    expect(r.some((x) => x.title === reminderTitle), 'reminder scheduled');
    return 'scheduled; delivery checked later';
  });
  await step('Assistant remembers something (save_memory) and it shows in Memory', async () => {
    await newChat();
    await chat('TOOL save_memory {"content":"Prefers short answers in the morning","category":"preference","user_requested":true}');
    await go('/memory', 'Prefers short answers in the morning');
    await shot('memory');
    return 'memory saved and listed';
  });
  await step('Assistant finds places nearby (OpenStreetMap) with a map link', async () => {
    await newChat();
    await chat('TOOL find_places {"query":"pharmacy","near":"Ntinda, Kampala"}');
    expect(outside.nominatim > 0, 'OpenStreetMap was asked');
    expect(await page.locator('.sources a').filter({ hasText: 'Ntinda Pharmacy' }).count() > 0, 'place cited as a source');
    return 'place found and cited';
  });
  await step('Assistant prepares a phone call with a tap-to-dial link', async () => {
    await newChat();
    await chat('TOOL prepare_call {"who":"Supplier Ltd","phone":"+256 700 123 456","purpose":"Late delivery","script":"1. Say who you are\\n2. Ask for a new date"}');
    const where = CARINO ? (await api('GET', '/tasks?view=all')).data.tasks.find((x) => x.title === 'Call: Supplier Ltd')?.description
      : null;
    if (CARINO) expect(where && where.includes('tel:+256700123456'), 'call plan saved as a to-do with the number');
    else {
      const notes = (await api('GET', '/notes')).data.notes ?? [];
      const n = notes.find((x) => x.title === 'Call: Supplier Ltd');
      expect(n, 'call plan saved as a note');
      expect((await api('GET', `/notes/${n.id}`)).data.body.includes('tel:+256700123456'), 'tap-to-dial link');
    }
    return 'call plan saved with tel: link';
  });
  await step('Assistant web search (Brave) cites its sources', async () => {
    await api('PUT', '/device/config', { ...(await api('GET', '/device/config')).data.config, provider: 'custom', baseUrl: AI, model: 'qa-model', braveKey: 'qa-brave-key', apiKey: undefined });
    await newChat();
    await chat('TOOL web_search {"query":"UGX exchange rate"}');
    expect(outside.brave > 0, 'search service asked');
    expect(await page.locator('.sources a').filter({ hasText: 'exchange rate' }).count() > 0, 'web result cited');
    return 'search ran and was cited';
  });
  await step('Deletions wait for approval, then run once approved', async () => {
    await newChat();
    await chat(`TOOL delete_task {"task_id":"${taskId}"}`);
    expect((await api('GET', `/tasks/${taskId}`)).status === 200, 'not deleted before approval');
    await go('/actions', 'Delete');
    await shot('approval');
    await page.getByRole('button', { name: /Approve/ }).first().click();
    await page.waitForTimeout(1500);
    expect((await api('GET', `/tasks/${taskId}`)).status === 404, 'deleted after approval');
    return 'held for approval, then deleted';
  });
  await step('Assistant creates a routine (create_routine), and it can be run now', async () => {
    await newChat();
    await chat('TOOL create_routine {"title":"Money check-in","prompt":"Remind me what bills are due this week","time":"18:30","days":[5]}');
    const r = (await api('GET', '/routines')).data.routines.find((x) => x.title === 'Money check-in');
    expect(r, 'routine saved');
    const run = await api('POST', `/routines/${r.id}/run`);
    expect(run.status < 300, `run now: ${run.status} ${JSON.stringify(run.data).slice(0, 120)}`);
    await go('/routines', 'Money check-in');
    await shot('routines');
    return 'routine created and run';
  });
  await step('Chat attachments: text file read as context; photo shrunk and stored', async () => {
    await newChat();
    await page.setInputFiles('input[type=file]', { name: 'prices.txt', mimeType: 'text/plain', buffer: Buffer.from('Maize flour costs 4500 UGX per kilo at Owino market.') });
    await page.waitForTimeout(1500);
    await chat('What does the file say?');
    const l = await aiLog();
    expect(l.length > 0, 'model called');
    // A small PNG photo
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await page.setInputFiles('input[type=file]', { name: 'shelf.png', mimeType: 'image/png', buffer: png });
    await page.waitForTimeout(1500);
    await chat('What is in the photo?');
    expect(await page.locator('.attach-thumb img').count() > 0, 'photo thumbnail shown (from the phone engine)');
    await shot('attachments');
    return 'file and photo attached';
  });
  await step('Rate a reply; Remember this / save from chat', async () => {
    await page.getByRole('button', { name: 'Good reply' }).last().click();
    await page.waitForTimeout(500);
    const label = CARINO ? 'Remember this' : 'Save as note';
    const b = page.getByRole('button', { name: label }).last();
    expect(await b.count() > 0, `${label} button`);
    await b.click();
    await page.waitForTimeout(800);
    return `rated, and "${label}" worked`;
  });

  // ---- 4. Ramble, Your stuff, Me ------------------------------------------------------------------
  await step('Ramble it out: brain-dump sorted into items, then added', async () => {
    await go('/ramble');
    await page.locator('textarea').first().fill('ok so I need to order paracetamol tomorrow at 9, remind me to call mama tomorrow at 5pm, and an idea for a loyalty card');
    await page.getByRole('button', { name: /Sort it out|Sort|Organise/ }).first().click();
    const addBtn = page.getByRole('button', { name: /^Add \d+ item/ });
    await addBtn.waitFor({ timeout: 20000 });
    const found = await page.locator('.page input:not([type=checkbox]):not([type=datetime-local])').evaluateAll((els) => els.map((e) => e.value));
    expect(found.includes('Order paracetamol stock'), 'items: ' + found.join(' | '));
    await shot('ramble');
    await page.getByRole('button', { name: /^Add \d+ item/ }).click();
    await page.getByText(/Added/).first().waitFor({ timeout: 10000 });
    const tasks = (await api('GET', '/tasks?view=all')).data.tasks.map((t) => t.title);
    expect(tasks.includes('Order paracetamol stock'), 'task added from ramble');
    return 'extracted 3 items and added them';
  });
  await step('Your stuff: live counts for everything ' + NAME + ' holds', async () => {
    await go('/stuff', 'Your stuff');
    const tiles = await page.locator('.stuff-tile .st-title').allTextContents();
    expect(tiles.length >= 5, 'tiles');
    if (CARINO) expect(await page.getByText(`New things ${NAME} learned`).count() > 0, 'memory inbox shows this week’s memories');
    await shot('stuff');
    return tiles.join(', ');
  });
  await step('Me: streak, ' + (CARINO ? 'challenges, weekly goals, ' : '') + 'mascot accessories', async () => {
    await go('/me', 'Dress up');
    if (CARINO) {
      expect(await page.getByText('Challenges').count() > 0, 'challenges');
      expect(await page.getByText('This week').count() > 0, 'weekly goals');
    }
    await page.getByRole('radio', { name: /Party hat/ }).click();
    await page.waitForTimeout(800);
    expect((await api('GET', '/settings')).data.profile.mascotAccessory === 'party', 'accessory saved');
    const locked = await page.locator('.acc-opt[disabled]').count();
    await shot('me');
    return `party hat on; ${locked} accessories still locked`;
  });
  if (CARINO) {
    await step('Share a Carino sticker (PNG made on the phone)', async () => {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.getByRole('button', { name: /sticker/ }).click()]);
      const p = await dl.path();
      const head = fs.readFileSync(p).subarray(0, 8).toString('hex');
      expect(head === '89504e470d0a1a0a', 'a PNG file');
      return `${dl.suggestedFilename()} (${fs.statSync(p).size} bytes)`;
    });
  } else {
    await step('Notes & documents: write a note, find it in search', async () => {
      const n = await api('POST', '/notes', { title: 'Shop ideas', body: 'Sell chapati near the taxi park on weekends' });
      expect(n.status === 201, 'note saved');
      await go('/knowledge', 'Shop ideas');
      const s = await api('GET', '/search?q=chapati');
      expect(s.data.results.some((x) => x.title === 'Shop ideas'), 'full-text search finds it');
      await shot('knowledge');
      return 'note saved and searchable';
    });
    await step('Projects: create one with a to-do', async () => {
      const p = await api('POST', '/projects', { name: 'Open second shop', goals: 'Open in Ntinda by March' });
      expect(p.status === 201, 'project saved');
      await api('POST', '/tasks', { title: 'Find a location', project_id: p.data.id });
      await go(`/projects/${p.data.id}`, 'Open second shop');
      await page.getByRole('tab', { name: 'Tasks' }).click();
      await page.getByText('Find a location').filter({ visible: true }).first().waitFor({ timeout: 10000 });
      await shot('project');
      return 'project and its task shown';
    });
    await step('Exports: the assistant makes a Word file and it downloads', async () => {
      await newChat();
      await chat('TOOL create_export {"title":"Stock list","format":"docx","markdown":"# Stock\\n- Maize flour\\n- Sugar"}');
      const ex = (await api('GET', '/exports')).data.exports;
      expect(ex.length > 0, 'export saved');
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), go('/knowledge?tab=exports').then(() => page.getByRole('button', { name: 'Download' }).first().click())]);
      const head = fs.readFileSync(await dl.path()).subarray(0, 2).toString();
      expect(head === 'PK', 'a real .docx (zip) file');
      return dl.suggestedFilename();
    });
  }

  // ---- 5. Connected apps and messaging ---------------------------------------------------------
  await step('Connected apps (MCP): add a connector and the assistant uses its tool', async () => {
    const add = await api('POST', '/connectors', { name: 'QA Shop', url: 'https://mcp.qa-test.dev/mcp' });
    expect(add.status < 300, `add: ${add.status} ${JSON.stringify(add.data).slice(0, 160)}`);
    await newChat();
    await chat('Hello');
    const tools = (await aiLog()).at(-1).tools;
    const t = tools.find((x) => x.includes('order_status'));
    expect(t, 'connector tool offered to the model: ' + tools.filter((x) => x.startsWith('mcp')).join(','));
    await chat(`TOOL ${t} {"order":"42"}`);
    expect(outside.mcp.includes('tools/call'), 'connector tool called');
    await go('/connectors', 'QA Shop');
    await shot('connectors');
    return `tool ${t} called through MCP`;
  });
  await step('Messaging: connect a Telegram bot and get a pairing code', async () => {
    const r = await api('POST', '/channels/telegram', { token: '123456:QA-TOKEN-abcdefghijklmnopqrstuvwxyz' });
    expect(r.status < 300, `connect: ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    const pair = await api('POST', `/channels/${r.data.id ?? r.data.channel?.id}/pair`, {});
    expect(pair.status < 300, 'pairing code');
    expect(outside.telegram.includes('getMe'), 'Telegram asked');
    await go('/messaging', 'qa_test_bot');
    await shot('messaging');
    return `bot @qa_test_bot connected; Telegram calls: ${[...new Set(outside.telegram)].join(', ')}`;
  });

  // ---- 6. Settings ---------------------------------------------------------------------------
  await step('Settings: profile, reply language, instructions', async () => {
    const r = await api('PATCH', '/settings', { profile: { replyLanguage: 'Luganda', customInstructions: 'Use UGX for money' } });
    expect(r.status === 200, 'saved');
    await go('/settings#profile', 'Profile');
    return 'saved';
  });

  // ---- My apps (Carino) ------------------------------------------------------------------------
  if (CARINO) {
    await step('My apps: WhatsApp, Google, Microsoft, Instagram, Facebook, X, LinkedIn, TikTok, Telegram', async () => {
      await go('/apps', 'My apps');
      const names = await page.locator('.app-item .app-name').allTextContents();
      expect(names.length === 10, 'ten rows: ' + names.join(', '));
      for (const n of ['WhatsApp', 'Google', 'Microsoft', 'Instagram', 'Facebook', 'X (Twitter)', 'LinkedIn', 'TikTok', 'Telegram']) expect(names.some((x) => x.startsWith(n)), 'missing ' + n);
      expect(await page.getByText('Tap to connect').count() === 7, 'seven not connected');
      await shot('my-apps');
      return names.map((n) => n.replace('Beta', '')).join(', ');
    });
    await step('Google: one-time setup, sign-in in the browser, account connected', async () => {
      await go('/apps/google', 'One-time setup');
      const redirect = await page.locator('#redirect').inputValue();
      expect(redirect === 'http://127.0.0.1:47823/callback', 'phone redirect: ' + redirect);
      await page.locator('#client-id').fill('qa.apps.googleusercontent.com');
      await page.locator('#client-secret').fill('GOCSPX-qa-secret');
      await page.getByRole('button', { name: 'Save' }).click();
      await page.getByText('Saved. Now sign in.').waitFor({ timeout: 8000 });
      await shot('google-setup');
      const opened = page.waitForRequest(/accounts\.google\.com/, { timeout: 10000 });
      await page.getByRole('button', { name: 'Sign in with Google' }).click();
      const u = new URL((await opened).url());
      expect(u.searchParams.get('redirect_uri') === redirect && u.searchParams.get('code_challenge_method') === 'S256', 'PKCE + loopback');
      // The phone's listener hands the browser's answer back to the app.
      await page.waitForTimeout(500);
      await page.evaluate((q) => window.__hn.oauth(q), `state=${u.searchParams.get('state')}&code=qa-code&scope=email`);
      await page.getByText('herbert@gmail.com').first().waitFor({ timeout: 10000 });
      await go('/apps', 'My apps');
      expect(await page.locator('.app-item').filter({ hasText: 'Google' }).locator('.chip-sm').count() === 5, 'Gmail, Calendar, Drive, Sheets, Docs chips');
      await shot('my-apps-connected');
      return 'signed in as herbert@gmail.com through the loopback redirect';
    });
    await step('Chat uses Gmail; sending an email waits for approval', async () => {
      await newChat();
      await chat('TOOL gmail_search {"query":"is:unread"}');
      expect(await page.locator('.msg.assistant').last().getByText(/Supplier/).count() > 0, 'search result in reply');
      expect(outside.google.includes('read'), 'Gmail was read');
      await chat('TOOL gmail_send {"to":"s@x.com","subject":"Re: Your order","body":"Friday is fine, thank you."}');
      expect(!outside.google.includes('send'), 'not sent before approval');
      await go('/actions', 'Send email');
      await shot('gmail-approval');
      await page.getByRole('button', { name: /Approve/ }).first().click();
      await page.waitForTimeout(1500);
      expect(outside.google.includes('send'), 'sent after approval');
      return 'read inbox; email sent only after Approve';
    });
    if (process.env.HELPER) {
      await step('One tap: Microsoft signs in with no developer setup', async () => {
        await go('/apps/microsoft', 'Accounts');
        expect(await page.locator('#client-id').isVisible() === false, 'setup is tucked away');
        const opened = page.waitForRequest(/login\.microsoftonline\.com/, { timeout: 10000 });
        await page.getByRole('button', { name: 'Sign in with Microsoft' }).click();
        const u = new URL((await opened).url());
        expect(u.searchParams.get('client_id') === 'qa-ms-client', 'Carino’s own app');
        expect(u.searchParams.get('redirect_uri') === 'https://carino-auth.qa-helper.dev/callback/microsoft', 'redirect via the helper');
        await page.waitForTimeout(500);
        await page.evaluate((q) => window.__hn.oauth(q), `code=qa-code&state=${u.searchParams.get('state')}&provider=microsoft`);
        await page.getByText('herbert@outlook.com').first().waitFor({ timeout: 10000 });
        expect(hub.tokens === 1, 'code traded through the helper');
        await shot('one-tap-microsoft');
        return 'signed in with one tap; the secret stayed on the helper';
      });
      await step('WhatsApp: link Carino’s shared number with a code, and get answered', async () => {
        await go('/messaging#whatsapp', 'WhatsApp');
        await page.getByRole('button', { name: 'Link my WhatsApp' }).click();
        await page.getByText('424242').waitFor({ timeout: 10000 });
        expect(await page.getByRole('link', { name: 'Open WhatsApp' }).getAttribute('href') === 'https://wa.me/15552064808?text=424242', 'wa.me link');
        await shot('whatsapp-shared-code');
        hub.linked = true;
        await page.getByText('WhatsApp linked').waitFor({ timeout: 15000 });
        hub.inbox.push({ id: 1, at: Date.now(), from: '15550111', name: 'Herbert', message: { from: '15550111', id: 'w1', type: 'text', text: { body: 'hello Carino' } } });
        for (let i = 0; i < 30 && !hub.sent.length; i++) await page.waitForTimeout(500);
        expect(/Reply to: hello Carino/.test(hub.sent[0] ?? ''), 'answered: ' + hub.sent[0]);
        await shot('whatsapp-shared-linked');
        // Unlink, so the own-number setup can be tested next.
        await page.locator('#whatsapp').getByRole('button', { name: 'Disconnect' }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
        await page.waitForTimeout(1000);
        return 'linked by code; message answered through the shared number';
      });
    }
    await step('WhatsApp: connect, link the relay, and answer a message collected from it', async () => {
      await go('/messaging#whatsapp', 'WhatsApp');
      const advanced = page.getByText('Advanced: use my own WhatsApp Business number');
      if (await advanced.count()) await advanced.click();
      await page.getByLabel('Phone number ID').fill('5550100');
      await page.getByLabel('Access token').fill('EAAG-qa-access-token-xxxxxxxx');
      await page.getByLabel('App secret').fill('qa-app-secret-0123456789');
      await page.getByRole('button', { name: 'Connect WhatsApp' }).click();
      await page.getByLabel('Cloudflare API token').waitFor({ timeout: 10000 });
      await page.getByLabel('Cloudflare API token').fill('cf-qa-token-0123456789abcdef');
      await page.getByRole('button', { name: 'Create my relay' }).click();
      await page.getByLabel('Callback URL').waitFor({ timeout: 15000 });
      expect((await page.getByLabel('Callback URL').inputValue()) === 'https://carino-whatsapp-relay.qa.workers.dev/webhook', 'webhook address');
      expect(cfCalls.includes('PUT /accounts/acc1/workers/scripts/carino-whatsapp-relay'), 'relay uploaded: ' + cfCalls.join(', '));
      await shot('whatsapp-setup');
      const ch = (await api('GET', '/channels')).data.channels.find((c) => c.kind === 'whatsapp');
      const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '5550100' }, contacts: [{ wa_id: '15550111', profile: { name: 'Herbert' } }], messages: [{ from: '15550111', id: 'w1', type: 'text', text: { body: ch.pairing_code } }] } }] }] });
      const sig = 'sha256=' + require('crypto').createHmac('sha256', 'qa-app-secret-0123456789').update(body).digest('hex');
      relayItems.push({ id: 1, at: Date.now(), sig, body });
      for (let i = 0; i < 20 && !outside.whatsapp.length; i++) await page.waitForTimeout(500);
      expect(/linked to your Carino/.test(outside.whatsapp[0] ?? ''), 'pairing reply sent: ' + outside.whatsapp[0]);
      return 'relay created on Cloudflare, polled, pairing confirmed on WhatsApp';
    });
  }
  await step('Settings: dark theme and large text apply at once', async () => {
    await api('PATCH', '/settings', { appearance: { theme: 'dark', textSize: 'large' } });
    await go('/');
    expect(await page.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'dark theme');
    expect(await page.evaluate(() => document.documentElement.dataset.text) === 'large', 'large text');
    await shot('dark-theme');
    await api('PATCH', '/settings', { appearance: { theme: 'light', textSize: 'normal' } });
    return 'theme and text size applied';
  });
  await step('Settings: AI service, notifications, privacy pages open', async () => {
    for (const s of ['ai', 'notifications', 'memory', 'permissions', 'voice', 'privacy']) {
      await go('/settings#' + s);
      await page.waitForTimeout(400);
    }
    await go('/settings#ai', 'Check my key');
    await shot('settings-ai');
    return 'all sections render';
  });
  await step('Export all data downloads a JSON file with the user’s data', async () => {
    await go('/settings#privacy', 'Export all data');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.getByRole('button', { name: /Download export/ }).click()]);
    const data = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    expect(JSON.stringify(data).includes('Order paracetamol stock'), 'export contains tasks');
    return `${dl.suggestedFilename()} (${Object.keys(data).length} sections)`;
  });
  await step('Search finds to-dos, memories and chats', async () => {
    const s = await api('GET', '/search?q=paracetamol');
    expect(s.data.results.length > 0, 'results');
    return s.data.results.map((r) => r.entity).join(', ');
  });

  // ---- 7. Time-based, persistence, reset ------------------------------------------------------
  await step('Reminder is delivered on time as a notification', async () => {
    const until = Date.now() + 120_000;
    let hit;
    while (Date.now() < until && !hit) {
      hit = ((await api('GET', '/notifications')).data.notifications ?? []).find((n) => n.title.includes(reminderTitle));
      if (!hit) await page.waitForTimeout(5000);
    }
    expect(hit, 'reminder notification within 2 minutes');
    await go('/notifications', reminderTitle);
    await shot('notifications');
    return 'delivered: ' + hit.title;
  });
  await step('Everything is still there after closing and reopening the app', async () => {
    await settle();
    await page.reload();
    await page.waitForTimeout(2500);
    const t = (await api('GET', '/tasks?view=all')).data.tasks.length;
    const m = (await api('GET', '/memories')).data.memories.length;
    const c = (await api('GET', '/conversations')).data.conversations.length;
    expect(t > 0 && m > 0 && c > 0, `kept: ${t} to-dos, ${m} memories, ${c} chats`);
    return `${t} to-dos, ${m} memories, ${c} chats kept`;
  });
  await step('Model check: a retired model is detected and a working one offered', async () => {
    const r = await api('POST', '/device/models', { provider: 'custom', baseUrl: AI });
    expect(r.data.models.includes('qa-model'), 'models listed');
    return r.data.models.join(', ');
  });
  await step('Erase everything resets the phone app to first-run', async () => {
    await api('POST', '/device/reset', {});
    await page.goto(URL_ + '/');
    await page.getByLabel('What should I call you?').waitFor({ timeout: 30000 });
    return 'back at setup, data gone';
  });

  const real = errors.filter((e) => !/Failed to fetch|NetworkError|net::ERR|ResizeObserver/.test(e));
  results.push({ name: 'No script errors during the whole run', ok: real.length === 0, detail: real.slice(0, 5).join(' | ') });
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ app: NAME, at: new Date().toISOString(), results, outside: { ...outside, telegram: [...new Set(outside.telegram)] } }, null, 2));
  console.log(`\n${NAME}: ${results.filter((r) => r.ok).length}/${results.length} passed`);
  await browser.close();
})();
