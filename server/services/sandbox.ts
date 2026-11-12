/**
 * Runs a short JavaScript snippet in QuickJS (WebAssembly) for calculations and data work. The
 * sandbox has no network, no files, no timers and none of the user's data unless it is passed in
 * as `input`; memory and time are capped. It works the same on the PC server and on the phone.
 */
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline, type QuickJSWASMModule } from 'quickjs-emscripten-core';

let mod: Promise<QuickJSWASMModule> | null = null;
const quickjs = () => (mod ??= import('@jitl/quickjs-singlefile-mjs-release-sync').then((v) => newQuickJSWASMModuleFromVariant(v.default)));

export interface CodeResult { ok: boolean; result?: unknown; error?: string; logs: string[] }

const MAX_MS = 3000;
const MAX_MEMORY = 32 * 1024 * 1024;

export async function runCode(code: string, input?: unknown): Promise<CodeResult> {
  const Q = await quickjs();
  const rt = Q.newRuntime();
  rt.setMemoryLimit(MAX_MEMORY);
  rt.setMaxStackSize(1024 * 1024);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + MAX_MS));
  const vm = rt.newContext();
  const logs: string[] = [];
  try {
    const log = vm.newFunction('log', (...args) => {
      if (logs.length < 200) logs.push(args.map((a) => { const v = vm.dump(a); return typeof v === 'string' ? v : JSON.stringify(v); }).join(' ').slice(0, 2000));
    });
    const console = vm.newObject();
    vm.setProp(console, 'log', log);
    vm.setProp(vm.global, 'console', console);
    console.dispose();
    log.dispose();
    const json = JSON.stringify(input ?? null);
    const inputHandle = vm.unwrapResult(vm.evalCode(`(${json})`));
    vm.setProp(vm.global, 'input', inputHandle);
    inputHandle.dispose();
    // The snippet's last expression is the result; a function body with `return` works too.
    const wrapped = /\breturn\b/.test(code) ? `(function(){\n${code}\n})()` : code;
    const r = vm.evalCode(wrapped, 'snippet.js');
    if (r.error) {
      const e = vm.dump(r.error);
      r.error.dispose();
      const msg = typeof e === 'object' && e ? `${e.name ?? 'Error'}: ${e.message ?? JSON.stringify(e)}` : String(e);
      return { ok: false, error: /interrupted/i.test(msg) ? `Stopped after ${MAX_MS / 1000} s (too slow or an endless loop).` : msg.slice(0, 1000), logs };
    }
    const value = vm.dump(r.value);
    r.value.dispose();
    const out = JSON.stringify(value ?? null);
    return { ok: true, result: out.length > 20_000 ? `${out.slice(0, 20_000)}…` : value, logs };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 500), logs };
  } finally {
    vm.dispose();
    rt.dispose();
  }
}
