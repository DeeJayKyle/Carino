// Bridge to the Android app (android/app/src/main/java/app/carino/android/NativeBridge.java).
// In a normal browser (development) every call falls back to a web equivalent or does nothing.
import { Buffer } from './buffer.ts';

interface Bridge {
  httpStart(id: string, request: string): void;
  httpAbort(id: string): void;
  notify(json: string): void;
  setAlarms(json: string): void;
  setPlaceAlerts?(json: string): void;
  setWidgetData?(json: string): void;
  takeReminderEvents?(): string;
  placesPermission?(): string;
  askPlacesPermission?(): void;
  listen(lang: string): void;
  stopListening(): void;
  speak(text: string, lang: string): void;
  stopSpeaking(): void;
  saveFile(name: string, mime: string, base64: string): string;
  shareFile(name: string, mime: string, base64: string, text: string): void;
  shareText(text: string): void;
  takeShared(): string;
  openExternal(url: string): void;
  oauthListen(): string;
  keepListening(on: boolean): void;
  appInfo(): string;
}

const bridge = (globalThis as any).CarinoNative as Bridge | undefined;
export const isNative = !!bridge;

type Pending = {
  head: (status: number, headers: [string, string][]) => void;
  chunk: (bytes: Uint8Array) => void;
  end: () => void;
  fail: (message: string) => void;
};
const pending = new Map<string, Pending>();
let speechListener: ((e: { partial?: string; final?: string; error?: string; end?: boolean }) => void) | null = null;
let speakDone: (() => void) | null = null;

// Java calls these through evaluateJavascript.
(globalThis as any).__hn = {
  head: (id: string, status: number, headers: string) => pending.get(id)?.head(status, JSON.parse(headers)),
  chunk: (id: string, b64: string) => pending.get(id)?.chunk(Buffer.from(b64, 'base64')),
  end: (id: string) => pending.get(id)?.end(),
  error: (id: string, message: string) => pending.get(id)?.fail(message),
  speech: (json: string) => speechListener?.(JSON.parse(json)),
  spoke: () => {
    const d = speakDone;
    speakDone = null;
    d?.();
  },
  open: (url: string) => window.dispatchEvent(new CustomEvent('carino-open', { detail: url })),
  shared: () => window.dispatchEvent(new Event('carino-shared')),
  // A sign-in came back from the browser (query string from the loopback listener).
  oauth: (query: string) => window.dispatchEvent(new CustomEvent('carino-oauth', { detail: query })),
  // The background listener's nudge to collect new messages while the app is hidden.
  tick: () => window.dispatchEvent(new Event('carino-tick')),
};

let seq = 0;

/**
 * fetch() for the outside world. On the phone it goes through Android's own HTTP stack, which
 * isn't limited by browser CORS rules (AI providers, Telegram, connectors…) and streams replies.
 */
export function makeNetFetch(webFetch: typeof fetch): typeof fetch {
  if (!bridge) return webFetch;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const id = `h${++seq}`;
    const body = req.method === 'GET' || req.method === 'HEAD' ? '' : Buffer.from(await req.arrayBuffer()).toString('base64');
    const headers: [string, string][] = [];
    req.headers.forEach((v, k) => headers.push([k, v]));
    return new Promise<Response>((resolve, reject) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let settled = false;
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => void (controller = c),
        cancel: () => {
          pending.delete(id);
          bridge.httpAbort(id);
        },
      });
      const abort = () => {
        bridge.httpAbort(id);
        const err = new DOMException('The request was aborted', 'AbortError');
        if (!settled) reject(err);
        else try { controller.error(err); } catch {}
        pending.delete(id);
      };
      if (req.signal.aborted) return abort();
      req.signal.addEventListener('abort', abort, { once: true });
      pending.set(id, {
        head: (status, h) => {
          settled = true;
          const noBody = status === 204 || status === 304 || req.method === 'HEAD';
          resolve(new Response(noBody ? null : stream, { status, headers: h.filter(([k]) => k.toLowerCase() !== 'set-cookie') }));
        },
        chunk: (bytes) => controller.enqueue(bytes),
        end: () => {
          pending.delete(id);
          req.signal.removeEventListener('abort', abort);
          try { controller.close(); } catch {}
        },
        fail: (message) => {
          pending.delete(id);
          req.signal.removeEventListener('abort', abort);
          const err = new TypeError(`Network request failed: ${message}`);
          if (!settled) reject(err);
          else try { controller.error(err); } catch {}
        },
      });
      bridge.httpStart(id, JSON.stringify({ method: req.method, url: req.url, headers, body, redirect: req.redirect }));
    });
  };
}

export interface Notice {
  tag: string;
  title: string;
  body: string;
  url?: string;
}

