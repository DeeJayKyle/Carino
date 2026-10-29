import { shrinkImage } from './images';

/** Fetch wrapper for the Carino API. Sends the CSRF header and turns errors into ApiError. */
/** Lets API calls through free tunnel services (ngrok) without their browser warning page. */
const TUNNEL_HEADERS = { 'ngrok-skip-browser-warning': '1' };

export class ApiError extends Error {
  status: number;
  code: string;
  retryable: boolean;
  constructor(status: number, message: string, code = 'error', retryable = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData; signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<T> {
  const headers: Record<string, string> = { ...opts.headers, 'x-carino': '1', ...TUNNEL_HEADERS };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, signal: opts.signal, credentials: 'same-origin' });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, isOffline() ? 'You are offline. This needs an internet connection.' : 'Could not reach the Carino server. Check your connection and try again.', 'network', true);
  }
  if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/me')) onUnauthorized?.();
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const d = data as any;
    const e = new ApiError(res.status, d?.error ?? `Request failed (${res.status})`, d?.code, d?.retryable ?? res.status >= 500);
    (e as any).data = d;
    throw e;
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'POST', body: body ?? {} });
export const patch = <T = any>(p: string, body: unknown) => api<T>(p, { method: 'PATCH', body });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });

/** POSTs and reads a Server-Sent Events stream, calling onEvent for each event. */
export async function streamPost(path: string, body: unknown, onEvent: (event: string, data: any) => void, signal?: AbortSignal) {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: 'POST', headers: { 'x-carino': '1', ...TUNNEL_HEADERS, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body), signal, credentials: 'same-origin',
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, isOffline() ? 'You are offline — Carino needs a connection to reply.' : 'Could not reach the Carino server.', 'network', true);
  }
  if (!res.ok || !res.body) {
    const d = await res.json().catch(() => ({}));
    if (res.status === 401) onUnauthorized?.();
    throw new ApiError(res.status, d?.error ?? `Request failed (${res.status})`, d?.code, d?.retryable ?? res.status >= 500);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue;
      try {
        onEvent(event, JSON.parse(data.join('\n')));
      } catch {
        /* ignore malformed event */
      }
    }
  }
}

export async function upload(file: File, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.append('file', await shrinkImage(file));
  for (const [k, v] of Object.entries(extra)) if (v) form.append(k, v);
  return api<{ document: any; chunks: number }>('/documents', { method: 'POST', form });
}
