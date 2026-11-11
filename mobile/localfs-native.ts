import type { LocalFs, LocalEntry } from '../server/services/localfs.ts';
import { LocalFsError } from '../server/services/localfs.ts';

/**
 * The folders the user picked, through the Windows app (Rust, desktop/app/src/files.rs) or Android
 * (LocalFolders.java). Both check every path against the folders the user chose, natively.
 */

const toIso = (ms: string) => (ms && /^\d+$/.test(ms) ? new Date(Number(ms)).toISOString() : ms);
const toB64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

export function tauriLocalFs(invoke: (cmd: string, args?: any) => Promise<any>): LocalFs {
  const call = async <T>(cmd: string, args: any): Promise<T> => {
    try {
      return await invoke(cmd, args);
    } catch (e: any) {
      throw new LocalFsError(String(e?.message ?? e));
    }
  };
  return {
    platform: 'windows',
    list: async (root, rel) => (await call<LocalEntry[]>('fs_list', { root, rel })).map((e) => ({ ...e, mtime: toIso(e.mtime) })),
    read: async (root, rel, maxBytes) => fromB64(await call<string>('fs_read', { root, rel, maxBytes })),
    rename: (root, rel, toRel) => call('fs_rename', { root, rel, toRel }),
    write: (root, rel, data) => call('fs_write', { root, rel, b64: toB64(data) }),
    deleteWithRecovery: (root, rel, sha256) => call('fs_delete_recover', { root, rel, sha256Hex: sha256 }),
    restore: (root, rel, recovery, sha256) => call('fs_restore', { root, rel, recovery, sha256Hex: sha256 }),
  };
}

interface FolderBridge {
  folderList(root: string, rel: string): string;
  folderRead(root: string, rel: string, maxBytes: number): string;
  folderRename(root: string, rel: string, toRel: string): string;
  folderWrite(root: string, rel: string, b64: string): string;
  folderDelete(root: string, rel: string, sha: string): string;
  folderRestore(root: string, rel: string, recovery: string, sha: string): string;
}

export function androidLocalFs(bridge: FolderBridge): LocalFs {
  const call = <T>(json: string): T => {
    const r = JSON.parse(json);
    if (!r.ok) throw new LocalFsError(r.error ?? 'That didn’t work.');
    return r.value as T;
  };
  return {
    platform: 'android',
    list: async (root, rel) => call<LocalEntry[]>(bridge.folderList(root, rel)).map((e) => ({ ...e, mtime: toIso(e.mtime) })),
    read: async (root, rel, maxBytes) => fromB64(call<string>(bridge.folderRead(root, rel, maxBytes))),
    rename: async (root, rel, toRel) => void call(bridge.folderRename(root, rel, toRel)),
    write: async (root, rel, data) => void call(bridge.folderWrite(root, rel, toB64(data))),
    deleteWithRecovery: async (root, rel, sha) => call<string>(bridge.folderDelete(root, rel, sha)),
    restore: async (root, rel, recovery, sha) => void call(bridge.folderRestore(root, rel, recovery, sha)),
  };
}
