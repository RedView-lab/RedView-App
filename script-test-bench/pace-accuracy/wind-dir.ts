/**
 * Vent de face historique moyen (ERA5, cf. lib/wind.ts) par sortie d'un dossier, et
 * effet sur la prédiction (modèle calibré sur les autres sorties).
 *
 *   npx tsx script-test-bench/pace-accuracy/wind-dir.ts <dossier> <préfixe> [id…]
 */
import { loadPkg, predictV2, silenceConsole, trackToV2Route } from './lib/engine';
import { formatHms, loadRidesFromDir } from './lib/rides';
import { headwindAlongRide } from './lib/wind';

const [dir, prefix = 'V', ...only] = process.argv.slice(2);
if (!dir) throw new Error('usage: wind-dir.ts <dossier> <préfixe> [id…]');
const glue = await loadPkg();
const rides = loadRidesFromDir(dir, prefix);
for (const ride of rides) {
  if (only.length && !only.includes(ride.id)) continue;
  const wind = await headwindAlongRide(ride);
  const mean = wind.reduce((s, v) => s + v, 0) / wind.length;
  const share = wind.filter((v) => v > 2).length / wind.length;
  const model = silenceConsole(() => glue.calibrate_cycling(rides.filter((r) => r.id !== ride.id).map((r) => r.bytes), { rider: { custom: { gender: 'unspecified' } } }, () => {})).model;
  const calm = predictV2(glue, trackToV2Route(ride.track), { rider: { model }, geometry: 'gps' }).total_time_s;
  const windy = predictV2(glue, trackToV2Route(ride.track, { wind }), { rider: { model }, geometry: 'gps' }).total_time_s;
  const real = ride.movingTimeS;
  const pct = (t: number) => `${t >= real ? '+' : '−'}${Math.abs(((t - real) / real) * 100).toFixed(1)} %`;
  console.log(`${ride.label} : vent de face moyen ${mean.toFixed(2)} m/s (> 2 m/s sur ${(share * 100).toFixed(0)} % du parcours) | réel ${formatHms(real)} | sans vent ${formatHms(calm)} (${pct(calm)}) | avec vent ${formatHms(windy)} (${pct(windy)})`);
}
