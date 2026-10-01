/**
 * Validation « 4 jours → le 5e » sur le voyage Cham→Paris de Jo.
 *
 *   npx tsx script-test-bench/pace-accuracy/leave-one-day-out.ts [--pkg=<dir>]
 *
 * Pour chaque jour, le moteur est calibré sur les .fit des 4 autres jours puis
 * prédit le jour exclu. On compare au temps de roulage réel (pauses exclues) :
 *  - nouveau moteur sur la trace réelle du jour (altitude baro) ;
 *  - nouveau moteur sur l'itinéraire BRouter du jour (ce que l'app calculerait,
 *    altitude MNT, longueur légèrement différente) — cache de `bench:pace:prep` ;
 *  - ancien moteur (`.baseline-pkg`) sur la trace réelle.
 * J3 (deux enregistrements, matin et après-midi) compte pour un jour.
 */
import { BASELINE_PKG, loadPkg, predictLegacy, predictV2, silenceConsole, trackToRoutePoints, trackToV2Route, type V2Route } from './lib/engine';
import { enrichRide } from './lib/osm-enrich';
import { formatHms, loadRides, type Ride } from './lib/rides';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const DAYS: { id: string; label: string; rides: string[] }[] = [
  { id: 'J1', label: 'Chamonix → Genève (Forclaz)', rides: ['D1'] },
  { id: 'J2', label: 'Genève → Lons (Faucille)', rides: ['D2'] },
  { id: 'J3', label: 'Lons → Dijon', rides: ['D3a', 'D3b'] },
  { id: 'J4', label: 'Dijon → Troyes', rides: ['D4'] },
  { id: 'J5', label: 'Troyes → Paris', rides: ['D5'] },
];

const hm = (s: number) => formatHms(s);
const delta = (pred: number, real: number) => {
  const min = Math.round((pred - real) / 60);
  const pct = ((pred - real) / real) * 100;
  return `${min >= 0 ? '+' : '−'}${Math.abs(min)} min (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)} %)`;
};

async function main() {
  const glue = await loadPkg(arg('pkg'));
  const old = await loadPkg(BASELINE_PKG);
  const rides = loadRides();
  const byId = new Map(rides.map((r) => [r.id, r]));
  const osm = new Map<string, Awaited<ReturnType<typeof enrichRide>>>();
  for (const r of rides) osm.set(r.id, await enrichRide(r));

  const rows: string[] = [];
  const totals = { real: 0, a: 0, b: 0, old: 0 };
  const errs = { a: [] as number[], b: [] as number[], old: [] as number[] };

  for (const day of DAYS) {
    const dayRides = day.rides.map((id) => byId.get(id)!) as Ride[];
    const train = rides.filter((r) => !day.rides.includes(r.id));
    const cal = silenceConsole(() => glue.calibrate_cycling(train.map((r) => r.bytes), { rider: { custom: { gender: 'female' } } }, () => {}));
    const model = cal.model;

    let real = 0, a = 0, b = 0, o = 0, km = 0, kmB = 0, dplus = 0;
    for (const r of dayRides) {
      real += r.movingTimeS;
      km += r.distanceM / 1000;
      const predA = predictV2(glue, trackToV2Route(r.track), { rider: { model }, geometry: 'gps' });
      a += predA.total_time_s;
      dplus += predA.elevation_gain_m;
      const p = osm.get(r.id)!.planned;
      const planned: V2Route = {
        lat: Float64Array.from(p.lat), lon: Float64Array.from(p.lon), ele: Float64Array.from(p.ele), dist: Float64Array.from(p.dist),
        surface: Uint8Array.from(p.surface), way: Uint8Array.from(p.way), wind: new Float64Array(0),
      };
      const predB = predictV2(glue, planned, { rider: { model }, geometry: 'planned' });
      b += predB.total_time_s;
      kmB += predB.total_distance_m / 1000;
      const predOld = await predictLegacy(old, trackToRoutePoints(r.track), { kind: 'custom', fits: train.map((t) => t.bytes) });
      o += predOld.total_time_s;
    }
    totals.real += real; totals.a += a; totals.b += b; totals.old += o;
    errs.a.push((a - real) / real * 100); errs.b.push((b - real) / real * 100); errs.old.push((o - real) / real * 100);
    rows.push(`| ${day.id} ${day.label} | ${km.toFixed(0)} km · ${Math.round(dplus)} m | ${train.map((t) => t.id.replace('D', 'J').replace(/[ab]$/, '')).filter((v, i, s) => s.indexOf(v) === i).join(', ')} | **${hm(real)}** | ${hm(a)} | ${delta(a, real)} | ${hm(b)} (${kmB.toFixed(0)} km) | ${delta(b, real)} | ${hm(o)} | ${delta(o, real)} |`);
  }

  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const meanAbs = (v: number[]) => v.reduce((s, x) => s + Math.abs(x), 0) / v.length;
  console.log('| Jour prédit | Distance · D+ | Calibré sur | Roulage réel | Nouveau moteur (trace réelle) | Écart | Nouveau moteur (itinéraire BRouter) | Écart | Ancien moteur | Écart |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  rows.forEach((r) => console.log(r));
  console.log(`| **Voyage complet** | 724 km | — | **${hm(totals.real)}** | ${hm(totals.a)} | ${delta(totals.a, totals.real)} | ${hm(totals.b)} | ${delta(totals.b, totals.real)} | ${hm(totals.old)} | ${delta(totals.old, totals.real)} |`);
  console.log(`\nÉcart moyen par jour (absolu) : nouveau moteur ${meanAbs(errs.a).toFixed(1)} % (biais ${mean(errs.a).toFixed(1)} %) · itinéraire BRouter ${meanAbs(errs.b).toFixed(1)} % (biais ${mean(errs.b).toFixed(1)} %) · ancien moteur ${meanAbs(errs.old).toFixed(1)} % (biais ${mean(errs.old).toFixed(1)} %)`);
}

main().catch((e) => { console.error(e); process.exit(2); });
