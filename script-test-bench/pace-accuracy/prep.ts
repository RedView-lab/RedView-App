/**
 * bench:pace:prep — prépare (réseau, une fois) les données dérivées des sorties :
 * tags OSM via BRouter (R8, mode B) et vent historique Open-Meteo (R9).
 *
 *   npx tsx script-test-bench/pace-accuracy/prep.ts [--refresh]
 */
import { enrichRide } from './lib/osm-enrich';
import { haversineM, loadRides } from './lib/rides';
import { headwindAlongRide } from './lib/wind';

async function main() {
  const refresh = process.argv.includes('--refresh');
  for (const ride of loadRides()) {
    const t0 = performance.now();
    const osm = await enrichRide(ride, { refresh });
    const p = osm.planned;
    const plannedKm = p.dist[p.dist.length - 1]! / 1000;
    const counts = new Map<number, number>();
    for (const w of osm.trackWay) counts.set(w & 0x0f, (counts.get(w & 0x0f) ?? 0) + 1);
    const urban = osm.trackWay.filter((w) => w & 0x40).length / osm.trackWay.length;
    const signals = p.way.filter((w) => w & 0x80).length;
    const unpaved = osm.trackSurface.filter((s) => (s & 0x0f) >= 3).length / osm.trackSurface.length;
    const endGap = haversineM(ride.track[ride.track.length - 1]!.lat, ride.track[ride.track.length - 1]!.lon, p.lat[p.lat.length - 1]!, p.lon[p.lon.length - 1]!);
    console.log(
      `${ride.id.padEnd(4)} apparié ${(osm.matchedShare * 100).toFixed(1)}%  route BRouter ${plannedKm.toFixed(1)} km (FIT ${(ride.distanceM / 1000).toFixed(1)})  `
      + `urbain ${(urban * 100).toFixed(0)}%  non revêtu ${(unpaved * 100).toFixed(1)}%  feux ${signals}  `
      + `classes ${[...counts.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${((v / osm.trackWay.length) * 100).toFixed(0)}%`).join(' ')}  `
      + `fin ${endGap.toFixed(0)} m  ${(performance.now() - t0).toFixed(0)} ms`,
    );
    await headwindAlongRide(ride);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
