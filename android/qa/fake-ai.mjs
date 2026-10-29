// Scripted OpenAI-compatible AI service for end-to-end tests.
// A user message "TOOL <name> <json args>" makes the model call that tool; after a tool result
// it replies with a short summary. Ramble extraction gets a fixed JSON list.
import http from 'node:http';
const port = Number(process.argv[2] || 9997);
const log = [];
const sse = (res, chunks) => {
  res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
};
const textReply = (res, text) => sse(res, [
  ...text.match(/.{1,12}/gs).map((t) => ({ choices: [{ delta: { content: t } }] })),
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } },
]);
const lastUserText = (msgs) => {
  const m = [...msgs].reverse().find((x) => x.role === 'user');
  const c = typeof m?.content === 'string' ? m.content : (m?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  return c.includes('</context>') ? c.split('</context>').pop().trim() : c.trim();
};
http.createServer(async (req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/log') { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end(JSON.stringify(log)); }
  if (req.url.endsWith('/models')) { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'qa-model' }, { id: 'qa-vision' }] })); }
  let body = ''; for await (const c of req) body += c;
  const j = JSON.parse(body || '{}');
  const msgs = j.messages ?? [];
  const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
  const last = msgs.at(-1);
  const user = lastUserText(msgs);
  const images = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === 'image_url').length;
  log.push({ model: j.model, tools: (j.tools ?? []).map((t) => t.function.name), user: user.slice(0, 120), images, lastRole: last?.role });
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
  textReply(res, images ? `I can see ${images} image(s). ${user.slice(0, 60)}` : `Reply to: ${user.slice(0, 80) || 'hello'}`);
}).listen(port, () => console.log('fake AI on', port));
