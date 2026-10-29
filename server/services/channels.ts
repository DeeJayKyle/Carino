import { randomInt } from 'node:crypto';
import type { Services } from '../context.ts';
import { HttpError, badRequest } from '../context.ts';
import type { Db, Row } from '../db/index.ts';
import { parseJson, nowIso } from '../db/index.ts';
import { encryptSecret, decryptSecret } from './secrets.ts';
import { getSettings } from './settings.ts';
import { previewText } from './routines.ts';

export type ChannelKind = 'telegram' | 'whatsapp';
export const PAIRING_TTL_MS = 15 * 60_000;

/** An incoming message, already normalised by the Telegram or WhatsApp adapter. */
export interface Incoming {
  chatId: string;
  senderId: string;
  chatTitle: string;
  isGroup: boolean;
  text: string;
  /** Group messages: whether the bot was @mentioned or replied to. */
  addressed: boolean;
  attachments?: string[];
  /** How the text was produced, e.g. "voice note" (shown back to the user). */
  transcribedFrom?: string;
}

export interface Outgoing {
  text: string;
  /** Actions waiting for approval, so the adapter can offer buttons in the owner's private chat. */
  approvals?: { id: string; summary: string }[];
}

export function channelSecret<T>(services: Services, ch: Row): T | null {
  const raw = decryptSecret(services.config.DATA_DIR, ch.secret);
  return raw ? (JSON.parse(raw) as T) : null;
}

export function saveChannel(services: Services, userId: string, kind: ChannelKind, secret: unknown, config: Record<string, unknown>) {
  const { db } = services;
  const enc = encryptSecret(services.config.DATA_DIR, JSON.stringify(secret));
  const existing = db.get('SELECT * FROM channels WHERE user_id = ? AND kind = ?', userId, kind);
  if (existing) {
    db.run('UPDATE channels SET secret = ?, config = ?, enabled = 1, last_error = NULL, updated_at = ? WHERE id = ?', enc, JSON.stringify(config), nowIso(), existing.id);
    return db.get('SELECT * FROM channels WHERE id = ?', existing.id)!;
  }
  return db.insert('channels', { user_id: userId, kind, secret: enc, config: JSON.stringify(config) });
}

export function newPairingCode(db: Db, channelId: string, now: Date) {
  const code = String(randomInt(100000, 1000000));
  db.run('UPDATE channels SET pairing_code = ?, pairing_expires_at = ? WHERE id = ?', code, new Date(now.getTime() + PAIRING_TTL_MS).toISOString(), channelId);
  return code;
}

export function presentChannel(db: Db, ch: Row, now: Date) {
  const config = parseJson<Record<string, unknown>>(ch.config, {});
  return {
    id: ch.id, kind: ch.kind, enabled: !!ch.enabled, config, last_error: ch.last_error, last_seen_at: ch.last_seen_at,
    pairing_code: ch.pairing_code && ch.pairing_expires_at > now.toISOString() ? ch.pairing_code : null,
    pairing_expires_at: ch.pairing_expires_at,
    chats: db.all('SELECT id, title, is_group, muted, conversation_id, created_at FROM channel_chats WHERE channel_id = ? ORDER BY created_at', ch.id)
      .map((c) => ({ ...c, is_group: !!c.is_group, muted: !!c.muted })),
  };
}

export function ownChannel(db: Db, userId: string, id: string) {
  const ch = db.getOwned('channels', userId, id);
  if (!ch) throw new HttpError(404, 'Channel not found', 'not_found');
  return ch;
}

const HELP = 'Commands: /stop — I stop answering in this chat · /start — I answer again · /help — this message.';

/** Plain text for messaging apps: Markdown markers removed, links kept readable. */
export function plainText(md: string) {
  return md
    .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => (t === u ? u : `${t} (${u})`))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^>\s?/gm, '')
    .trim();
}

/**
 * Handles one incoming message: pairing, commands, then a normal agent turn in that chat's own
 * conversation. Only chats linked with a pairing code are answered; in groups Carino answers
 * only when addressed, and runs restricted (no private data, a few safe tools).
 */
