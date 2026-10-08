/**
 * Audit B5c — l'altimétrie de la Géoplateforme IGN accepte-t-elle le lot POST
 * de 5000 points qu'envoie terrainTiles.ts:79-122
 * (IGN_ALTIMETRY_MAX_POINTS_PER_REQUEST = 5000) ? Montre aussi ce qu'elle
 * renvoie pour des points juste hors de France (val d'Aoste, sur le parcours
 * de l'UTMB, que isInsideFranceLoose() classe comme « France »).
 *
 *   npx tsx script-test-bench/audit/b-ign-elevation.ts      (UNE vraie requête)
 *
 * Sortie 1 quand le lot est refusé / que les longueurs ne concordent pas.
 */
const N = 5000;
const lat: number[] = [], lon: number[] = [];
for (let i = 0; i < N - 2; i++) { lat.push(+(45.0 + i * 0.0001).toFixed(6)); lon.push(+(6.0 + i * 0.0001).toFixed(6)); }
lat.push(45.79, 45.86); lon.push(6.98, 7.10); // Courmayeur / Grand Col Ferret (Italie / Suisse)
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
