/**
 * Audit B3 — coût de l'historique d'annulation (ProjectStore/useTraceHistory.ts).
 *
 *   node --expose-gc --import tsx script-test-bench/audit/b-history-memory.ts
 *
 * `commitTraceMutation` (utilisé par chaque glisser du Tracer / variante Alt /
 * découpe / fusion…) fait un `structuredClone(projectRef.current)` de TOUT le
 * projet et garde l'état précédent dans `past` (MAX_HISTORY_STEPS = 100).
 * Comme le clone ne partage rien avec l'état précédent, chaque pas retient une
 * copie complète des points / originalPoints / frise de chaque variante.
 *
 * Ce script construit un projet réaliste à partir de vrais fichiers GPX (GT20
 * 593 km, importé comme le fait l'application : `points` simplifiés +
 * `originalPoints` complets), avec 1 à 3 variantes, et rejoue 100 commits façon
 * glisser avec le même algorithme (clone → petite mutation → empile l'état
 * précédent, plafond 100).
 *
 * Sortie 1 si l'historique retenu pour 3 variantes dépasse 500 Mo ou si un
 * commit bloque le fil principal plus de 100 ms.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadSrc, closeLoader, DOWNLOADS } from './b-loader';

const gc = (globalThis as any).gc as (() => void) | undefined;
const heapMB = () => { gc?.(); gc?.(); return process.memoryUsage().heapUsed / 1048576; };
const failures: string[] = [];

async function main() {
  if (!gc) console.warn('WARNING: run with `node --expose-gc --import tsx` for accurate heap numbers');
  const { parseGpxText } = await loadSrc<any>('src/features/poi/lib/gpx-parse.ts');
  const routes = await loadSrc<any>('src/features/itineraryPanel/lib/routes/index.ts');
  // Clone de brouillon réellement utilisé par commitTraceMutation (useTraceHistory.ts).
  const { cloneProjectForMutation } = await loadSrc<any>('src/features/itineraryPanel/context/ProjectStore/historyClone.ts');

  const text = fs.readFileSync(path.join(DOWNLOADS, 'GT20.gpx'), 'utf8');
  const parsed = parseGpxText(text);
  const stored = routes.normalizeImportedRoutePoints(parsed.points, { includeGradient: false });
  const simplified = routes.normalizeImportedRoutePoints(routes.simplifyPointsByQuality(stored, 'default'));
  const timeline = routes.createImportedTimeline(stored);
  console.log(`GT20: originalPoints ${stored.length}, points ${simplified.length}, json ${(JSON.stringify(stored).length / 1048576).toFixed(1)} MB`);

  const makeVariant = (i: number) => ({
    id: `it-${i}`, name: `GT20 v${i}`, profileId: 'road', discipline: 'road',
    timeline: structuredClone(timeline),
    gpxRoute: { name: 'GT20', points: structuredClone(simplified), originalPoints: structuredClone(stored), source: 'gpx', gpxQuality: 'default', gpxQualityPointsPerKm: null },
    metrics: routes.buildImportedRouteMetrics(stored),
    poiFeatures: [], poi: {},
  });

  for (const variants of [1, 3]) {
    const base = heapMB();
    let current: any = { id: 'p', name: 'p', activeItineraryId: 'it-0', itineraries: Array.from({ length: variants }, (_, i) => makeVariant(i)) };
    const live = heapMB() - base;
    let past: any[] = [];
    const times: number[] = [];
    for (let step = 0; step < 100; step++) {
      const t0 = performance.now();
      const after = cloneProjectForMutation(current); // useTraceHistory.ts commitTraceMutation
      times.push(performance.now() - t0);
      const wp = after.itineraries[0].timeline.find((r: any) => r.kind === 'waypoint');
      if (wp) wp.lat += 0.0001; // modification façon moveTracePointInItinerary
      if (wp && current.itineraries[0].timeline.find((r: any) => r.id === wp.id)?.lat === wp.lat) failures.push('draft edit leaked into the previous history state');
      past = [...past, current].slice(-100); // pushSnapshot
      current = after;
    }
    const retained = heapMB() - base;
    times.sort((a, b) => a - b);
    const p50 = times[50], p95 = times[95], max = times[99];
    console.log(`variants=${variants}: live project ${live.toFixed(0)} MB; after 100 commits heap +${retained.toFixed(0)} MB (≈${(retained / live).toFixed(0)}× live); structuredClone p50 ${p50.toFixed(0)} ms p95 ${p95.toFixed(0)} ms max ${max.toFixed(0)} ms`);
    if (variants === 3 && retained > 500) failures.push(`3 variants: 100 undo steps retain ${retained.toFixed(0)} MB`);
    if (p95 > 100) failures.push(`${variants} variant(s): each commit blocks ${p95.toFixed(0)} ms (p95) in structuredClone`);
    past = []; current = null;
  }

  console.log(failures.length ? `\nFAIL:\n - ${failures.join('\n - ')}` : '\nOK');
  await closeLoader();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await closeLoader(); process.exit(2); });