export async function handleIncoming(services: Services, ch: Row, msg: Incoming): Promise<Outgoing | null> {
  const { db } = services;
  const now = services.now();
  db.run('UPDATE channels SET last_seen_at = ? WHERE id = ?', now.toISOString(), ch.id);
  const text = msg.text.trim();
  const command = text.match(/^\/(\w+)(?:@\w+)?(?:\s+(.*))?$/s);
  let chat = db.get('SELECT * FROM channel_chats WHERE channel_id = ? AND external_id = ?', ch.id, msg.chatId);

  // Linking: "/start 123456", "/link 123456" or just the code.
  const code = (command && ['start', 'link'].includes(command[1]) ? command[2] : !chat ? text : '')?.trim();
  if (!chat) {
    if (code && /^\d{6}$/.test(code)) {
      const fresh = db.get('SELECT * FROM channels WHERE id = ?', ch.id)!;
      if (fresh.pairing_code === code && fresh.pairing_expires_at > now.toISOString()) {
        const owner = db.get("SELECT owner_external_id FROM channel_chats WHERE channel_id = ? AND is_group = 0 LIMIT 1", ch.id)?.owner_external_id;
        // Groups may only be linked by the person who linked the private chat.
        if (msg.isGroup && owner && owner !== msg.senderId) return { text: 'Only the owner of this Carino can link a group.' };
        db.insert('channel_chats', { user_id: ch.user_id, channel_id: ch.id, external_id: msg.chatId, owner_external_id: msg.senderId, title: msg.chatTitle.slice(0, 120), is_group: msg.isGroup ? 1 : 0 });
        db.run('UPDATE channels SET pairing_code = NULL, pairing_expires_at = NULL WHERE id = ?', ch.id);
        const name = getSettings(db, ch.user_id).profile.assistantName || 'Carino';
        return {
          text: msg.isGroup
            ? `Hi everyone, I'm ${name}. Mention me or reply to my messages and I'll help — tasks, reminders, notes, lists, places and quick answers. I don't share private information here. ${HELP}`
            : `All set — this chat is linked to your ${name}. Message me any time, send voice notes or photos. ${HELP}`,
        };
      }
      return { text: 'That code is wrong or has expired. Open Carino → Messaging to get a new one.' };
    }
    if (msg.isGroup && !msg.addressed) return null;
    return { text: 'This chat isn’t linked to a Carino account. In Carino, open Messaging, get a code, and send it here.' };
  }

  if (command?.[1] === 'stop') {
    db.run('UPDATE channel_chats SET muted = 1 WHERE id = ?', chat.id);
    return { text: 'OK, I’ll stay quiet in this chat. Send /start when you want me back.' };
  }
  if (command?.[1] === 'start') {
    db.run('UPDATE channel_chats SET muted = 0 WHERE id = ?', chat.id);
    return { text: 'I’m back. How can I help?' };
  }
  if (command?.[1] === 'help') return { text: HELP };
  if (chat.muted) return null;
  if (msg.isGroup && !msg.addressed) return null;
  // A private chat answers only the account that linked it.
  if (!msg.isGroup && chat.owner_external_id && chat.owner_external_id !== msg.senderId) return null;
  if (!text && !msg.attachments?.length) return null;

  const user = db.get('SELECT id, email, name FROM users WHERE id = ?', ch.user_id);
  if (!user) return null;
  const { runTurn, buildSystemPrompt, GROUP_RULES } = await import('../ai/agent.ts');
  let conversationId = chat.conversation_id as string | null;
  if (!conversationId || !db.getOwned('conversations', user.id, conversationId)) {
    const label = ch.kind === 'telegram' ? 'Telegram' : 'WhatsApp';
    const settings = getSettings(db, user.id);
    const conv = db.insert('conversations', {
      user_id: user.id, title: `${label}: ${chat.title || (chat.is_group ? 'group' : 'chat')}`,
      // Frozen like any conversation's prompt; group chats get the group rules on top.
      system_prompt: buildSystemPrompt(user as any, settings) + (chat.is_group ? GROUP_RULES : ''),
    });
    conversationId = conv.id;
    db.run('UPDATE channel_chats SET conversation_id = ? WHERE id = ?', conversationId, chat.id);
    chat = { ...chat, conversation_id: conversationId };
  }
  const started = now.toISOString();
  try {
    const { message } = await runTurn(services, user as any, conversationId!, text || 'I sent you an attachment.', {
      emit: () => {}, attachments: msg.attachments, restricted: !!chat.is_group,
    });
    const reply = plainText(String(message?.content ?? '')) || '(no reply)';
    const approvals = chat.is_group ? [] : db.all(
      "SELECT id, summary FROM actions WHERE user_id = ? AND conversation_id = ? AND status = 'pending' AND created_at >= ? ORDER BY created_at",
      user.id, conversationId, started,
    );
    return { text: msg.transcribedFrom ? `🎙️ “${previewText(text, 300)}”\n\n${reply}` : reply, approvals: approvals.map((a) => ({ id: a.id, summary: a.summary })) };
  } catch (err: any) {
    return { text: `Sorry, I couldn’t answer that: ${String(err?.message ?? 'something went wrong').slice(0, 300)}` };
  }
}

export function setChatMuted(db: Db, userId: string, chatId: string, muted: boolean) {
  const r = db.run('UPDATE channel_chats SET muted = ? WHERE id = ? AND user_id = ?', muted ? 1 : 0, chatId, userId);
  if (Number(r.changes) === 0) throw new HttpError(404, 'Chat not found', 'not_found');
}

export function unlinkChat(db: Db, userId: string, chatId: string) {
  if (!db.deleteOwned('channel_chats', userId, chatId)) throw new HttpError(404, 'Chat not found', 'not_found');
}

export function deleteChannel(db: Db, userId: string, id: string) {
  ownChannel(db, userId, id);
  db.deleteOwned('channels', userId, id);
  return { deleted: true };
}

export { badRequest };
