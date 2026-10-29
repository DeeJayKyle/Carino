import webpush from 'web-push';
import type { Db } from '../db/index.ts';

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export interface PushService {
  configured(): boolean;
  publicKey(): string | null;
  /** Sends to every device the user subscribed. Returns how many deliveries succeeded. */
  sendToUser(userId: string, payload: PushPayload): Promise<{ sent: number; failed: number; errors: string[] }>;
}

/**
 * Standards-based Web Push (VAPID). Free: delivery goes through the browser vendor's
 * push service (Google FCM for Chrome/Android, Mozilla, Microsoft), no paid account needed.
 */
export function createPushService(
  db: Db,
  opts: { publicKey?: string; privateKey?: string; subject: string },
  customSender?: (sub: webpush.PushSubscription, body: string) => Promise<unknown>,
): PushService {
  // A custom sender (used in tests) only needs a public key; real delivery needs both VAPID keys.
  const ok = !!opts.publicKey && (!!opts.privateKey || !!customSender);
  if (ok && !customSender) webpush.setVapidDetails(opts.subject, opts.publicKey!, opts.privateKey!);
  const sender = customSender ?? ((sub: webpush.PushSubscription, body: string) => webpush.sendNotification(sub, body, { TTL: 3600 }));
  return {
    configured: () => ok,
    publicKey: () => (ok ? opts.publicKey! : null),
    async sendToUser(userId, payload) {
      const result = { sent: 0, failed: 0, errors: [] as string[] };
      if (!ok) return result;
      const subs = db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', userId);
      for (const s of subs) {
        try {
          await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
          result.sent++;
        } catch (err: any) {
          result.failed++;
          result.errors.push(String(err?.statusCode ?? err?.message ?? err));
          // 404/410 mean the browser revoked the subscription — clean it up.
          if (err?.statusCode === 404 || err?.statusCode === 410) db.run('DELETE FROM push_subscriptions WHERE id = ?', s.id);
        }
      }
      return result;
    },
  };
}

export function generateVapidKeys() {
  return webpush.generateVAPIDKeys();
}
