import { randomBytes } from 'node:crypto';
import type { Services } from '../context.ts';
import { badRequest } from '../context.ts';
import type { Row } from '../db/index.ts';
import { parseJson } from '../db/index.ts';
import { channelSecret, saveChannel } from './channels.ts';
import { helperConfig, helperGet, helperPost } from './helper.ts';
import { processWhatsAppPayload, type WaConfig } from './whatsapp.ts';

/**
 * WhatsApp on Carino's shared number: the user sends a 6-digit code to Carino's
 * number from their WhatsApp, and that number is linked to this phone. The sign-in helper
 * (auth/worker.js) holds the number; it keeps each linked person's messages for their own phone,
 * which collects them with its key, and passes replies back only to that person.
 */
type Secret = { hub_key: string };

export const isShared = (ch: Row) => parseJson<WaConfig>(ch.config, {} as WaConfig).mode === 'shared';
export const sharedKey = (services: Services, ch: Row) => channelSecret<Secret>(services, ch)?.hub_key ?? null;

/** Starts linking: a code to send from WhatsApp, and a link that opens the chat with it typed in. */
export async function startSharedLink(services: Services, userId: string) {
  const helper = await helperConfig(services);
  if (!helper?.whatsapp) throw badRequest('Carino’s shared WhatsApp number isn’t available right now.');
  const existing = services.db.get("SELECT * FROM channels WHERE user_id = ? AND kind = 'whatsapp'", userId);
  // Keep the key if this phone already uses the shared number (re-linking moves the number here).
  const key = existing && isShared(existing) ? sharedKey(services, existing) ?? randomBytes(32).toString('base64url') : randomBytes(32).toString('base64url');
  const { code } = await helperPost<{ code: string }>(services, '/wa/register', {}, key).catch((e: any) => { throw badRequest(e.message); });
  const number = helper.whatsapp.number ?? '';
  const ch = saveChannel(services, userId, 'whatsapp', { hub_key: key } satisfies Secret, {
    mode: 'shared', phone_number_id: 'shared', verify_token: '', display_phone: number,
    transcribe_voice: existing ? parseJson<WaConfig>(existing.config, {} as WaConfig).transcribe_voice : undefined,
  } satisfies WaConfig);
  const digits = number.replace(/\D/g, '');
  return { channel_id: ch.id as string, code, number, link: digits ? `https://wa.me/${digits}?text=${code}` : null };
}

/** Whether the code has been sent; once linked, the chat is set up here like any linked chat. */
export async function sharedLinkStatus(services: Services, userId: string) {
  const ch = services.db.get("SELECT * FROM channels WHERE user_id = ? AND kind = 'whatsapp'", userId);
  if (!ch || !isShared(ch)) return { linked: false };
  const key = sharedKey(services, ch);
  if (!key) return { linked: false };
  const res = await helperGet<Response>(services, '/wa/status', key).catch(() => null);
  const s: any = res ? await res.json().catch(() => ({})) : {};
  if (!s.linked) return { linked: false };
  const chat = services.db.get('SELECT id FROM channel_chats WHERE channel_id = ? AND external_id = ?', ch.id, s.wa_id);
  if (!chat) {
    // One phone per number: the shared chat is this person's private chat.
    services.db.run('DELETE FROM channel_chats WHERE channel_id = ?', ch.id);
    services.db.insert('channel_chats', { user_id: userId, channel_id: ch.id, external_id: s.wa_id, owner_external_id: s.wa_id, title: s.name || 'WhatsApp', is_group: 0 });
  }
  return { linked: true, wa_id: s.wa_id as string };
}

export async function unlinkShared(services: Services, ch: Row) {
  const key = sharedKey(services, ch);
  if (key) await helperPost(services, '/wa/unlink', {}, key).catch(() => undefined);
}

/** Replies go through the helper, which sends them only to this phone's linked number. */
export async function sendShared(services: Services, ch: Row, text: string, buttons?: { id: string; title: string }[]) {
  const key = sharedKey(services, ch);
  if (!key) throw new Error('The WhatsApp link on this phone can no longer be read. Link WhatsApp again.');
  await helperPost(services, '/wa/send', { text, buttons }, key);
}

/** A voice note or photo sent by the linked number, fetched through the helper. */
export async function sharedMedia(services: Services, ch: Row, id: string, maxBytes: number) {
  const key = sharedKey(services, ch);
  if (!key) throw new Error('The WhatsApp link on this phone can no longer be read.');
  const res = await helperGet<Response>(services, `/wa/media/${encodeURIComponent(id)}`, key);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('That file is too large.');
  return { buf, mime: res.headers.get('content-type') ?? 'application/octet-stream' };
}


/** Collects and answers this phone's waiting messages on the shared number. */
export async function pollShared(services: Services, ch: Row) {
  const key = sharedKey(services, ch);
  if (!key) return 0;
  const res = await helperGet<Response>(services, '/wa/inbox', key);
  const { items = [] } = (await res.json()) as { items?: { id: number; from: string; name: string; message: any }[] };
  if (!items.length) return 0;
  // A message can arrive before the app noticed the link (e.g. the code was sent while it was closed).
  if (!services.db.get('SELECT 1 FROM channel_chats WHERE channel_id = ?', ch.id)) await sharedLinkStatus(services, ch.user_id);
  // Acknowledged only once handled (see whatsapp-relay.ts); answered messages are remembered by id.
  const done: number[] = [];
  let failure: unknown = null;
  for (const item of items) {
    try {
      // The same shape as a delivery from Meta (the helper already checked Meta's signature).
      await processWhatsAppPayload(services, ch, {
        entry: [{ changes: [{ value: { contacts: [{ wa_id: item.from, profile: { name: item.name } }], messages: [item.message] } }] }],
      });
    } catch (e) {
      failure = e;
      break;
    }
    done.push(item.id);
  }
  if (done.length) await helperPost(services, '/wa/ack', { ids: done }, key);
  if (failure) throw failure;
  return done.length;
}
