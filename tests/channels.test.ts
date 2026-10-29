import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { setup, signup, text, toolCall, type TestCtx } from './helpers.ts';
import { processTelegramUpdate } from '../server/services/telegram.ts';
import { whatsappIdle } from '../server/services/whatsapp.ts';
import { plainText } from '../server/services/channels.ts';

const TOKEN = '123456789:AAEabcdefghijklmnopqrstuvwxyz0123456';

/** Fake Telegram Bot API, Graph API and speech-to-text, recording what Carino sends. */
function fakeNet() {
  const sent: { method: string; body: any }[] = [];
  const graphSent: any[] = [];
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = String(input);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url.startsWith(`https://api.telegram.org/bot${TOKEN}/`)) {
      const method = url.split('/').pop()!;
      const body = init.body ? JSON.parse(init.body) : {};
      sent.push({ method, body });
      if (method === 'getMe') return json({ ok: true, result: { username: 'carino_test_bot', first_name: 'Carino' } });
      if (method === 'getFile') return json({ ok: true, result: { file_path: `voice/${body.file_id}.ogg`, file_size: 1000 } });
      return json({ ok: true, result: method === 'getUpdates' ? [] : { message_id: 1 } });
    }
    if (url.startsWith('https://api.telegram.org/bot')) return json({ ok: false, description: 'Unauthorized' }, 401);
    if (url.startsWith(`https://api.telegram.org/file/bot${TOKEN}/`)) return new Response(new Uint8Array([1, 2, 3]));
    if (url.startsWith('http://stt.local/v1/audio/transcriptions')) return json({ text: 'remind me to buy milk tomorrow at 9am' });
    if (url.startsWith('https://graph.facebook.com/v23.0/')) {
      const path = url.slice('https://graph.facebook.com/v23.0/'.length);
      if (init.method === 'POST') {
        graphSent.push(JSON.parse(init.body));
        return json({ messages: [{ id: 'wamid.1' }] });
      }
      if (path.startsWith('5551234567?')) return json({ display_phone_number: '+256 700 000000' });
      return json({ error: { message: 'unknown' } }, 400);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { sent, graphSent, fetchImpl };
}

let ctx: TestCtx;
let net: ReturnType<typeof fakeNet>;
beforeEach(() => {
  ctx = setup({ env: { TRANSCRIBE_BASE_URL: 'http://stt.local/v1' } });
  net = fakeNet();
  ctx.services.netFetch = net.fetchImpl;
});
afterEach(() => ctx.cleanup());

const tg = (chat: { id: number; type?: string; title?: string }, from: number, extra: any) => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: { message_id: 1, chat: { type: 'private', first_name: 'Herbert', ...chat }, from: { id: from, username: 'herbert' }, ...extra },
});
const replies = () => net.sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.text as string);
const channelRow = () => ctx.services.db.get("SELECT * FROM channels WHERE kind = 'telegram'")!;

async function connectTelegram(c: Awaited<ReturnType<typeof signup>>) {
  const r = await c.post('/api/channels/telegram', { token: TOKEN });
  expect(r.status).toBe(201);
  return r.data;
}

