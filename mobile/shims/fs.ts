// Browser stand-in for node:fs. Files live in memory and are saved to IndexedDB in the
// background. Large files load on demand: call preloadFiles() before reading them.
import { Buffer } from '../buffer.ts';
import { idbEntries, idbGet, idbWrite } from '../idb.ts';

const EAGER_MAX = 1024 * 1024;
const files = new Map<string, Uint8Array | null>(); // null = stored, not loaded yet
const memoryOnly = new Set<string>();
const norm = (p: string) => ('/' + String(p).split('/').filter((s) => s && s !== '.').join('/')).replace(/\/+$/, '') || '/';

function enoent(p: string) {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });
}

/** Loads the file list and the small files. Called once when the app starts. */
export async function loadFiles() {
  const sizes = new Map(await idbEntries<number>('sizes'));
  for (const path of sizes.keys()) files.set(path, null);
  const small = [...files.keys()];
  await Promise.all(small.filter((p) => (sizes.get(p) ?? 0) <= EAGER_MAX).map(async (p) => {
    const data = await idbGet<Uint8Array>('files', p);
    if (data) files.set(p, data);
    else files.delete(p);
  }));
}

export async function preloadFiles(paths: string[]) {
  await Promise.all(paths.map(norm).filter((p) => files.get(p) === null).map(async (p) => {
    const data = await idbGet<Uint8Array>('files', p);
    if (data) files.set(p, data);
    else files.delete(p);
  }));
}

/** Adds a file that exists only for this run (e.g. the bundled database migrations). */
export function seedFile(path: string, data: string) {
  const p = norm(path);
  files.set(p, new TextEncoder().encode(data));
  memoryOnly.add(p);
}

let writes = Promise.resolve();
function persist(p: string, data: Uint8Array | undefined) {
  if (memoryOnly.has(p)) return;
  writes = writes
    .then(() => idbWrite([{ store: 'files', key: p, value: data }, { store: 'sizes', key: p, value: data?.length }]))
    .catch((err) => console.error('Saving a file failed', err));
}
export const flushFiles = () => writes;

export function existsSync(path: string) {
  const p = norm(path);
  if (files.has(p)) return true;
  const prefix = p === '/' ? '/' : `${p}/`;
  for (const k of files.keys()) if (k.startsWith(prefix)) return true;
  return false;
}

export function readFileSync(path: string, opts?: string | { encoding?: string }) {
  const p = norm(path);
  const data = files.get(p);
  if (data === undefined) throw enoent(p);
  if (data === null) throw Object.assign(new Error(`File not loaded yet: ${p}`), { code: 'EAGAIN' });
  const enc = typeof opts === 'string' ? opts : opts?.encoding;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return enc ? buf.toString(enc as BufferEncoding) : buf;
}

export function writeFileSync(path: string, data: string | Uint8Array) {
  const p = norm(path);
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  files.set(p, bytes);
  persist(p, bytes);
}

export function mkdirSync() {
  return undefined;
}

export function rmSync(path: string, _opts?: { recursive?: boolean; force?: boolean }) {
  const p = norm(path);
  for (const k of [...files.keys()]) {
    if (k === p || k.startsWith(`${p}/`)) {
      files.delete(k);
      persist(k, undefined);
    }
  }
}

export function readdirSync(dir: string) {
  const prefix = `${norm(dir)}/`;
  const names = new Set<string>();
  for (const k of files.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0]);
  return [...names].sort();
}

export function statSync(path: string) {
  const d = files.get(norm(path));
  if (d === undefined) throw enoent(path);
  return { size: d?.length ?? 0, isFile: () => true, isDirectory: () => false };
}

export default { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync };
