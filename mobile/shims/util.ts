export function promisify(fn: (...args: any[]) => void) {
  return (...args: any[]) => new Promise((resolve, reject) => fn(...args, (err: unknown, value: unknown) => (err ? reject(err) : resolve(value))));
}
export const inspect = (v: unknown) => { try { return JSON.stringify(v); } catch { return String(v); } };
export const types = { isUint8Array: (v: unknown) => v instanceof Uint8Array };
export default { promisify, inspect, types };
