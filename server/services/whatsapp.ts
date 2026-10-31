import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Services } from '../context.ts';
import { badRequest } from '../context.ts';
import type { Row } from '../db/index.ts';
import { parseJson } from '../db/index.ts';
import { handleIncoming, channelSecret, saveChannel, type Incoming, type Outgoing } from './channels.ts';
import { transcribe, TranscribeError } from './transcribe.ts';
import { storeDocument, MAX_IMAGE_BYTES } from './documents.ts';
import { getSettings } from './settings.ts';

/**
 * WhatsApp through Meta's WhatsApp Business Cloud API. Conversations the user starts are free
 * (service conversations). Meta delivers messages to a webhook on Carino's public address,
 * signed with the app secret; Carino answers through the Graph API.
 */
const GRAPH = 'https://graph.facebook.com/v23.0';
type Secret = { access_token: string; app_secret: string };
export type WaConfig = { phone_number_id: string; verify_token: string; display_phone?: string; transcribe_voice?: boolean; /** Phone app: the user's relay (see whatsapp-relay.ts). */ relay_url?: string; /** Carino's shared number (see whatsapp-shared.ts). */ mode?: 'shared' };

export class WhatsAppError extends Error {}

async function graph<T = any>(services: Services, token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const f = services.netFetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${GRAPH}/${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new WhatsAppError('Could not reach WhatsApp (Meta Graph API).');
  }
  const data = (await res.json().catch(() => ({}))) as any;
  if (res.status === 401 || data?.error?.code === 190) throw new WhatsAppError('WhatsApp rejected the access token. Create a new one in Meta’s app dashboard.');
  if (!res.ok) throw new WhatsAppError(`WhatsApp: ${data?.error?.message ?? `error ${res.status}`}`);
  return data as T;
}

export async function connectWhatsApp(services: Services, userId: string, i: { phone_number_id: string; access_token: string; app_secret: string }) {
  if (!/^\d{5,30}$/.test(i.phone_number_id.trim())) throw badRequest('The phone number ID is the long number shown under “API Setup” in Meta’s dashboard (not the phone number itself).');
  if (i.app_secret.trim().length < 16) throw badRequest('Paste the App secret from your Meta app’s Settings → Basic.');
  let info: { display_phone_number?: string };
  try {
    info = await graph(services, i.access_token.trim(), `${i.phone_number_id.trim()}?fields=display_phone_number`);
  } catch (e: any) {
    throw badRequest(e.message);
  }
  const existing = services.db.get("SELECT config, secret FROM channels WHERE user_id = ? AND kind = 'whatsapp'", userId);
  const prev = parseJson<WaConfig | null>(existing?.config, null);
  const verify = prev?.verify_token ?? randomBytes(18).toString('base64url');
  const relayKey = existing ? channelSecret<Secret & { relay_key?: string }>(services, existing as Row)?.relay_key : undefined;
  return saveChannel(services, userId, 'whatsapp', { access_token: i.access_token.trim(), app_secret: i.app_secret.trim(), ...(relayKey ? { relay_key: relayKey } : {}) }, {
    phone_number_id: i.phone_number_id.trim(), verify_token: verify, display_phone: info.display_phone_number ?? '',
    ...(prev?.relay_url ? { relay_url: prev.relay_url } : {}),
  } satisfies WaConfig);
}

export function webhookUrl(services: Services, ch: Row) {
  const relay = parseJson<WaConfig>(ch.config, {} as WaConfig).relay_url;
  if (relay) return `${relay}/webhook`;
  if (services.deviceSession) return undefined;
  return `${services.config.PUBLIC_URL.replace(/\/$/, '')}/hooks/whatsapp/${ch.id}`;
}

/** Meta's one-time webhook check: echo the challenge if the verify token matches. */
export function verifyWebhook(ch: Row, q: Record<string, string | undefined>) {
  const cfg = parseJson<WaConfig>(ch.config, {} as WaConfig);
  if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && q['hub.verify_token'] === cfg.verify_token) return q['hub.challenge'] ?? '';
  return null;
}

export function signatureValid(services: Services, ch: Row, raw: string, header: string | undefined) {
  const secret = channelSecret<Secret>(services, ch);
  if (!secret || !header?.startsWith('sha256=')) return false;
  const want = Buffer.from(createHmac('sha256', secret.app_secret).update(raw).digest('hex'));
  const got = Buffer.from(header.slice(7));
  return want.length === got.length && timingSafeEqual(want, got);
}

export async function sendWhatsApp(services: Services, ch: Row, to: string, out: Outgoing) {
  const cfg = parseJson<WaConfig>(ch.config, {} as WaConfig);
  if (cfg.mode === 'shared') {
    const { sendShared } = await import('./whatsapp-shared.ts');
    for (const body of out.text.match(/[\s\S]{1,4000}(?=\s|$)|[\s\S]{1,4000}/g) ?? [out.text]) await sendShared(services, ch, body);
    for (const a of out.approvals?.slice(0, 5) ?? []) await sendShared(services, ch, `Approve this? ${a.summary}`.slice(0, 1000), [{ id: `ok:${a.id}`, title: 'Approve' }, { id: `no:${a.id}`, title: 'Decline' }]);
    return;
  }
  const secret = channelSecret<Secret>(services, ch);
  if (!secret) throw new WhatsAppError('The saved WhatsApp token can no longer be read. Connect WhatsApp again.');
  const parts = out.text.match(/[\s\S]{1,4000}(?=\s|$)|[\s\S]{1,4000}/g) ?? [out.text];
  for (const body of parts) {
    await graph(services, secret.access_token, `${cfg.phone_number_id}/messages`, { method: 'POST', body: { messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: false } } });
  }
  for (const a of out.approvals?.slice(0, 5) ?? []) {
    await graph(services, secret.access_token, `${cfg.phone_number_id}/messages`, {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp', to, type: 'interactive',
        interactive: {
          type: 'button', body: { text: `Approve this? ${a.summary}`.slice(0, 1000) },
          action: { buttons: [{ type: 'reply', reply: { id: `ok:${a.id}`, title: 'Approve' } }, { type: 'reply', reply: { id: `no:${a.id}`, title: 'Decline' } }] },
        },
      },
    });
  }
}

