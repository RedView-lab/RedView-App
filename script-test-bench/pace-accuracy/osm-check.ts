/**
 * R8 — Apport des tags OSM (revêtement, type de voie, agglomération, feux).
 *
 *   npx tsx script-test-bench/pace-accuracy/osm-check.ts [--params=<json>]
 *
 * Calibre le modèle sur les traces FIT (mode A) sans tags, puis avec tags,
 * puis avec tags + paramètres d'agglomération, et compare la validation
 * croisée (LOO) du moteur. Affiche aussi l'écart réel / modèle par type de voie.
 */
import { loadPkg, predictV2, silenceConsole } from './lib/engine';
import { pct } from './lib/metrics';
import { enrichRide } from './lib/osm-enrich';
import { loadRides, realTimeAt, type Ride } from './lib/rides';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const WAY_NAMES = ['inconnu', 'grand axe', 'secondaire', 'petite route', 'résidentiel', 'piste cyclable', 'chemin', 'sentier'];

function toTrack(ride: Ride, surface?: number[], way?: number[]) {
  return {
    lat: ride.track.map((p) => p.lat),
    lon: ride.track.map((p) => p.lon),
    ele: ride.track.map((p) => p.ele),
    dist: ride.track.map((p) => p.d),
    t: ride.track.map((p) => p.t),
    surface: surface ?? [],
    way: way ?? [],
  };
}

async function main() {
  const glue = await loadPkg(arg('pkg'));
  const rides = loadRides();
  const osm = await Promise.all(rides.map((r) => enrichRide(r)));
  const prior = { custom: { gender: 'female' } };
  const urbanParams = arg('params') ? JSON.parse(arg('params')!) : { urban_slowdown_every_m: 400, signal_kmh: 14, urban_vmax_kmh: 28 };

  const variants: [string, any[], Record<string, unknown> | undefined][] = [
    ['sans tags', rides.map((r) => toTrack(r)), undefined],
    ['tags (revêtement)', rides.map((r, i) => toTrack(r, osm[i]!.trackSurface, osm[i]!.trackWay.map((w) => w & 0x0f))), undefined],
    ['tags + agglomération/feux', rides.map((r, i) => toTrack(r, osm[i]!.trackSurface, osm[i]!.trackWay)), urbanParams],
  ];
  console.log(`paramètres agglomération testés : ${JSON.stringify(urbanParams)}\n`);
  let baseModel: any = null;
  for (const [label, tracks, params] of variants) {
    const t0 = performance.now();
    const res = silenceConsole(() => glue.calibrate_cycling_tracks(tracks, { rider: prior, model_params: params }));
    const rep = res.report;
    if (!baseModel) baseModel = res.model;
    console.log(`${label.padEnd(28)} LOO médiane ${String(rep.loo_median_abs_pct).padStart(4)}%  max ${String(rep.loo_max_abs_pct).padStart(4)}%  in-sample ${rep.in_sample_median_abs_pct}%  `
      + `mult ${rep.multipliers.map((m: number) => m.toFixed(2)).join('/')}  (${(performance.now() - t0).toFixed(0)} ms)`);
    console.log(`   par sortie (LOO) : ${rep.rides.map((r: any, i: number) => `${rides[i]!.id} ${pct(r.loo_error_pct)}`).join('  ')}`);
  }

  // Résidus par type de voie (modèle calibré sans tags, plat −2..2 %).
  console.log('\nÉcart temps prédit / réel par type de voie (modèle sans tags, |pente| < 2 %) :');
  const acc = new Map<string, { km: number; real: number; pred: number }>();
  for (const [i, ride] of rides.entries()) {
    const tr = toTrack(ride);
    const pred = predictV2(glue, {
      lat: Float64Array.from(tr.lat), lon: Float64Array.from(tr.lon), ele: Float64Array.from(tr.ele), dist: Float64Array.from(tr.dist),
      surface: new Uint8Array(0), way: new Uint8Array(0), wind: new Float64Array(0),
    }, { rider: { model: baseModel }, geometry: 'gps' });
    const pts = pred.points;
    const track = ride.track;
    let j = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k]!, b = pts[k + 1]!;
      if (Math.abs(a.gradient_pct) > 2) continue;
      const mid = 0.5 * (a.distance_m + b.distance_m);
      while (j + 1 < track.length && track[j + 1]!.d < mid) j++;
      const w = osm[i]!.trackWay[j] ?? 0;
      const key = `${WAY_NAMES[w & 0x0f]}${w & 0x40 ? ' (agglo)' : ''}`;
      const e = acc.get(key) ?? { km: 0, real: 0, pred: 0 };
      e.km += (b.distance_m - a.distance_m) / 1000;
      e.real += realTimeAt(track, b.distance_m) - realTimeAt(track, a.distance_m);
      e.pred += a.segment_time_s;
      acc.set(key, e);
    }
  }
  for (const [key, e] of [...acc.entries()].sort((a, b) => b[1].km - a[1].km)) {
    if (e.km < 2) continue;
    console.log(`   ${key.padEnd(26)} ${e.km.toFixed(1).padStart(6)} km  réel ${(e.km / (e.real / 3600)).toFixed(1).padStart(5)} km/h  modèle ${(e.km / (e.pred / 3600)).toFixed(1).padStart(5)} km/h  écart ${pct(((e.pred - e.real) / e.real) * 100).padStart(7)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
