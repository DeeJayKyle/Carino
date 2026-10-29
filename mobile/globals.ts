// Node globals the server code expects. Imported first by mobile/engine.ts.
import { Buffer } from './buffer.ts';

(globalThis as any).Buffer ??= Buffer;
(globalThis as any).process ??= { env: {}, cwd: () => '/', platform: 'android', versions: {}, nextTick: (fn: () => void) => queueMicrotask(fn) };