async function media(services: Services, token: string, id: string, maxBytes: number) {
  const meta = await graph<{ url?: string; mime_type?: string; file_size?: number }>(services, token, id);
  if (!meta.url) throw new WhatsAppError('WhatsApp did not return the file.');
  if ((meta.file_size ?? 0) > maxBytes) throw new WhatsAppError('That file is too large.');
  const f = services.netFetch ?? fetch;
  const res = await f(meta.url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new WhatsAppError('Could not download the file from WhatsApp.');
  return { buf: Buffer.from(await res.arrayBuffer()), mime: meta.mime_type ?? 'application/octet-stream' };
}

/** Webhook work runs after Meta gets its quick 200; tests await this to see the result. */
const inflight = new Set<Promise<unknown>>();
export function queueWhatsApp(services: Services, ch: Row, payload: any) {
  const p = processWhatsAppPayload(services, ch, payload).finally(() => inflight.delete(p));
  inflight.add(p);
}
export const whatsappIdle = () => Promise.all([...inflight]);

/** Handles one webhook delivery (already signature-checked). Exported for tests. */
export async function processWhatsAppPayload(services: Services, ch: Row, payload: any) {
  const secret = channelSecret<Secret>(services, ch);
  if (!secret) return;
  const cfg = parseJson<WaConfig>(ch.config, {} as WaConfig);
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (value?.metadata?.phone_number_id && value.metadata.phone_number_id !== cfg.phone_number_id) continue;
      const names = new Map<string, string>((value?.contacts ?? []).map((c: any) => [String(c.wa_id), String(c.profile?.name ?? '')]));
      for (const m of value?.messages ?? []) {
        const from = String(m.from ?? '');
        if (!from) continue;
        try {
          await handleOne(services, ch, secret, cfg, m, from, names.get(from) ?? from);
        } catch (err: any) {
          console.error('[whatsapp]', err?.message ?? err);
        }
      }
    }
  }
}

async function handleOne(services: Services, ch: Row, secret: Secret, cfg: WaConfig, m: any, from: string, name: string) {
  const { db } = services;
  const fetchMedia = async (id: string, max: number) => {
    if (cfg.mode !== 'shared') return media(services, secret.access_token, id, max);
    const { sharedMedia } = await import('./whatsapp-shared.ts');
    return sharedMedia(services, ch, id, max);
  };
  const chat = db.get('SELECT * FROM channel_chats WHERE channel_id = ? AND external_id = ?', ch.id, from);
  // Approve / Decline buttons.
  const button = m.interactive?.button_reply?.id ?? m.button?.payload;
  if (button) {
    const b = String(button).match(/^(ok|no):([0-9a-f-]{36})$/);
    if (!b || !chat) return;
    const { approveAction, rejectAction } = await import('../tools/registry.ts');
    try {
      if (b[1] === 'ok') {
        const r = await approveAction(services, ch.user_id, b[2]);
        await sendWhatsApp(services, ch, from, { text: r.status === 'executed' ? `Done: ${r.summary}` : `That failed: ${r.status === 'error' ? r.error : ''}` });
      } else {
        rejectAction(services, ch.user_id, b[2]);
        await sendWhatsApp(services, ch, from, { text: 'Declined.' });
      }
    } catch (e: any) {
      await sendWhatsApp(services, ch, from, { text: String(e?.message ?? 'Could not do that.') });
    }
    return;
  }
  const incoming: Incoming = { chatId: from, senderId: from, chatTitle: name, isGroup: false, addressed: true, text: String(m.text?.body ?? m.image?.caption ?? m.document?.caption ?? '') };
  try {
    if (chat && !chat.muted) {
      if (m.type === 'audio' && m.audio?.id && cfg.transcribe_voice !== false) {
        const { buf, mime } = await fetchMedia(m.audio.id, 20 * 1024 * 1024);
        incoming.text = await transcribe(services, buf, 'voice.ogg', mime.split(';')[0], getSettings(db, ch.user_id).voice.language);
        incoming.transcribedFrom = 'voice note';
      }
      const file = m.type === 'image' ? m.image : m.type === 'document' ? m.document : null;
      if (file?.id) {
        const { buf, mime } = await fetchMedia(file.id, m.type === 'image' ? MAX_IMAGE_BYTES : 20 * 1024 * 1024);
        const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
        const filename = file.filename || `whatsapp-photo.${ext}`;
        const { doc } = await storeDocument(db, services.config.DATA_DIR, ch.user_id, { name: filename, buf }, { tags: ['whatsapp'] }, services.config.MAX_UPLOAD_MB * 1024 * 1024);
        incoming.attachments = [doc.id];
      }
    }
  } catch (e: any) {
    await sendWhatsApp(services, ch, from, { text: e instanceof TranscribeError || e instanceof WhatsAppError || e?.status ? e.message : 'Could not read that attachment.' });
    return;
  }
  const out = await handleIncoming(services, ch, incoming);
  if (out) await sendWhatsApp(services, ch, from, out);
}