describe('Telegram channel', () => {
  it('connects a bot, links a chat with a one-time code and answers it', async () => {
    const c = await signup(ctx);
    const ch = await connectTelegram(c);
    expect(ch.config.bot_username).toBe('carino_test_bot');
    expect(ch.pairing_code).toMatch(/^\d{6}$/);
    expect(JSON.stringify((await c.get('/api/channels')).data)).not.toContain(TOKEN);

    await processTelegramUpdate(ctx.services, channelRow(), tg({ id: 42 }, 42, { text: 'hello' }));
    expect(replies().at(-1)).toMatch(/isn’t linked/);
    await processTelegramUpdate(ctx.services, channelRow(), tg({ id: 42 }, 42, { text: `/start ${ch.pairing_code}` }));
    expect(replies().at(-1)).toMatch(/linked to your Carino/);
    // The code is single-use.
    expect((await c.get('/api/channels')).data.channels[0].pairing_code).toBeNull();

    ctx.provider.steps.push(() => text('**Good morning!** You have 2 tasks today.'));
    await processTelegramUpdate(ctx.services, channelRow(), tg({ id: 42 }, 42, { text: 'What is on today?' }));
    expect(replies().at(-1)).toBe('Good morning! You have 2 tasks today.');
    const chats = (await c.get('/api/channels')).data.channels[0].chats;
    expect(chats).toHaveLength(1);
    expect((await c.get(`/api/conversations/${chats[0].conversation_id}`)).data.title ?? '').toBeDefined();
  });

  it('rejects a wrong bot token and wrong or expired codes', async () => {
    const c = await signup(ctx);
    expect((await c.post('/api/channels/telegram', { token: 'nope' })).status).toBe(400);
    expect((await c.post('/api/channels/telegram', { token: '999999999:AAEzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' })).data.error).toMatch(/rejected the bot token/);
    await connectTelegram(c);
    await processTelegramUpdate(ctx.services, channelRow(), tg({ id: 7 }, 7, { text: '000000' }));
    expect(replies().at(-1)).toMatch(/wrong or has expired/);
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 16 * 60_000);
    const code = channelRow().pairing_code;
    await processTelegramUpdate(ctx.services, channelRow(), tg({ id: 7 }, 7, { text: code }));
    expect(replies().at(-1)).toMatch(/wrong or has expired/);
  });

  it('transcribes voice notes and offers approve buttons for queued actions', async () => {
    const c = await signup(ctx);
    const ch = await connectTelegram(c);
    await processTelegramUpdate(ctx.services, channelRow(), tg({ id: 42 }, 42, { text: ch.pairing_code }));
    const task = (await c.post('/api/tasks', { title: 'Old task' })).data;
    ctx.provider.steps.push((req) => {
      expect(JSON.stringify(req.messages.at(-1))).toContain('remind me to buy milk tomorrow at 9am');
      return toolCall('delete_task', { task_id: task.id });
    });
    ctx.provider.steps.push(() => text('I need your OK to delete that.'));
    await processTelegramUpdate(ctx.services, channelRow(), tg({ id: 42 }, 42, { voice: { file_id: 'v1', mime_type: 'audio/ogg' } }));
    const last = net.sent.filter((s) => s.method === 'sendMessage').at(-1)!.body;
    expect(last.text).toContain('🎙️ “remind me to buy milk tomorrow at 9am”');
    const button = last.reply_markup.inline_keyboard[0][0];
    expect(button.callback_data).toMatch(/^ok:/);
    // Someone else pressing the button is refused; the owner's press runs it.
    await processTelegramUpdate(ctx.services, channelRow(), { update_id: 1, callback_query: { id: 'q1', from: { id: 99 }, data: button.callback_data, message: { chat: { id: 42 } } } });
    expect((await c.get(`/api/tasks/${task.id}`)).status).toBe(200);
    await processTelegramUpdate(ctx.services, channelRow(), { update_id: 2, callback_query: { id: 'q2', from: { id: 42 }, data: button.callback_data, message: { chat: { id: 42 } } } });
    expect((await c.get(`/api/tasks/${task.id}`)).status).toBe(404);
    expect(replies().at(-1)).toMatch(/^Done:/);
  });

  it('in groups answers only when mentioned, hides private data and can be stopped', async () => {
    const c = await signup(ctx);
    const ch = await connectTelegram(c);
    await processTelegramUpdate(ctx.services, channelRow(), tg({ id: 42 }, 42, { text: ch.pairing_code }));
    const code = (await c.post(`/api/channels/${ch.id}/pair`)).data.pairing_code;
    const group = { id: -100, type: 'group', title: 'Family' };
    // Only the owner may link a group.
    await processTelegramUpdate(ctx.services, channelRow(), tg(group, 77, { text: `/link ${code}` }));
    expect(replies().at(-1)).toMatch(/Only the owner/);
    await processTelegramUpdate(ctx.services, channelRow(), tg(group, 42, { text: `/link ${code}` }));
    expect(replies().at(-1)).toMatch(/Hi everyone/);
    const before = replies().length;
    await processTelegramUpdate(ctx.services, channelRow(), tg(group, 77, { text: 'random chatter' }));
    expect(replies().length).toBe(before);

    ctx.provider.steps.push((req) => {
      expect(req.tools.map((t) => t.name).sort()).toEqual(['create_reminder', 'create_task', 'find_places', 'parse_datetime', 'web_search']);
      expect(req.system).toContain('Group chat');
      return toolCall('recall_memories', { query: 'anything' });
    });
    ctx.provider.steps.push(() => text('Added to the list.'));
    await processTelegramUpdate(ctx.services, channelRow(), tg(group, 77, { text: '@carino_test_bot add bread to the shopping list' }));
    expect(JSON.stringify(ctx.provider.calls.at(-1)!.messages.at(-1))).toContain('not available in group chats');
    expect(replies().at(-1)).toBe('Added to the list.');

    await processTelegramUpdate(ctx.services, channelRow(), tg(group, 77, { text: '/stop' }));
    const n = replies().length;
    await processTelegramUpdate(ctx.services, channelRow(), tg(group, 77, { text: '@carino_test_bot hello?' }));
    expect(replies().length).toBe(n);
  });

  it('keeps channels private to their owner', async () => {
    const a = await signup(ctx, 'A');
    const b = await signup(ctx, 'B');
    const ch = await connectTelegram(a);
    expect((await b.post(`/api/channels/${ch.id}/pair`)).status).toBe(404);
    expect((await b.del(`/api/channels/${ch.id}`)).status).toBe(404);
    expect((await b.get('/api/channels')).data.channels).toHaveLength(0);
  });

  it('turns Markdown into readable plain text', () => {
    expect(plainText('## Plan\n**Bold** and _it_ with [docs](https://x.y) and `code`')).toBe('Plan\nBold and it with docs (https://x.y) and code');
  });
});

