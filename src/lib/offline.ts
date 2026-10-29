/**
 * Small IndexedDB store: a read cache so previously loaded notes, tasks, projects and the
 * dashboard can be read offline, and a queue of task/note changes made offline (see sync.ts).
 * The server stays the source of truth; queued changes are replayed through the normal API.
 */
const DB_NAME = 'carino-cache';
const STORE = 'kv';
const QUEUE = 'queue';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      if (!req.result.objectStoreNames.contains(QUEUE)) req.result.createObjectStore(QUEUE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheSet(key: string, value: unknown) {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ value, savedAt: Date.now() }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* storage unavailable (private mode etc.) — caching is best-effort */
  }
}

export async function cacheGet<T>(key: string): Promise<{ value: T; savedAt: number } | null> {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function cacheClear() {
  try {
    const db = await open();
    const tx = db.transaction([STORE, QUEUE], 'readwrite');
    tx.objectStore(STORE).clear();
    tx.objectStore(QUEUE).clear();
  } catch {
    /* ignore */
  }
}

async function queueTx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE, mode);
    const req = fn(tx.objectStore(QUEUE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

export const queuePut = <T extends { id: string }>(op: T) => queueTx('readwrite', (s) => s.put(op)).then(() => undefined);
export const queueDelete = (id: string) => queueTx('readwrite', (s) => s.delete(id)).then(() => undefined);
export const queueAll = <T>() => queueTx<T[]>('readonly', (s) => s.getAll() as IDBRequest<T[]>).then((r) => r ?? []);
