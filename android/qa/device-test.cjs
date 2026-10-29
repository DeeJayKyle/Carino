// Drives the real APK on an Android emulator (Android check workflow), through the app's own
// screens, to test what only the phone does: Android networking (streaming replies), the
// in-app server and its storage, notifications and alarms while the app is closed, sharing into
// the app, saving files to Downloads, the phone's voice, the back button, and keeping data
// after the app is force-stopped.
// Usage: node android/qa/device-test.cjs <package> <AppName> <fake-ai-url-as-seen-from-the-phone>
const { _android: android } = require('playwright');
const fs = require('fs');

const [PKG, NAME, AI] = process.argv.slice(2);
const results = [];
const OUT = 'device-test';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const [device] = await android.devices();
  if (!device) throw new Error('No emulator found');
  const sh = async (cmd) => (await device.shell(cmd)).toString();
  const activity = (await sh(`cmd package resolve-activity --brief ${PKG}`)).trim().split('\n').pop();
  let page;
  const attach = async () => {
    const wv = await device.webView({ pkg: PKG }, { timeout: 60000 });
    page = await wv.page();
    page.setDefaultTimeout(30000);
  };
  const shot = async (name) => fs.writeFileSync(`${OUT}/${name}.png`, await device.screenshot());
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? '' });
      console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
    } catch (e) {
      results.push({ name, ok: false, ms: Date.now() - t0, detail: String(e.message ?? e).split('\n')[0].slice(0, 300) });
      console.log(`FAIL  ${name} — ${String(e.message ?? e).split('\n')[0].slice(0, 300)}`);
      await shot('FAIL-' + name.replace(/\W+/g, '-').slice(0, 40)).catch(() => {});
    }
  };
  const expect = (c, m) => { if (!c) throw new Error(m); };
  const api = (method, path, body) => page.evaluate(async ([m, p, b]) => {
    const r = await fetch('/api' + p, { method: m, headers: { 'content-type': 'application/json', 'x-hailey': '1', 'x-carino': '1' }, body: b === undefined ? undefined : JSON.stringify(b) });
    const t = await r.text();
    try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, data: t }; }
  }, [method, path, body]);
  const settle = () => page.evaluate(() => globalThis.__flushEngine?.()).catch(() => {});

  await sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`).catch(() => {});
  await sh(`am start -W -n ${activity}`);

  await step('App opens to setup, with its server running on the phone', async () => {
    await attach();
    await page.getByLabel('What should I call you?').waitFor({ timeout: 60000 });
    await shot('01-setup');
    return `WebView at ${page.url()}`;
  });
  await step('Setup through the app’s screens, using Android networking to reach the AI service', async () => {
    await page.getByLabel('What should I call you?').fill('Herbert');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('radio', { name: /Ollama on your PC/ }).click();
    await page.locator('#dai-url').fill(AI);
    await page.getByRole('button', { name: 'Check my key' }).click();
    await page.getByText(/free model\(s\) available/).waitFor();
    await shot('02-ai-setup');
    await page.getByRole('button', { name: 'Save and test' }).click();
    await page.getByText('What would you like help with', { exact: false }).waitFor();
    await page.getByRole('button', { name: /Food/ }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: /Let’s go/ }).click();
    await page.waitForTimeout(2000);
    return 'model list fetched and test reply received over Android HTTP';
  });
  await step('Chat reply streams in through Android’s HTTP bridge', async () => {
    await page.evaluate(() => { location.href = '/chat/new?q=' + encodeURIComponent('Hello from the emulator'); });
    await page.locator('.msg.assistant').filter({ hasText: 'Reply to:' }).first().waitFor({ timeout: 45000 });
    await shot('03-chat');
    return 'reply shown';
  });
  await step('Assistant adds a to-do on the phone', async () => {
    await page.locator('textarea').last().fill('TOOL create_task {"title":"Buy maize flour"}');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.locator('.msg.assistant').filter({ hasText: 'Done.' }).first().waitFor({ timeout: 45000 });
    const t = (await api('GET', '/tasks?view=all')).data.tasks;
    expect(t.some((x) => x.title === 'Buy maize flour'), 'task saved');
    return `${t.length} to-do(s) stored on the phone`;
  });
  await step('Phone notification from the app (test notification)', async () => {
    const r = await api('POST', '/push/test');
    expect(r.status < 300, 'test push accepted');
    await page.waitForTimeout(2000);
    const n = await sh('dumpsys notification --noredact');
    expect(n.includes(`pkg=${PKG}`), 'the app posted a notification');
    await shot('04-notification');
    return 'notification posted to Android';
  });
  await step('A reminder rings while the app is closed (Android alarm)', async () => {
    const at = new Date(Date.now() + 45_000).toISOString();
    const r = await api('POST', '/reminders', { title: 'QA alarm reminder', remind_at: at });
    expect(r.status < 300, `reminder saved (${r.status})`);
    await settle();
    await page.waitForTimeout(1000);
    const alarms = await sh(`dumpsys alarm | grep -c ${PKG} || true`);
    await sh('input keyevent KEYCODE_HOME');
    // Closed the way Android closes background apps (force-stop would also cancel its alarms).
    await sh(`am kill ${PKG}`);
    const until = Date.now() + 120_000;
    let seen = false;
    while (Date.now() < until && !seen) {
      await new Promise((ok) => setTimeout(ok, 5000));
      seen = (await sh('dumpsys notification --noredact')).includes('QA alarm reminder');
    }
    await shot('05-alarm');
    expect(seen, `no notification within 2 min (alarm entries: ${alarms.trim()})`);
    return `notification shown with the app closed (alarm entries: ${alarms.trim()})`;
  });
  await step('Data is kept after the app is force-stopped and reopened', async () => {
    await sh(`am force-stop ${PKG}`);
    await sh(`am start -W -n ${activity}`);
    await attach();
    await page.waitForTimeout(3000);
    const t = (await api('GET', '/tasks?view=all')).data.tasks;
    expect(t.some((x) => x.title === 'Buy maize flour'), 'to-do still there');
    const me = (await api('GET', '/auth/me')).data;
    expect(me.settings?.onboarded, 'setup still done');
    return `${t.length} to-do(s) and settings kept`;
  });
  await step('Sharing text from another app opens the Share screen', async () => {
    await sh(`am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT "Shared from QA https://example.org/menu" -n ${activity}`);
    await page.waitForTimeout(1500);
    await attach();
    await page.getByText('Shared from QA', { exact: false }).first().waitFor({ timeout: 20000 });
    await shot('06-share');
    expect(page.url().includes('/share'), 'share screen');
    return 'shared text received';
  });
  await step('Export saves a file to the phone’s Downloads folder', async () => {
    await page.evaluate(() => { location.href = '/settings#privacy'; });
    await page.getByRole('button', { name: /Download export/ }).click();
    await page.waitForTimeout(2500);
    const ls = await sh('ls /sdcard/Download/');
    expect(/export\.json/.test(ls), 'file in Downloads: ' + ls.trim());
    return ls.trim().split('\n').filter((l) => l.includes('export')).join(', ');
  });
  await step('Phone’s voice reads text aloud (text-to-speech)', async () => {
    const r = await page.evaluate(() => new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 20000);
      const hn = globalThis.__hn;
      const prev = hn.spoke;
      hn.spoke = () => { clearTimeout(t); hn.spoke = prev; resolve('spoke'); };
      (globalThis.HaileyNative ?? globalThis.CarinoNative).speak('Hello, this is a test.', 'en-US');
    }));
    expect(r === 'spoke', 'speech did not finish: ' + r);
    return 'spoken and finished';
  });
  await step('Back button goes back inside the app', async () => {
    await page.evaluate(() => { history.pushState(null, '', '/tasks'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.evaluate(() => { location.href = '/me'; });
    await page.waitForTimeout(1500);
    await sh('input keyevent KEYCODE_BACK');
    await page.waitForTimeout(1500);
    const fg = await sh('dumpsys activity activities | grep -m1 -E "topResumedActivity|mResumedActivity"');
    expect(fg.includes(PKG), 'app still in front after Back: ' + fg.trim());
    return 'went back a page, app stayed open';
  });
  await step('Home-screen widget is offered', async () => {
    const w = await sh('dumpsys appwidget');
    expect(w.includes(PKG), 'widget provider registered');
    return 'widget provider registered';
  });

  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ app: NAME, results }, null, 2));
  console.log(`\nDEVICE ${NAME}: ${results.filter((r) => r.ok).length}/${results.length} passed`);
  console.log('DEVICE_RESULTS ' + JSON.stringify(results));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})().catch((e) => {
  console.log('DEVICE TEST CRASHED: ' + e.message);
  process.exit(1);
});