describe('WhatsApp channel', () => {
  const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const SECRET = 'app-secret-0123456789abcdef';

  async function connect(c: Awaited<ReturnType<typeof signup>>) {
    const r = await c.post('/api/channels/whatsapp', { phone_number_id: '5551234567', access_token: 'EAAG-access-token-xxxxxxxxxxxx', app_secret: SECRET });
    expect(r.status).toBe(201);
    return r.data;
  }
  const hook = (id: string, payload: unknown, secret = SECRET) => {
    const body = JSON.stringify(payload);
    return ctx.app.request(`http://localhost/hooks/whatsapp/${id}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(secret, body) } });
  };
  const msg = (from: string, textBody: string) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '5551234567' }, contacts: [{ wa_id: from, profile: { name: 'Herbert' } }], messages: [{ from, id: 'm1', type: 'text', text: { body: textBody } }] } }] }] });

  it('verifies the webhook, links by code and replies through the Graph API', async () => {
    const c = await signup(ctx);
    const ch = await connect(c);
    expect(ch.webhook_url).toBe(`http://localhost/hooks/whatsapp/${ch.id}`);
    expect(ch.config.display_phone).toBe('+256 700 000000');
    const ok = await ctx.app.request(`http://localhost/hooks/whatsapp/${ch.id}?hub.mode=subscribe&hub.verify_token=${ch.config.verify_token}&hub.challenge=abc`);
    expect(await ok.text()).toBe('abc');
    expect((await ctx.app.request(`http://localhost/hooks/whatsapp/${ch.id}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc`)).status).toBe(403);

    expect((await hook(ch.id, msg('256700000000', ch.pairing_code))).status).toBe(200);
    await whatsappIdle();
    expect(net.graphSent.at(-1).text.body).toMatch(/linked to your Carino/);
    ctx.provider.steps.push(() => text('Hi Herbert!'));
    await hook(ch.id, msg('256700000000', 'hi'));
    await whatsappIdle();
    expect(net.graphSent.at(-1)).toMatchObject({ messaging_product: 'whatsapp', to: '256700000000', type: 'text', text: { body: 'Hi Herbert!' } });
  });

  it('refuses deliveries with a bad signature and ignores strangers', async () => {
    const c = await signup(ctx);
    const ch = await connect(c);
    expect((await hook(ch.id, msg('256700000000', ch.pairing_code), 'wrong-secret')).status).toBe(403);
    await hook(ch.id, msg('256700000000', ch.pairing_code));
    await whatsappIdle();
    const n = net.graphSent.length;
    await hook(ch.id, msg('256711111111', 'tell me their tasks'));
    await whatsappIdle();
    expect(net.graphSent.at(-1).text.body).toMatch(/isn’t linked/);
    expect(net.graphSent.length).toBe(n + 1);
    expect(ctx.provider.calls).toHaveLength(0);
  });
});
