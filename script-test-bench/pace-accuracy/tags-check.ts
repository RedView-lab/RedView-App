/**
 * Effet des revêtements OSM sur la prédiction d'une sortie exclue (modèle
 * calibré sur les autres sorties du dossier), trace réelle avec / sans tags.
 * Prérequis : `enrich-dir.ts` pour cette sortie (cache .cache/osm-<id>.json).
 *
 *   npx tsx script-test-bench/pace-accuracy/tags-check.ts <dossier> <préfixe> <id>
 */
import { loadPkg, predictV2, silenceConsole, trackToV2Route } from './lib/engine';
import { enrichRide } from './lib/osm-enrich';
import { formatHms, loadRidesFromDir } from './lib/rides';

const [dir, prefix = 'V', id] = process.argv.slice(2);
if (!dir || !id) throw new Error('usage: tags-check.ts <dossier> <préfixe> <id>');
const glue = await loadPkg();
const rides = loadRidesFromDir(dir, prefix);
const ride = rides.find((r) => r.id === id)!;
const train = rides.filter((r) => r.id !== id);
const model = silenceConsole(() => glue.calibrate_cycling(train.map((r) => r.bytes), { rider: { custom: { gender: 'unspecified' } } }, () => {})).model;
const osm = await enrichRide(ride);
const plain = predictV2(glue, trackToV2Route(ride.track), { rider: { model }, geometry: 'gps' });
const tagged = predictV2(glue, trackToV2Route(ride.track, { surface: Uint8Array.from(osm.trackSurface), way: Uint8Array.from(osm.trackWay) }), { rider: { model }, geometry: 'gps' });
const real = ride.movingTimeS;
const pct = (t: number) => `${t >= real ? '+' : '−'}${Math.abs(((t - real) / real) * 100).toFixed(1)} %`;
console.log(`${ride.label} : réel ${formatHms(real)} | sans revêtements ${formatHms(plain.total_time_s)} (${pct(plain.total_time_s)}) | avec revêtements OSM ${formatHms(tagged.total_time_s)} (${pct(tagged.total_time_s)})`);
