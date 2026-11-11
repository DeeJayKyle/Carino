import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Access to folders on the user's device that they chose, one at a time, in the system's own picker.
 * Everything is addressed as (root, path inside it); an implementation must refuse anything that
 * would leave the root (.., absolute paths, links pointing out). Changes are only ever made after
 * the user approved them (services/localfiles.ts), and a delete first keeps a verified copy.
 *
 * Implementations: the Windows app (desktop/app, in Rust), Android (the system folder picker), and
 * NodeLocalFs below (a PC server, and tests).
 */
export interface LocalEntry { rel: string; name: string; dir: boolean; size: number; mtime: string }

export interface LocalFs {
  platform: 'windows' | 'android' | 'node';
  /** Lists a folder (not recursive). */
  list(root: string, rel: string): Promise<LocalEntry[]>;
  read(root: string, rel: string, maxBytes: number): Promise<Uint8Array>;
  rename(root: string, rel: string, toRel: string): Promise<void>;
  /** Writes a new file (never replaces one that's there). */
  write(root: string, rel: string, data: Uint8Array): Promise<void>;
  /** Copies the file somewhere only Carino uses, checks the copy, then deletes the original. Returns where the copy is. */
  deleteWithRecovery(root: string, rel: string, sha256: string): Promise<string>;
  /** Puts a recovered copy back (checking it), e.g. to undo a delete. */
  restore(root: string, rel: string, recovery: string, sha256: string): Promise<void>;
}

export class LocalFsError extends Error {}

export const sha256Of = (u: Uint8Array) => createHash('sha256').update(u).digest('hex');

/** Turns a path inside a root into a safe relative path, or refuses. */
export function safeRel(rel: string): string {
  const parts = rel.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..' || /[\0]/.test(p)) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) throw new LocalFsError('That path is outside the folder.');
  return parts.join('/');
}

/** Real folders on disk (a PC server, and tests). */
export class NodeLocalFs implements LocalFs {
  platform = 'node' as const;
  private recoveryDir: string;
  constructor(recoveryDir: string) {
    this.recoveryDir = recoveryDir;
  }

  private inside(root: string, rel: string) {
    const r = realpathSync(resolve(root));
    const target = resolve(r, safeRel(rel));
    // Links that point outside the folder are refused too.
    // For a path that doesn't exist yet (a move into a new folder), check its nearest existing parent.
    let real: string;
    if (existsSync(target)) real = realpathSync(target);
    else {
      let base = dirname(target);
      const rest = [basename(target)];
      while (!existsSync(base) && base !== dirname(base)) {
        rest.unshift(basename(base));
        base = dirname(base);
      }
      real = resolve(realpathSync(base), ...rest);
    }
    if (real !== r && !real.startsWith(r + sep)) throw new LocalFsError('That path is outside the folder.');
    return real;
  }

  async list(root: string, rel: string) {
    const dir = this.inside(root, rel);
    const out: LocalEntry[] = [];
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
        this.inside(root, relative(realpathSync(resolve(root)), full));
      } catch {
        continue; // unreadable, or a link leading out of the folder
      }
      out.push({ rel: safeRel(relative(realpathSync(resolve(root)), full)), name, dir: st.isDirectory(), size: st.size, mtime: st.mtime.toISOString() });
    }
    return out;
  }

  async read(root: string, rel: string, maxBytes: number) {
    const p = this.inside(root, rel);
    if (statSync(p).size > maxBytes) throw new LocalFsError('That file is too large to read.');
    return new Uint8Array(readFileSync(p));
  }

  async rename(root: string, rel: string, toRel: string) {
    const from = this.inside(root, rel);
    const to = this.inside(root, toRel);
    if (existsSync(to)) throw new LocalFsError(`There is already a file at ${toRel}.`);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }

  async write(root: string, rel: string, data: Uint8Array) {
    const to = this.inside(root, rel);
    if (existsSync(to)) throw new LocalFsError(`There is already a file at ${rel}.`);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, data, { flag: 'wx' });
  }

  async deleteWithRecovery(root: string, rel: string, sha256: string) {
    const p = this.inside(root, rel);
    if (sha256Of(readFileSync(p)) !== sha256) throw new LocalFsError(`${rel} changed since it was checked. Look again before deleting it.`);
    mkdirSync(this.recoveryDir, { recursive: true });
    const copy = join(this.recoveryDir, `${randomUUID()}.bin`);
    copyFileSync(p, copy);
    if (sha256Of(readFileSync(copy)) !== sha256) {
      rmSync(copy, { force: true });
      throw new LocalFsError('The safety copy didn’t check out, so nothing was deleted.');
    }
    rmSync(p);
    return copy;
  }

  async restore(root: string, rel: string, recovery: string, sha256: string) {
    if (!existsSync(recovery) || sha256Of(readFileSync(recovery)) !== sha256) throw new LocalFsError('The saved copy is missing or damaged; it can’t be restored.');
    const to = this.inside(root, rel);
    if (existsSync(to)) throw new LocalFsError(`There is already a file at ${rel}.`);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(recovery, to);
    if (sha256Of(readFileSync(to)) !== sha256) throw new LocalFsError('The restored file didn’t check out.');
    rmSync(recovery, { force: true });
  }
}
