/**
 * Tags OSM (revêtement, voie) le long de sorties d'un dossier, via BRouter
 * (proxy public, mis en cache sous l'identifiant `<préfixe><n>`).
 *
 *   npx tsx script-test-bench/pace-accuracy/enrich-dir.ts <dossier> <préfixe> [id…]
 */
import { enrichRide } from './lib/osm-enrich';
import { loadRidesFromDir } from './lib/rides';

const [dir, prefix = 'V', ...only] = process.argv.slice(2);
if (!dir) throw new Error('usage: enrich-dir.ts <dossier> <préfixe> [id…]');
const NAMES = ['inconnu', 'asphalte', 'pavé', 'gravier', 'terre', 'sable'];
for (const ride of loadRidesFromDir(dir, prefix)) {
  if (only.length && !only.includes(ride.id)) continue;
  const t0 = performance.now();
  const osm = await enrichRide(ride);
  const counts = new Map<number, number>();
  osm.trackSurface.forEach((s) => counts.set(s & 0x0f, (counts.get(s & 0x0f) ?? 0) + 1));
  const n = osm.trackSurface.length;
  console.log(`${ride.id} ${ride.label} : apparié ${(osm.matchedShare * 100).toFixed(0)} %, revêtements ${[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${NAMES[k]} ${((v / n) * 100).toFixed(1)} %`).join(', ')} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
}
