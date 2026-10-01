/**
 * C5c — Sonde : profil appris depuis un seul .fit sans puissance
 * (CHAMONIX_PARIS_à_vélo_JOUR_3*.fit) et vitesse prédite par classe de pente
 * sur GT20. Sortie != 0 si la vitesse moyenne prédite < 10 km/h (absurde pour
 * un cycliste dont la sortie réelle est bien plus rapide).
 *
 * Usage : npx tsx script-test-bench/audit/c-fit-jour3-probe.ts [fichier.fit ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultItinerary } from '../../src/features/itineraryPanel/lib/project/defaultState.ts';
import { buildPredictionConfigFromRhythm, buildRouteGpxFile } from '../../src/features/itineraryPanel/lib/schedule/container-prediction.ts';
import { FIT_DIR, GT20, loadWasm, readGpxPoints, silenceConsole } from './c-lib.ts';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const targets = files.length ? files : fs.readdirSync(FIT_DIR).filter((f) => f.includes('JOUR_3')).map((f) => path.join(FIT_DIR, f));
const glue = await loadWasm();
const it = createDefaultItinerary(1);
const points = readGpxPoints(GT20);
it.gpxRoute = { name: 'GT20', points } as never;
it.rhythm = { ...it.rhythm, rhythmProfile: 'custom', usePastActivities: true, ftp: null } as never;
const cfg = buildPredictionConfigFromRhythm(it.rhythm, points as never);
const gpx = new Uint8Array(await buildRouteGpxFile(it).arrayBuffer());

let bad = 0;
for (const f of targets) {
  const bytes = new Uint8Array(fs.readFileSync(f));
  const logs: string[] = [];
  const r = silenceConsole(() => glue.predict([bytes], gpx, cfg, (m: string) => logs.push(m)));
  const p = r.rider_profile ?? {};
  console.log(`\n${path.basename(f)} → ${(r.total_time_s / 3600).toFixed(1)} h, ${r.avg_speed_kmh.toFixed(1)} km/h`);
  console.log(`  profil : ${JSON.stringify(Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v !== 'object')))}`);
  for (const l of logs.filter((m) => /activit|Profil|KNN|ignor|Terminé/.test(m))) console.log(`  ${l}`);
  // vitesse prédite par pente
  const bins = new Map<number, { d: number; t: number }>();
  const pts = r.points as Array<{ distance_m: number; elapsed_time_s: number; gradient_pct?: number; grade_pct?: number }>;
  for (let i = 1; i < pts.length; i++) {
    const g = pts[i]!.gradient_pct ?? pts[i]!.grade_pct ?? NaN;
    const k = Number.isFinite(g) ? Math.max(-10, Math.min(10, Math.round(g / 2) * 2)) : 99;
    const b = bins.get(k) ?? { d: 0, t: 0 };
    b.d += pts[i]!.distance_m - pts[i - 1]!.distance_m; b.t += pts[i]!.elapsed_time_s - pts[i - 1]!.elapsed_time_s;
    bins.set(k, b);
  }
  console.log(`  vitesse prédite par pente : ${[...bins.entries()].sort((a, b) => a[0] - b[0]).map(([k, b]) => `${k === 99 ? '?' : `${k}%`}:${(b.d / b.t * 3.6).toFixed(1)}`).join('  ')}`);
  if (r.avg_speed_kmh < 10) bad++;
}
console.log(bad ? `\nFAIL ${bad} prédiction(s) < 10 km/h` : '\nOK');
process.exitCode = bad ? 1 : 0;
