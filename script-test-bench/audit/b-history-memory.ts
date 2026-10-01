/**
 * Audit B3 — undo history cost (ProjectStore/useTraceHistory.ts).
 *
 *   node --expose-gc --import tsx script-test-bench/audit/b-history-memory.ts
 *
 * `commitTraceMutation` (used by every Tracer drag / Alt-variant / split /
 * merge…) does `structuredClone(projectRef.current)` of the WHOLE project and
 * keeps the previous state in `past` (MAX_HISTORY_STEPS = 100). Since the clone
 * shares nothing with the previous state, each step retains a full copy of
 * every variant's points/originalPoints/timeline.
 *
 * This script builds a realistic project from real GPX files (GT20 593 km,
 * imported like the app does: simplified `points` + full `originalPoints`),
 * with 1..3 variants, and replays 100 drag-like commits with the same
 * algorithm (clone → small mutation → push previous state, cap 100).
 *
 * Exit 1 if retained history for 3 variants exceeds 500 MB or one commit
 * blocks the main thread > 100 ms.
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
      const after = structuredClone(current); // useTraceHistory.ts:163
      times.push(performance.now() - t0);
      const wp = after.itineraries[0].timeline.find((r: any) => r.kind === 'waypoint');
      if (wp) wp.lat += 0.0001; // moveTracePointInItinerary-like edit
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
