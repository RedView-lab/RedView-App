/**
 * Audit B5b — does Open-Meteo's elevation API accept what terrainTiles.ts sends?
 *
 *   npx tsx script-test-bench/audit/b-openmeteo-elevation.ts
 *
 * route-metrics/terrainTiles.ts:127-159 POSTs a JSON body {latitude:[…], longitude:[…]}
 * with up to OPEN_METEO_MAX_POINTS_PER_REQUEST = 2000 points directly to
 * https://api.open-meteo.com/v1/elevation (used for every non-France point and
 * as fallback for IGN failures). This makes exactly ONE real request with
 * 2000 coordinates (Alps/Switzerland) and checks the response shape.
 *
 * Exit 1 when the batch is rejected or the elevation array length mismatches
 * (the app then silently keeps BRouter/GPX elevations: catch at terrainTiles.ts:265).
 */
const N = 2000;
const latitude: number[] = [], longitude: number[] = [];
for (let i = 0; i < N; i++) { latitude.push(+(46.0 + i * 0.0005).toFixed(5)); longitude.push(+(7.5 + i * 0.0005).toFixed(5)); }

const t0 = performance.now();
const res = await fetch('https://api.open-meteo.com/v1/elevation', {
  method: 'POST',
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  body: JSON.stringify({ latitude, longitude }),
});
const text = await res.text();
const ms = performance.now() - t0;
let n = -1;
try { const j = JSON.parse(text); n = Array.isArray(j.elevation) ? j.elevation.length : -1; } catch { /* not json */ }
console.log(`POST ${N} coords → HTTP ${res.status} in ${ms.toFixed(0)} ms, elevation[] length=${n}`);
console.log(`body: ${text.slice(0, 300)}`);
const ok = res.ok && n === N;
console.log(ok ? '\nOK' : '\nFAIL: Open-Meteo rejects the batch the app sends → international elevation refinement silently does nothing');
process.exit(ok ? 0 : 1);
