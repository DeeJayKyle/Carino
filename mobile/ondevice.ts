// AI that runs on the phone itself, with no internet and no account: a small open model (Qwen 3)
// run by llama.cpp compiled to WebAssembly (wllama). The model is downloaded once from Hugging Face
// and kept in the app's storage. Carino's server talks to it like any OpenAI-compatible service
// (server/ai/openai-compat.ts), through onDeviceFetch below, so tools and streaming work unchanged.
import { Wllama, ModelManager, type Model } from '@wllama/wllama';
import wasmUrl from '@wllama/wllama/esm/wasm/wllama.wasm?url';
import { LOCAL_MODELS, type LocalModel } from './presets.ts';

export { ON_DEVICE_BASE_URL } from './presets.ts';

/** Room for Carino's instructions, a few tools, the chat so far and the reply. */
const CONTEXT_TOKENS = 6144;
const MAX_REPLY_TOKENS = 1024;

export type LocalState =
  | { state: 'idle' }
  | { state: 'downloading'; model: string; loaded: number; total: number }
  | { state: 'loading'; model: string }
  | { state: 'ready'; model: string; threads: number }
  | { state: 'error'; model?: string; error: string };

let status: LocalState = { state: 'idle' };
let manager: ModelManager | null = null;
let engine: Wllama | null = null;
let loadedId: string | null = null;
let loading: Promise<Wllama> | null = null;
let download: { id: string; abort: AbortController; done: Promise<void> } | null = null;
const urlOf = (m: LocalModel) => m.url;
const mm = () => (manager ??= new ModelManager({ allowOffline: true, parallelDownloads: 3 }));
const modelById = (id: string) => LOCAL_MODELS.find((m) => m.id === id);

async function cached(m: LocalModel): Promise<Model | undefined> {
  const list = await mm().getModels().catch(() => [] as Model[]);
  return list.find((x) => x.url === urlOf(m));
}

/** Which models are on the phone, and what the engine is doing. */
export async function localStatus() {
  const models = await Promise.all(LOCAL_MODELS.map(async (m) => ({ ...m, downloaded: !!(await cached(m)) })));
  let storage: { usage?: number; quota?: number } = {};
  try {
    storage = (await navigator.storage?.estimate?.()) ?? {};
  } catch {}
  return {
    models, status,
    threads: threadsAvailable(),
    storage: { free: storage.quota != null && storage.usage != null ? storage.quota - storage.usage : null },
  };
}

export function threadsAvailable() {
  return typeof SharedArrayBuffer !== 'undefined' && (globalThis as any).crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
}

/** Starts downloading a model in the background (resumes nothing; a cancelled download starts again). */
export function startDownload(id: string): LocalState {
  const m = modelById(id);
  if (!m) throw new Error('Unknown model');
  if (download?.id === id) return status;
  download?.abort.abort();
  const abort = new AbortController();
  status = { state: 'downloading', model: id, loaded: 0, total: m.size };
  const done = (async () => {
    try {
      const got = await mm().downloadModel(urlOf(m), {
        signal: abort.signal,
        progressCallback: ({ loaded, total }: { loaded: number; total: number }) => { if (download?.id === id) status = { state: 'downloading', model: id, loaded, total: total || m.size }; },
      } as any);
      if (abort.signal.aborted) return;
      void got;
      status = { state: 'idle' };
    } catch (err: any) {
      if (abort.signal.aborted) {
        status = { state: 'idle' };
        return;
      }
      status = { state: 'error', model: id, error: /quota|space/i.test(String(err?.message)) ? 'Not enough free space on the phone.' : `Download failed: ${err?.message ?? err}. Check the connection and try again.` };
    } finally {
      if (download?.id === id) download = null;
    }
  })();
  download = { id, abort, done };
  return status;
}

export function cancelDownload() {
  download?.abort.abort();
  download = null;
  status = { state: 'idle' };
}

export async function removeModel(id: string) {
  const m = modelById(id);
  if (!m) return;
  if (loadedId === id) await unload();
  await (await cached(m))?.remove();
}

export async function unload() {
  const e = engine;
  engine = null;
  loadedId = null;
  loading = null;
  if (status.state === 'ready' || status.state === 'loading') status = { state: 'idle' };
  await e?.exit().catch(() => undefined);
}

