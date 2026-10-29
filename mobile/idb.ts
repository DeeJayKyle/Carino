// A few promise helpers over IndexedDB, where the phone app keeps its database and files.
const DB_NAME = 'carino-device';
let opened: Promise<IDBDatabase> | null = null;

function open() {
  opened ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of ['db', 'files', 'sizes', 'kv']) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opened;
}

function done<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T = unknown>(store: string, key: string): Promise<T | undefined> {
  const db = await open();
  return done(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function idbEntries<T = unknown>(store: string): Promise<[string, T][]> {
  const db = await open();
  const os = db.transaction(store).objectStore(store);
  const [keys, values] = await Promise.all([done(os.getAllKeys()), done(os.getAll())]);
  return keys.map((k, i) => [String(k), values[i] as T]);
}

/** Writes several stores in one transaction; undefined deletes the key. */
export async function idbWrite(changes: { store: string; key: string; value: unknown }[]) {
  if (!changes.length) return;
  const db = await open();
  const tx = db.transaction([...new Set(changes.map((c) => c.store))], 'readwrite');
  for (const c of changes) {
    const os = tx.objectStore(c.store);
    if (c.value === undefined) os.delete(c.key);
    else os.put(c.value, c.key);
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Closes the connection and deletes everything stored. */
export async function idbDeleteAll() {
  if (opened) (await opened).close();
  opened = null;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
