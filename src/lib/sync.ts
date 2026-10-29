import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { queueAll, queueDelete, queuePut } from './offline';

/**
 * Offline write queue for tasks and notes. A change that cannot reach the server is stored in
 * IndexedDB with a unique op id and replayed in order when the connection returns. The server
 * runs each op id at most once and refuses edits whose base version is stale (409), which are
 * kept as conflicts for the user to resolve. Deletions and AI actions are never queued.
 */
export interface QueuedOp {
  id: string;
  /** The signed-in user who made the change; ops are only replayed for that user. */
  user: string;
  seq: number;
  method: 'POST' | 'PATCH';
  path: string;
  body: unknown;
  label: string;
  /** "tasks:<id>" / "notes:<id>" for edits, so later edits of the same record follow the first. */
  entity?: string;
  /** updated_at of the record when it was edited offline. */
  base?: string;
  status: 'pending' | 'conflict' | 'failed';
  error?: string;
  current?: any;
}

let currentUser = '';
/** Called by the app shell with the signed-in user's id. */
export function setSyncUser(id: string) {
  currentUser = id;
}

type State = { pending: number; conflicts: QueuedOp[]; failed: QueuedOp[]; syncing: boolean };
let state: State = { pending: 0, conflicts: [], failed: [], syncing: false };
const listeners = new Set<(s: State) => void>();
const emit = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
};

async function refresh() {
  const ops = (await queueAll<QueuedOp>().catch(() => [] as QueuedOp[])).filter((o) => o.user === currentUser);
  emit({ pending: ops.filter((o) => o.status === 'pending').length, conflicts: ops.filter((o) => o.status === 'conflict'), failed: ops.filter((o) => o.status === 'failed') });
  return ops;
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

/**
 * Sends a task/note write now, or queues it if the server cannot be reached.
 * Returns the server response, or `{ queued: true }` when the change was saved for later.
 */
export async function writeOrQueue<T = any>(
  method: QueuedOp['method'], path: string, body: unknown, opts: { label: string; entity?: string; base?: string },
): Promise<T | { queued: true }> {
  const id = newId();
  try {
    return await api<T>(path, { method, body, headers: { 'x-op-id': id } });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 0 || !currentUser) throw err;
    const ops = await queueAll<QueuedOp>();
    await queuePut({ id, user: currentUser, seq: Date.now() * 1000 + ops.length, method, path, body, label: opts.label, entity: opts.entity, base: opts.base, status: 'pending' } satisfies QueuedOp);
    await refresh();
    return { queued: true };
  }
}

export const isQueued = (r: unknown): r is { queued: true } => !!r && (r as any).queued === true;

/** Replays pending ops in order. Stops at the first network failure; keeps conflicts for review. */
export async function syncQueue() {
  if (state.syncing || !currentUser) return;
  emit({ syncing: true });
  try {
    const ops = (await refresh()).filter((o) => o.status === 'pending').sort((a, b) => a.seq - b.seq);
    for (const op of ops) {
      const headers: Record<string, string> = { 'x-op-id': op.id };
      if (op.base) headers['x-base-version'] = op.base;
      try {
        const res: any = await api(op.path, { method: op.method, body: op.body, headers });
        await queueDelete(op.id);
        // Later offline edits of the same record were made on top of this one.
        if (op.entity && res?.updated_at) {
          for (const next of ops) if (next !== op && next.entity === op.entity && next.seq > op.seq) { next.base = res.updated_at; await queuePut(next); }
        }
      } catch (err) {
        if (!(err instanceof ApiError) || err.status === 0 || err.status === 401 || err.status >= 500 || err.status === 429) break;
        const conflict = err.status === 409 && err.code === 'version_conflict';
        await queuePut({ ...op, status: conflict ? 'conflict' : 'failed', error: err.message, current: conflict ? (err as any).data?.current : undefined });
      }
    }
  } finally {
    await refresh();
    emit({ syncing: false });
  }
}

/** Resolves a conflict or failure: drop the offline change, or re-send it over the newer version. */
export async function resolveOp(op: QueuedOp, choice: 'discard' | 'overwrite') {
  await queueDelete(op.id);
  if (choice === 'overwrite') {
    await queuePut({ ...op, id: newId(), base: op.current?.updated_at, status: 'pending', error: undefined, current: undefined });
    await syncQueue();
  }
  await refresh();
}

export function useSyncState() {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    void refresh();
    return () => void listeners.delete(setS);
  }, []);
  return s;
}

/** Starts background replay: now, whenever the browser comes back online, and every 30 s while work is pending. */
export function startSync() {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => void syncQueue());
  setInterval(() => { if (state.pending && navigator.onLine !== false) void syncQueue(); }, 30_000);
  void syncQueue();
}