export function notify(n: Notice) {
  if (bridge) bridge.notify(JSON.stringify(n));
  else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(n.title, { body: n.body, tag: n.tag });
}

/** Replaces the alarms Android shows while the app is closed. */
export function setAlarms(alarms: (Notice & { at: number })[]) {
  bridge?.setAlarms(JSON.stringify(alarms));
}

/** Today's to-dos and next reminder for the home-screen widget. */
export function setWidgetData(data: { total: number; overdue: number; todos: string[]; next: { title: string; at: number } | null }) {
  bridge?.setWidgetData?.(JSON.stringify(data));
}

/** Replaces the places Android watches for place reminders. */
export function setPlaceAlerts(alerts: { id: string; title: string; body: string; lat: number; lon: number; radius: number }[]) {
  bridge?.setPlaceAlerts?.(JSON.stringify(alerts));
}

export interface ReminderEvent { type: 'snooze' | 'done' | 'arrived'; id: string; at: number; minutes?: number }

/** Snooze / Done pressed on notifications, and places arrived at, while the app was closed. */
export function takeReminderEvents(): ReminderEvent[] {
  try {
    return JSON.parse(bridge?.takeReminderEvents?.() ?? '[]');
  } catch {
    return [];
  }
}

/** Location access for place reminders: "always", "while-open", "no", or "web" (no Android). */
export function placesPermission(): string {
  return bridge?.placesPermission?.() ?? 'web';
}

/** Asks Android for location; resolves with the new state. */
export function askPlacesPermission(): Promise<string> {
  if (!bridge?.askPlacesPermission) return Promise.resolve('web');
  return new Promise((ok) => {
    const done = (e: Event) => { removeEventListener('carino-location', done); ok(String((e as CustomEvent).detail)); };
    addEventListener('carino-location', done);
    bridge.askPlacesPermission!();
  });
}

export const nativeSpeech = !!bridge;

export function listen(lang: string, onEvent: NonNullable<typeof speechListener>) {
  speechListener = onEvent;
  bridge?.listen(lang);
}

export function stopListening() {
  bridge?.stopListening();
}

export function speakNative(text: string, lang: string, done?: () => void) {
  speakDone = done ?? null;
  bridge?.speak(text, lang);
}

export function stopSpeakingNative() {
  speakDone = null;
  bridge?.stopSpeaking();
}

/** Saves a file to the phone's Downloads folder. Returns a message to show. */
export async function saveFile(blob: Blob, name: string) {
  if (!bridge) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    return `Downloaded ${name}`;
  }
  return bridge.saveFile(name, blob.type || 'application/octet-stream', Buffer.from(await blob.arrayBuffer()).toString('base64'));
}

/** Opens the phone's share sheet with a file (e.g. a sticker for WhatsApp). Returns a message, if any. */
export async function shareFile(blob: Blob, name: string, text = '') {
  if (bridge) {
    bridge.shareFile(name, blob.type || 'application/octet-stream', Buffer.from(await blob.arrayBuffer()).toString('base64'), text);
    return null;
  }
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], text }).catch(() => undefined);
    return null;
  }
  return saveFile(blob, name);
}

/** Opens the share sheet with text, e.g. to send a reply on WhatsApp. */
export async function shareText(text: string) {
  if (bridge) return bridge.shareText(text);
  const nav = navigator as Navigator & { share?: Navigator['share'] };
  if (nav.share) return void (await nav.share({ text }).catch(() => undefined));
  await navigator.clipboard?.writeText(text);
}

export interface SharedItem {
  title: string;
  text: string;
  url: string;
  files: { name: string; type: string; data: string }[];
}

/** What another app shared into this one, if anything (taken once). */
export function takeShared(): SharedItem | null {
  if (!bridge) return null;
  const raw = bridge.takeShared();
  return raw ? (JSON.parse(raw) as SharedItem) : null;
}

export function openExternal(url: string) {
  if (bridge) bridge.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

/**
 * Opens a sign-in page in the phone's browser. The browser comes back to a loopback address the
 * app listens on; the result arrives as a "carino-oauth" event. Returns an error message, if any.
 */
export function openSignIn(url: string): string | null {
  if (!bridge) {
    window.location.href = url;
    return null;
  }
  const error = bridge.oauthListen();
  if (error) return error;
  bridge.openExternal(url);
  return null;
}

/** Keeps answering WhatsApp and Telegram while the app is in the background (ongoing notification). */
export function keepListening(on: boolean) {
  bridge?.keepListening(on);
}

export function appInfo(): { version: string; flavor: string } {
  if (!bridge) return { version: 'dev', flavor: 'web' };
  return JSON.parse(bridge.appInfo());
}
