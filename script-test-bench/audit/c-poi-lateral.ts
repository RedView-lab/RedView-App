/**
 * C3 — Filtre latéral client (corridor-distance-filter.ts → refinePoiProjection.ts) :
 * projection équirectangulaire avec UNE échelle de longitude (latitude moyenne
 * de la trace, projectRoutePoints l.40-47). Quantifie l'erreur sur un N–S de
 * ~1 000 km et sur la progression (km) utilisée par le tri auto.
 *
 * Usage : npx tsx script-test-bench/audit/c-poi-lateral.ts
 * Sortie != 0 si un POI à < X m (vrai) est rejeté, ou à > X m accepté, avec
 * une marge de 5 % (X = 20 m par défaut).
 */
import { filterPoisByLateralDistance } from '../../src/features/poi/lib/corridor-distance-filter.ts';
import { projectPoiOntoRoute, projectRoutePoints } from '../../src/features/poi/lib/refinePoiProjection.ts';
import type { PoiFeature } from '../../src/features/poi/types.ts';
import { DEFAULT_POI_DISTANCE_M } from '../../src/features/itineraryPanel/lib/project/defaultState.ts';
import { GT20, TDF, haversineM, readGpxPoints } from './c-lib.ts';

const failures: string[] = [];
const R = 6_371_008.8;
const X = DEFAULT_POI_DISTANCE_M;

// Trace N–S Perpignan→Dunkerque-like : lat 42.0 → 51.0 le long de lon 2.5, un point tous les ~50 m.
const route: { lat: number; lon: number }[] = [];
for (let lat = 42.0; lat <= 51.0 + 1e-9; lat += 50 / 111_200) route.push({ lat, lon: 2.5 });
const lenKm = route.slice(1).reduce((s, p, i) => s + haversineM(route[i]!, p), 0) / 1000;
const projected = projectRoutePoints(route);

console.log(`Trace N–S : ${route.length} pts, ${lenKm.toFixed(0)} km, X = ${X} m, échelle lon unique à lat ${(projected as unknown as { refLat: number }).refLat.toFixed(2)}°`);
console.log('  lat    vrai(m)  calculé(m)  erreur   décision (X)');
const mk = (id: number, lat: number, dEastM: number): PoiFeature => ({
  id, lat, lon: 2.5 + (dEastM / (R * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI), category: 'drinking_water', name: null, tags: {},
} as unknown as PoiFeature);
let id = 1;
let worst = 0;
for (const lat of [42.2, 44, 46.5, 49, 50.8]) {
  for (const d of [0.95 * X, 1.05 * X]) {
    const poi = mk(id++, lat, d);
    const calc = projectPoiOntoRoute(poi, projected).lateralDistanceM;
    const kept = filterPoisByLateralDistance([poi], route as never, { drinking_water: X } as never).length === 1;
    const shouldKeep = d <= X;
    const err = (calc - d) / d;
    worst = Math.max(worst, Math.abs(err));
    console.log(`  ${lat.toFixed(1).padStart(4)}  ${d.toFixed(1).padStart(7)}  ${calc.toFixed(1).padStart(10)}  ${(100 * err).toFixed(1).padStart(5)} %  ${kept ? 'gardé ' : 'rejeté'}${kept !== shouldKeep ? '  <-- FAUX' : ''}`);
    if (kept !== shouldKeep) failures.push(`lat ${lat}: POI à ${d.toFixed(1)} m (vrai) ${kept ? 'gardé' : 'rejeté'} pour X=${X} m (calculé ${calc.toFixed(1)} m)`);
  }
}
console.log(`  erreur relative max sur la distance latérale E–O : ${(100 * worst).toFixed(1)} %`);

// Progression (km) : projection plane vs haversine, après remise à l'échelle sur la longueur totale.
function progressError(name: string, pts: { lat: number; lon: number }[]) {
  const pr = projectRoutePoints(pts);
  const flatTotal = pr[pr.length - 1]!.progressM;
  let h = 0; const hav: number[] = [0];
  for (let i = 1; i < pts.length; i++) { h += haversineM(pts[i - 1]!, pts[i]!); hav.push(h); }
  let maxAbs = 0, at = 0;
  for (let i = 0; i < pts.length; i++) {
    const scaled = (pr[i]!.progressM / flatTotal) * h; // le tri auto rapporte progressM à la longueur totale
    const e = Math.abs(scaled - hav[i]!);
    if (e > maxAbs) { maxAbs = e; at = hav[i]!; }
  }
  console.log(`${name.padEnd(18)} longueur plane ${(flatTotal / 1000).toFixed(1)} km vs haversine ${(h / 1000).toFixed(1)} km (${(100 * (flatTotal - h) / h).toFixed(2)} %), décalage max après remise à l'échelle ${(maxAbs / 1000).toFixed(2)} km (vers km ${(at / 1000).toFixed(0)})`);
  return maxAbs;
}
console.log('');
progressError('N–S 1000 km', route);
progressError('GT20', readGpxPoints(GT20));
progressError('Tour de France', readGpxPoints(TDF));
// Diagonale Brest → Menton (E–O + N–S, ~1 100 km)
const diag: { lat: number; lon: number }[] = [];
for (let t = 0; t <= 1; t += 1 / 20000) diag.push({ lat: 48.39 + t * (43.77 - 48.39), lon: -4.49 + t * (7.5 + 4.49) });
const dErr = progressError('Brest→Menton', diag);
if (dErr > 1000) failures.push(`progression : décalage ${(dErr / 1000).toFixed(1)} km sur une diagonale`);

console.log(failures.length ? `\nFAIL ${failures.length}:\n  - ${failures.join('\n  - ')}` : '\nOK');
process.exitCode = failures.length ? 1 : 0;
