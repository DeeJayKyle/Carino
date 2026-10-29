// The `buffer` package plus the base64url encoding Node has and the package lacks.
import { Buffer } from 'buffer';

const proto = Buffer.prototype as any;
const toString = proto.toString;
proto.toString = function (enc?: string, start?: number, end?: number) {
  if (enc === 'base64url') return toString.call(this, 'base64', start, end).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return toString.call(this, enc, start, end);
};
const from = Buffer.from as any;
(Buffer as any).from = function (value: any, enc?: any, len?: any) {
  if (typeof value === 'string' && enc === 'base64url') return from.call(Buffer, value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return from.call(Buffer, value, enc, len);
};
const isEncoding = Buffer.isEncoding;
Buffer.isEncoding = (e: string) => e === 'base64url' || isEncoding(e);

export { Buffer };
