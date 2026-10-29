// Browser stand-in for the parts of node:crypto Carino's server uses, so it can run on the phone.
import { Buffer } from '../buffer.ts';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { sha1, md5 } from '@noble/hashes/legacy.js';
import { hmac } from '@noble/hashes/hmac.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { gcm } from '@noble/ciphers/aes.js';

type Data = string | Uint8Array;
const toBytes = (d: Data, enc?: string) => (typeof d === 'string' ? Buffer.from(d, (enc as BufferEncoding) ?? 'utf8') : d);
const HASHES: Record<string, any> = { sha256, sha512, sha1, md5 };
function hashFn(alg: string) {
  const h = HASHES[alg.toLowerCase().replace('-', '')];
  if (!h) throw new Error(`Unsupported hash ${alg}`);
  return h;
}

export function randomBytes(n: number) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536)));
  return b;
}
export const randomUUID = () => crypto.randomUUID();
export function randomInt(min: number, max?: number) {
  if (max === undefined) [min, max] = [0, min];
  const range = max - min;
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return min + (buf[0] % range);
}

class Digest {
  private parts: Uint8Array[] = [];
  private fn: (msg: Uint8Array) => Uint8Array;
  constructor(fn: (msg: Uint8Array) => Uint8Array) {
    this.fn = fn;
  }
  update(d: Data, enc?: string) {
    this.parts.push(toBytes(d, enc));
    return this;
  }
  digest(): Buffer;
  digest(enc: BufferEncoding): string;
  digest(enc?: BufferEncoding): Buffer | string {
    const out = Buffer.from(this.fn(Buffer.concat(this.parts)));
    return enc ? out.toString(enc) : out;
  }
}

export const createHash = (alg: string) => new Digest((m) => hashFn(alg)(m));
export const createHmac = (alg: string, key: Data) => new Digest((m) => hmac(hashFn(alg), toBytes(key), m));

export function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** aes-256-gcm only — the one cipher Carino uses. Buffers input until final(). */
class Gcm {
  private parts: Uint8Array[] = [];
  private tag?: Uint8Array;
  private key: Uint8Array;
  private iv: Uint8Array;
  private decrypt: boolean;
  constructor(alg: string, key: Uint8Array, iv: Uint8Array, decrypt: boolean) {
    if (alg !== 'aes-256-gcm') throw new Error(`Unsupported cipher ${alg}`);
    this.key = key;
    this.iv = iv;
    this.decrypt = decrypt;
  }
  update(d: Data, enc?: string) {
    this.parts.push(toBytes(d, enc));
    return Buffer.alloc(0);
  }
  setAuthTag(t: Uint8Array) {
    this.tag = t;
    return this;
  }
  getAuthTag() {
    return Buffer.from(this.tag!);
  }
  final() {
    const c = gcm(this.key, this.iv);
    const input = Buffer.concat(this.parts);
    if (this.decrypt) return Buffer.from(c.decrypt(Buffer.concat([input, this.tag!])));
    const sealed = c.encrypt(input);
    this.tag = sealed.subarray(sealed.length - 16);
    return Buffer.from(sealed.subarray(0, sealed.length - 16));
  }
}
export const createCipheriv = (alg: string, key: Uint8Array, iv: Uint8Array) => new Gcm(alg, key, iv, false);
export const createDecipheriv = (alg: string, key: Uint8Array, iv: Uint8Array) => new Gcm(alg, key, iv, true);

export function scrypt(pw: Data, salt: Data, keylen: number, opts: any, cb?: (err: Error | null, key?: Buffer) => void) {
  if (typeof opts === 'function') [cb, opts] = [opts, {}];
  scryptAsync(toBytes(pw), toBytes(salt), { N: opts?.N ?? 16384, r: opts?.r ?? 8, p: opts?.p ?? 1, dkLen: keylen })
    .then((k) => cb!(null, Buffer.from(k)), (e) => cb!(e));
}

export const webcrypto = globalThis.crypto;
export default { randomBytes, randomUUID, randomInt, createHash, createHmac, timingSafeEqual, createCipheriv, createDecipheriv, scrypt, webcrypto };
