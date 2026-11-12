import type { Services } from '../context.ts';
import { badRequest } from '../context.ts';
import type { Row } from '../db/index.ts';
import { parseJson } from '../db/index.ts';
import { handleIncoming, channelSecret, saveChannel, type Incoming, type Outgoing } from './channels.ts';
import { transcribe, TranscribeError } from './transcribe.ts';
import { storeDocument, MAX_IMAGE_BYTES } from './documents.ts';
import { getSettings } from './settings.ts';

/**
 * Telegram channel through the free Bot API. The user creates their own bot with @BotFather
 * and pastes its token. Carino long-polls getUpdates, so no public address or webhook is needed.
 */
const API = 'https://api.telegram.org';
type Secret = { token: string };

export class TelegramError extends Error {}

async function call<T = any>(services: Services, token: string, method: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
  const f = services.netFetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${API}/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new TelegramError('Could not reach Telegram.');
  }
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (res.status === 401 || res.status === 404) throw new TelegramError('Telegram rejected the bot token. Copy it again from @BotFather.');
  if (!data.ok) throw new TelegramError(`Telegram: ${data.description ?? `error ${res.status}`}`);
  return data.result as T;
}

async function download(services: Services, token: string, fileId: string, maxBytes: number) {
  const file = await call<{ file_path?: string; file_size?: number }>(services, token, 'getFile', { file_id: fileId });
  if (!file.file_path) throw new TelegramError('Telegram did not return the file.');
  if ((file.file_size ?? 0) > maxBytes) throw new TelegramError('That file is too large to fetch from Telegram (bots can download up to 20 MB).');
  const f = services.netFetch ?? fetch;
  const res = await f(`${API}/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new TelegramError('Could not download the file from Telegram.');
  return { buf: Buffer.from(await res.arrayBuffer()), path: file.file_path };
}

/** Checks the token, reads the bot's name and starts a fresh update offset. */
export async function connectTelegram(services: Services, userId: string, token: string) {
  if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token.trim())) throw badRequest('That doesn’t look like a bot token. It looks like 123456789:AAE… and comes from @BotFather.');
  let me: { username?: string; first_name?: string };
  try {
    me = await call(services, token.trim(), 'getMe');
    // Polling and webhooks can't both be on; make sure no old webhook swallows messages.
    await call(services, token.trim(), 'deleteWebhook', { drop_pending_updates: false });
  } catch (e: any) {
    throw badRequest(e.message);
  }
  const ch = saveChannel(services, userId, 'telegram', { token: token.trim() } satisfies Secret, { bot_username: me.username ?? '', bot_name: me.first_name ?? '' });
  services.db.run("UPDATE channels SET state = '{}' WHERE id = ?", ch.id);
  return ch;
}

function toIncoming(update: any, botUsername: string): { msg: any; incoming: Omit<Incoming, 'text'> & { text: string } } | null {
  const m = update.message ?? update.edited_message;
  if (!m?.chat) return null;
  const isGroup = m.chat.type === 'group' || m.chat.type === 'supergroup';
  const raw: string = m.text ?? m.caption ?? '';
  const mention = botUsername ? new RegExp(`@${botUsername}\\b`, 'i') : null;
  const addressed = !isGroup || !!(mention && mention.test(raw)) || m.reply_to_message?.from?.username?.toLowerCase() === botUsername.toLowerCase() || /^\/\w+/.test(raw);
  return {
    msg: m,
    incoming: {
      chatId: String(m.chat.id), senderId: String(m.from?.id ?? ''), senderName: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' '), isGroup, addressed,
      chatTitle: m.chat.title ?? [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') ?? '',
      text: mention ? raw.replace(mention, '').trim() : raw,
    },
  };
}

export async function sendTelegram(services: Services, token: string, chatId: string, out: Outgoing) {
  const chunks = out.text.match(/[\s\S]{1,3900}(?=\s|$)|[\s\S]{1,3900}/g) ?? [out.text];
  for (const [n, chunk] of chunks.entries()) {
    const last = n === chunks.length - 1;
    await call(services, token, 'sendMessage', {
      chat_id: chatId, text: chunk, link_preview_options: { is_disabled: true },
      ...(last && out.approvals?.length ? {
        reply_markup: { inline_keyboard: out.approvals.slice(0, 5).map((a) => [
          { text: `✅ Approve: ${a.summary.slice(0, 40)}`, callback_data: `ok:${a.id}` },
          { text: '✖ Decline', callback_data: `no:${a.id}` },
        ]) },
      } : {}),
    });
  }
}

/** Approve/decline buttons. Only the owner's linked private chat may decide. */
async function handleCallback(services: Services, ch: Row, token: string, cb: any) {
  const { db } = services;
  const chat = db.get('SELECT * FROM channel_chats WHERE channel_id = ? AND external_id = ? AND is_group = 0', ch.id, String(cb.message?.chat?.id ?? ''));
  const answer = (text: string) => call(services, token, 'answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => undefined);
  if (!chat || chat.owner_external_id !== String(cb.from?.id)) return answer('Only the owner can approve this.');
  const m = String(cb.data ?? '').match(/^(ok|no):([0-9a-f-]{36})$/);
  if (!m) return answer('Unknown button.');
  const { approveAction, rejectAction } = await import('../tools/registry.ts');
  try {
    if (m[1] === 'ok') {
      const r = await approveAction(services, ch.user_id, m[2]);
      await answer(r.status === 'executed' ? 'Done' : 'It failed');
      await sendTelegram(services, token, chat.external_id, { text: r.status === 'executed' ? `Done: ${r.summary}` : `That failed: ${r.status === 'error' ? r.error : ''}` });
    } else {
      rejectAction(services, ch.user_id, m[2]);
      await answer('Declined');
    }
  } catch (e: any) {
    await answer(String(e?.message ?? 'Could not do that').slice(0, 180));
  }
}

/** Processes one update from getUpdates. Exported for tests. */
export async function processTelegramUpdate(services: Services, ch: Row, update: any) {
  const secret = channelSecret<Secret>(services, ch);
  if (!secret) return;
  if (update.callback_query) return handleCallback(services, ch, secret.token, update.callback_query);
  const config = parseJson<{ bot_username?: string; transcribe_voice?: boolean }>(ch.config, {});
  const parsed = toIncoming(update, config.bot_username ?? '');
  if (!parsed) return;
  const { msg, incoming } = parsed;
  const linked = services.db.get('SELECT * FROM channel_chats WHERE channel_id = ? AND external_id = ?', ch.id, incoming.chatId);
  const full: Incoming = { ...incoming };
  try {
    // Media is only fetched for linked chats that are talking to Carino.
    if (linked && !linked.muted && incoming.addressed) {
      const voice = msg.voice ?? msg.audio;
      if (voice && config.transcribe_voice !== false) {
        const { buf, path } = await download(services, secret.token, voice.file_id, 20 * 1024 * 1024);
        full.text = await transcribe(services, buf, path.split('/').pop() || 'voice.ogg', voice.mime_type || 'audio/ogg', getSettings(services.db, ch.user_id).voice.language);
        full.transcribedFrom = 'voice note';
      }
      const photo = Array.isArray(msg.photo) ? msg.photo.at(-1) : null;
      const doc = msg.document;
      if (photo || doc) {
        const { buf, path } = await download(services, secret.token, (photo ?? doc).file_id, photo ? MAX_IMAGE_BYTES : 20 * 1024 * 1024);
        const name = doc?.file_name || `telegram-${path.split('/').pop() || 'photo.jpg'}`;
        const { doc: stored } = await storeDocument(services.db, services.config.DATA_DIR, ch.user_id, { name, buf }, { tags: ['telegram'] }, services.config.MAX_UPLOAD_MB * 1024 * 1024);
        full.attachments = [stored.id];
      }
    }
  } catch (e: any) {
    const why = e instanceof TranscribeError || e instanceof TelegramError || e?.status ? e.message : 'Could not read that attachment.';
    await sendTelegram(services, secret.token, incoming.chatId, { text: why }).catch(() => undefined);
    return;
  }
  const out = await handleIncoming(services, ch, full);
  if (!out) return;
  if (!linked || incoming.isGroup || !out.approvals?.length) delete out.approvals;
  await call(services, secret.token, 'sendChatAction', { chat_id: incoming.chatId, action: 'typing' }).catch(() => undefined);
  await sendTelegram(services, secret.token, incoming.chatId, out);
}

/** One long-poll cycle for a channel. Exported for tests. */
export async function pollTelegramOnce(services: Services, ch: Row, timeoutSec = 25) {
  const secret = channelSecret<Secret>(services, ch);
  if (!secret) throw new TelegramError('The saved bot token can no longer be read. Connect the bot again.');
  const state = parseJson<{ offset?: number }>(ch.state, {});
  const updates = await call<any[]>(services, secret.token, 'getUpdates', { offset: state.offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, (timeoutSec + 10) * 1000);
  for (const u of updates) {
    // Store the offset first so a crash can't make a message be answered twice.
    services.db.run('UPDATE channels SET state = ? WHERE id = ?', JSON.stringify({ offset: u.update_id + 1 }), ch.id);
    await processTelegramUpdate(services, ch, u).catch((err) => console.error('[telegram]', err?.message ?? err));
  }
  return updates.length;
}

/** Keeps one poller running for every enabled Telegram channel. */
export function startTelegram(services: Services) {
  const running = new Map<string, boolean>();
  let stopped = false;
  const loop = async (id: string) => {
    let backoff = 5_000;
    while (!stopped) {
      const ch = services.db.get("SELECT * FROM channels WHERE id = ? AND kind = 'telegram' AND enabled = 1", id);
      if (!ch) break;
      try {
        await pollTelegramOnce(services, ch);
        if (ch.last_error) services.db.run('UPDATE channels SET last_error = NULL WHERE id = ?', id);
        backoff = 5_000;
      } catch (err: any) {
        services.db.run('UPDATE channels SET last_error = ? WHERE id = ?', String(err?.message ?? err).slice(0, 300), id);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 5 * 60_000);
      }
    }
    running.delete(id);
  };
  const scan = () => {
    for (const ch of services.db.all("SELECT id FROM channels WHERE kind = 'telegram' AND enabled = 1")) {
      if (!running.has(ch.id)) {
        running.set(ch.id, true);
        void loop(ch.id);
      }
    }
  };
  const timer = setInterval(scan, 15_000);
  timer.unref?.();
  scan();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
