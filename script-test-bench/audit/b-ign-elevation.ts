/**
 * Audit B5c — does IGN Géoplateforme altimetry accept the 5000-point POST batch
 * that terrainTiles.ts:79-122 sends (IGN_ALTIMETRY_MAX_POINTS_PER_REQUEST = 5000)?
 * Also shows what it returns for points just outside France (Aosta valley, on the
 * UTMB course, which isInsideFranceLoose() classifies as "France").
 *
 *   npx tsx script-test-bench/audit/b-ign-elevation.ts      (ONE real request)
 *
 * Exit 1 when the batch is rejected / length mismatches.
 */
const N = 5000;
const lat: number[] = [], lon: number[] = [];
for (let i = 0; i < N - 2; i++) { lat.push(+(45.0 + i * 0.0001).toFixed(6)); lon.push(+(6.0 + i * 0.0001).toFixed(6)); }
lat.push(45.79, 45.86); lon.push(6.98, 7.10); // Courmayeur / Grand Col Ferret (Italy/Switzerland)
const t0 = performance.now();
const res = await fetch('https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json', {
  method: 'POST',
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  body: JSON.stringify({ lon: lon.join('|'), lat: lat.join('|'), resource: 'ign_rge_alti_wld', delimiter: '|', indent: 'false', measures: 'false', zonly: 'true' }),
});
const text = await res.text();
const ms = performance.now() - t0;
let el: number[] = [];
try { el = JSON.parse(text).elevations ?? []; } catch { /* */ }
console.log(`POST ${N} pts → HTTP ${res.status} in ${ms.toFixed(0)} ms, ${(text.length / 1024).toFixed(0)} KB, elevations=${el.length}; first=${el[0]} last two (IT/CH)=${el.slice(-2).join(', ')}`);
const ok = res.ok && el.length === N;
console.log(ok ? 'OK' : `FAIL: ${text.slice(0, 200)}`);
process.exit(ok ? 0 : 1);
