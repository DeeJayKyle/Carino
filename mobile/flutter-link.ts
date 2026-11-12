/**
 * The link between Carino's engine and its Flutter screens (app/, Flutter edition). Flutter sends
 * API requests in through window.__carinoFlutter.request; replies go back through the
 * CarinoFlutter.post JavaScript interface that the Android app adds. Streamed replies (chat) are
 * passed on piece by piece; files come back base64-encoded. Only present inside the Flutter app.
 */

export interface LinkRequest {
  id: string;
  method: string;
  /** Path under /api, e.g. "/tasks?view=today". */
  path: string;
  body?: unknown;
  /** A file upload: multipart form with these files (base64) and fields. */
  upload?: { files: { field: string; name: string; mime: string; b64: string }[]; fields?: Record<string, string> };
}

type Post = (msg: Record<string, unknown>) => void;

function b64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function makeLink(handle: (req: Request) => Promise<Response>, post: Post, origin: string) {
  const running = new Map<string, AbortController>();
  async function request(json: string) {
    let r: LinkRequest;
    try {
      r = JSON.parse(json);
    } catch {
      return;
    }
    const ac = new AbortController();
    running.set(r.id, ac);
    try {
      const headers: Record<string, string> = { 'x-carino': '1' };
      let body: BodyInit | undefined;
      if (r.upload) {
        const form = new FormData();
        for (const [k, v] of Object.entries(r.upload.fields ?? {})) form.append(k, v);
        for (const f of r.upload.files) form.append(f.field, new Blob([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], { type: f.mime }), f.name);
        body = form;
      } else if (r.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(r.body);
      }
      if (!r.path.startsWith('/')) throw new Error('Bad path');
      const res = await handle(new Request(`${origin}/api${r.path}`, { method: r.method, headers, body, signal: ac.signal }));
      const type = res.headers.get('content-type') ?? '';
      if (type.includes('text/event-stream') && res.body) {
        post({ id: r.id, type: 'head', status: res.status });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = dec.decode(value, { stream: true });
          if (text) post({ id: r.id, type: 'chunk', text });
        }
        post({ id: r.id, type: 'end' });
      } else if (/json|text|xml|calendar/.test(type) || !type) {
        post({ id: r.id, type: 'done', status: res.status, contentType: type, body: await res.text() });
      } else {
        const disp = res.headers.get('content-disposition') ?? '';
        post({ id: r.id, type: 'done', status: res.status, contentType: type, b64: b64(new Uint8Array(await res.arrayBuffer())), filename: /filename="?([^";]+)/.exec(disp)?.[1] });
      }
    } catch (e: any) {
      post({ id: r.id, type: 'error', message: e?.name === 'AbortError' ? 'aborted' : String(e?.message ?? e) });
    } finally {
      running.delete(r.id);
    }
  }
  return {
    request,
    abort: (id: string) => running.get(id)?.abort(),
  };
}

/** Starts the link when running inside the Flutter app. */
export function startFlutterLink(handle: (req: Request) => Promise<Response>) {
  const native = (globalThis as any).CarinoFlutter;
  if (!native?.post) return false;
  const post: Post = (m) => native.post(JSON.stringify(m));
  (globalThis as any).__carinoFlutter = makeLink(handle, post, location.origin);
  post({ type: 'ready' });
  return true;
}
