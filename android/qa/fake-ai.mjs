// Scripted OpenAI-compatible AI service for end-to-end tests.
// A user message "TOOL <name> <json args>" makes the model call that tool; after a tool result
// it replies with a short summary. Ramble extraction gets a fixed JSON list.
import http from 'node:http';
const port = Number(process.argv[2] || 9997);
const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Each model answers at its own pace, so the speed test has something to rank.
const FIRST_DELAY = { 'qa-model': 250, 'qa-vision': 40 };
const sse = async (res, chunks, { first = 0, gap = 0 } = {}) => {
  res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' });
  if (first) await sleep(first);
  for (const c of chunks) {
    if (res.destroyed) return;
    res.write(`data: ${JSON.stringify(c)}\n\n`);
    if (gap) await sleep(gap);
  }
  res.end('data: [DONE]\n\n');
};
const textReply = (res, text, timing) => sse(res, [
  ...text.match(/.{1,12}/gs).map((t) => ({ choices: [{ delta: { content: t } }] })),
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } },
], timing);
const fail = (res, status, message) => {
  res.writeHead(status, { 'access-control-allow-origin': '*', 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
};
const XSS = 'Here you go: <img src=x onerror="window.__xss=1"> <script>window.__xss=2</script> [tap me](javascript:window.__xss=3) <a href="javascript:window.__xss=4">link</a> <iframe src="https://evil.test"></iframe> **bold** done.';
const LONG = '# Weekly stock plan\n\n' + Array.from({ length: 60 }, (_, i) => `- Item ${i + 1}: order ${i * 3} units of supply number ${i} for the shop, check the price first`).join('\n') + '\n\n| Item | Qty | Price |\n|---|---|---|\n' + Array.from({ length: 25 }, (_, i) => `| Thing ${i} | ${i} | UGX ${i * 1500} |`).join('\n') + '\n\n```js\nconst total = items.reduce((a, b) => a + b.price * b.qty, 0); // a very long line of code that should scroll sideways inside its box and never stretch the page\n```\n';
const lastUserText = (msgs) => {
  const m = [...msgs].reverse().find((x) => x.role === 'user');
  const c = typeof m?.content === 'string' ? m.content : (m?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  return c.includes('</context>') ? c.split('</context>').pop().trim() : c.trim();
};
http.createServer(async (req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/log') { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end(JSON.stringify(log)); }
  const auth = req.headers.authorization ?? '';
  if (auth === 'Bearer bad-key') return fail(res, 401, 'Invalid API key provided');
  if (req.url.endsWith('/models')) { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'qa-model' }, { id: 'qa-vision' }] })); }
  let body = ''; for await (const c of req) body += c;
  const j = JSON.parse(body || '{}');
  const msgs = j.messages ?? [];
  const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
  const last = msgs.at(-1);
  const user = lastUserText(msgs);
  const images = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === 'image_url').length;
  log.push({ model: j.model, tools: (j.tools ?? []).map((t) => t.function.name), user: user.slice(0, 120), images, lastRole: last?.role });
  if (j.model === 'limited-model') return fail(res, 429, 'Rate limit reached for limited-model');
  if (j.model === 'down-model') return fail(res, 503, 'The model is overloaded');
  if (j.model === 'gone-model') { res.writeHead(404, { ...cors, 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'model gone-model not found' } })); }
  if (/brain-dump/i.test(typeof sys === 'string' ? sys : '')) {
    return textReply(res, JSON.stringify({ items: [
      { type: 'task', title: 'Order paracetamol stock', when: 'tomorrow at 9am', priority: 1 },
      { type: 'reminder', title: 'Call Mama', when: 'tomorrow at 5pm' },
      { type: sys.includes('"memory"') ? 'memory' : 'note', title: 'Idea: loyalty card for regular customers' },
    ] }));
  }
  if (last?.role === 'tool') {
    const r = String(last.content ?? '').slice(0, 160).replace(/\s+/g, ' ');
    return textReply(res, `Done. Tool result: ${r}`);
  }
  const m = user.match(/^TOOL (\w+) (\{[\s\S]*\})\s*$/);
  if (m) {
    return sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: m[1], arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: m[2] } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 80, completion_tokens: 20 } },
    ]);
  }
  if (/^SLOW\b/.test(user)) return textReply(res, 'This answer arrives slowly, a few words at a time, so you can see it streaming and stop it if you like. '.repeat(3), { first: 300, gap: 250 });
  if (/^XSS\b/.test(user)) return textReply(res, XSS);
  if (/^LONG\b/.test(user)) return textReply(res, LONG);
  if (/^ECHO\b/.test(user)) return textReply(res, user.slice(5));
  textReply(res, images ? `I can see ${images} image(s). ${user.slice(0, 60)}` : `Reply to: ${user.slice(0, 80) || 'hello'}`, { first: FIRST_DELAY[j.model] ?? 0 });
}).listen(port, () => console.log('fake AI on', port));
