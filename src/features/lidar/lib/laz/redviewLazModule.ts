/**
 * Compiles the RedView LAZ decoder once on the main thread; the
 * WebAssembly.Module is handed to the decode workers (see redviewLaz.ts and
 * lazWasm.ts for the CSP reason). Null where it cannot load: the workers then
 * decode with laz-perf.
 */
import wasmUrl from './pkg/redviewlaz_bg.wasm?url';

let modulePromise: Promise<WebAssembly.Module | null> | null = null;

export function getRedviewLazModule(): Promise<WebAssembly.Module | null> {
  if (typeof WebAssembly === 'undefined') return Promise.resolve(null);
  modulePromise ??= (async () => {
    try {
      const response = await fetch(wasmUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return 'compileStreaming' in WebAssembly && response.headers.get('content-type')?.includes('application/wasm')
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    } catch (error) {
      console.warn('[LiDAR] LAZ decoder unavailable, falling back to laz-perf:', error);
      return null;
    }
  })();
  return modulePromise;
}
