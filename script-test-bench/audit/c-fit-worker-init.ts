/**
 * C5b — Le VRAI worker (src/features/fitPredictor/engine/worker.ts) dans Node :
 * le premier fetch de /redviewalgo_bg.wasm échoue (coupure réseau / 502 pendant
 * un déploiement), les suivants réussissent. Le worker se rétablit-il ?
 *
 * Usage : npx tsx script-test-bench/audit/c-fit-worker-init.ts
 * Sortie != 0 si le 2e message échoue encore alors que le réseau est revenu
 * (promesse d'init rejetée mise en cache à vie, worker.ts l.14-21).
 */
import fs from 'node:fs';
import path from 'node:path';

const wasmBytes = fs.readFileSync(path.resolve('public/redviewalgo_bg.wasm'));
let fetchCalls = 0;
globalThis.fetch = (async (input: unknown) => {
  fetchCalls++;
  if (fetchCalls === 1) {
    return new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
  }
  return new Response(wasmBytes, { status: 200, headers: { 'Content-Type': 'application/wasm' } });
}) as typeof fetch;

const responses: Array<{ _id: number; type: string; message?: string }> = [];
const selfStub = {
  onmessage: null as null | ((e: { data: unknown }) => Promise<void>),
  postMessage: (m: { _id: number; type: string; message?: string }) => { if (m.type !== 'progress') responses.push(m); },
};
(globalThis as { self?: unknown }).self = selfStub;

await import('../../src/features/fitPredictor/engine/worker.ts');
if (!selfStub.onmessage) throw new Error('worker.ts n\'a pas installé self.onmessage');

const gpx = new TextEncoder().encode(
  '<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>'
  + Array.from({ length: 200 }, (_, i) => `<trkpt lat="${(45 + i * 0.0005).toFixed(6)}" lon="6.0"><ele>${(500 + i).toFixed(1)}</ele></trkpt>`).join('')
  + '</trkseg></trk></gpx>',
);
const log = console.log; console.log = () => {};
const warn = console.warn; console.warn = () => {};
for (let id = 1; id <= 3; id++) {
  await selfStub.onmessage({ data: { _id: id, type: 'predict', fitFiles: [], gpxData: gpx.buffer.slice(0), config: {} } });
}
console.log = log; console.warn = warn;

for (const r of responses) console.log(`message #${r._id} → ${r.type}${r.message ? ` : ${r.message.slice(0, 120)}` : ''}`);
console.log(`appels fetch du .wasm : ${fetchCalls} (1er en 502, suivants OK)`);
const recovered = responses.find((r) => r._id === 3)?.type === 'result';
if (!recovered) {
  console.log('\nFAIL worker empoisonné : l\'init WASM ratée n\'est jamais retentée (initPromise rejetée gardée) — toutes les prédictions échouent jusqu\'au rechargement de la page.');
  process.exit(1);
}
console.log('\nOK le worker se rétablit');
