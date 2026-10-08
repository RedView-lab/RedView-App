/**
 * Précompile /laz-perf.wasm une fois sur le thread principal pour que le
 * WebAssembly.Module compilé puisse être transmis aux Web Workers par postMessage.
 *
 * Dans Firefox et Zen Browser (Gecko), la compilation WebAssembly dans un Web Worker
 * est soumise à des règles CSP strictes (« CompileError: call to WebAssembly.instantiate() blocked by CSP »).
 * Instancier un WebAssembly.Module déjà compilé dans un Worker ne déclenche AUCUNE
 * compilation de code et fonctionne sous n'importe quelle CSP.
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
