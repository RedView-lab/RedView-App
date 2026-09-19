/**
 * Pre-compiles /laz-perf.wasm once on the main thread so the compiled
 * WebAssembly.Module can be transferred to Web Workers via postMessage.
 *
 * In Firefox and Zen Browser (Gecko), WebAssembly compilation inside Web Workers
 * is subject to strict CSP rules ("CompileError: call to WebAssembly.instantiate() blocked by CSP").
 * Instantiating an already-compiled WebAssembly.Module inside a Worker does NOT trigger
 * code compilation and works seamlessly under any CSP.
 */

let lazWasmModulePromise: Promise<WebAssembly.Module | null> | null = null;

export async function getLazWasmModule(): Promise<WebAssembly.Module | null> {
  if (typeof WebAssembly === 'undefined') return null;
  if (!lazWasmModulePromise) {
    lazWasmModulePromise = (async () => {
      try {
        if ('compileStreaming' in WebAssembly) {
          const res = await fetch('/laz-perf.wasm');
          if (res.ok) {
            return await WebAssembly.compileStreaming(res);
          }
        }
        const res = await fetch('/laz-perf.wasm');
        if (!res.ok) {
          console.warn(`[laz-wasm] Failed to fetch /laz-perf.wasm: HTTP ${res.status}`);
          return null;
        }
        const buf = await res.arrayBuffer();
        return await WebAssembly.compile(buf);
      } catch (err) {
        console.warn('[laz-wasm] compileStreaming failed for /laz-perf.wasm, trying fallback fetch+compile:', err);
        try {
          const res = await fetch('/laz-perf.wasm');
          if (!res.ok) return null;
          const buf = await res.arrayBuffer();
          return await WebAssembly.compile(buf);
        } catch (e) {
          console.error('[laz-wasm] Failed to precompile laz-perf.wasm on main thread:', e);
          return null;
        }
      }
    })();
  }
  return lazWasmModulePromise;
}