/** Loads the model into memory (once; switching models unloads the other). */
async function ensureLoaded(id: string): Promise<Wllama> {
  if (engine && loadedId === id) return engine;
  if (loading && loadedId === id) return loading;
  await unload();
  const m = modelById(id);
  if (!m) throw httpError(404, `Unknown on-phone model "${id}".`);
  const model = await cached(m);
  if (!model) throw httpError(404, `${m.label} is not downloaded yet. Download it in Settings → AI.`);
  loadedId = id;
  status = { state: 'loading', model: id };
  loading = (async () => {
    const threads = threadsAvailable();
    const w = new Wllama({ default: wasmUrl }, { suppressNativeLog: true, allowOffline: true, modelManager: mm() });
    try {
      await w.loadModel(model, {
        n_ctx: CONTEXT_TOKENS, n_batch: 512, n_threads: threads, n_gpu_layers: 0,
        flash_attn: true, cache_type_k: 'q8_0', cache_type_v: 'q8_0', jinja: true,
        // Qwen 3 can "think" first; on a phone that's too slow, so it answers straight away.
        default_template_kwargs: { enable_thinking: false },
      });
    } catch (err: any) {
      await w.exit().catch(() => undefined);
      loadedId = null;
      loading = null;
      const msg = /memory|alloc|OOM/i.test(String(err?.message)) ? 'The phone ran out of memory loading the model. Try the smaller one.' : `Could not start the model: ${err?.message ?? err}`;
      status = { state: 'error', model: id, error: msg };
      throw httpError(503, msg);
    }
    engine = w;
    status = { state: 'ready', model: id, threads };
    return w;
  })();
  return loading;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const httpError = (s: number, m: string) => new HttpError(s, m);
const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** One reply at a time: the phone runs one model request at once. */
let lock: Promise<void> = Promise.resolve();
function acquire(): Promise<() => void> {
  const prev = lock;
  let release!: () => void;
  lock = new Promise<void>((r) => (release = r));
  return prev.then(() => release);
}

/**
 * fetch() for ON_DEVICE_BASE_URL: answers /chat/completions (streamed, OpenAI format) and /models
 * from the model on the phone. Nothing leaves the phone.
 */
export const onDeviceFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const path = url.pathname.replace(/^\/on-device\/v1/, '');
  if (path === '/models') {
    const s = await localStatus();
    return jsonResponse({ data: s.models.filter((m) => m.downloaded).map((m) => ({ id: m.id })) });
  }
  if (path !== '/chat/completions' || (init?.method ?? 'GET').toUpperCase() !== 'POST') return jsonResponse({ error: { message: 'Not found' } }, 404);
  const body = JSON.parse(String(init?.body ?? '{}'));
  const signal = init?.signal ?? undefined;
  const release = await acquire();
  let chunks: AsyncIterable<any>;
  try {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const w = await ensureLoaded(String(body.model));
    chunks = (await w.createChatCompletion({
      messages: body.messages.map(plainMessage),
      tools: body.tools,
      tool_choice: body.tools?.length ? 'auto' : undefined,
      max_tokens: Math.min(Number(body.max_tokens) || MAX_REPLY_TOKENS, MAX_REPLY_TOKENS),
      temperature: 0.6, top_p: 0.95, top_k: 20,
      chat_template_kwargs: { enable_thinking: false },
      cache_prompt: true,
      stream: true,
      abortSignal: signal,
    } as any)) as unknown as AsyncIterable<any>;
  } catch (err: any) {
    release();
    if (err?.name === 'AbortError') throw err;
    if (err instanceof HttpError) return jsonResponse({ error: { message: err.message } }, err.status);
    return jsonResponse({ error: { message: String(err?.message ?? err) } }, 500);
  }
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      try {
        for await (const chunk of chunks) ctrl.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
        ctrl.close();
      } catch (err: any) {
        if (err?.name === 'AbortError' || signal?.aborted) ctrl.close();
        else ctrl.error(err);
      } finally {
        release();
      }
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

/** The on-phone model reads text only: image parts are dropped (it can't see photos). */
function plainMessage(m: any) {
  if (!Array.isArray(m.content)) return m;
  const text = m.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n');
  const hadImage = m.content.some((p: any) => p?.type === 'image_url');
  return { ...m, content: hadImage ? `${text}\n\n(A photo was attached, but the on-phone model can't see photos.)` : text };
}
