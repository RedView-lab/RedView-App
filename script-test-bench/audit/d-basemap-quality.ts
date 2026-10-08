/**
 * Audit D (fond de carte) — ordre sur le bus du sélecteur « Qualité 3D ».
 *
 * ControlPanelContainer publie via publishDem3dSelection() ; il publiait la
 * qualité EN PREMIER et le profil DEM EN SECOND. L'écouteur de qualité du
 * contrôleur de carte (useMapSubscriptions → lifecycle.setDem3dQuality →
 * demSource.ts:544-560) lit le profil de façon synchrone dans demProfileBus
 * pour construire l'URL des tuiles DEM. Quand l'utilisateur passe de « 30 m »
 * à « 1 m Sol Nu (MNT) », l'écouteur de qualité voit donc le profil PÉRIMÉ
 * ('default' = surface MNS 0,40 m), attache les tuiles MNS, et seulement
 * ensuite l'écouteur de profil bascule sur les tuiles MNT (second setTiles +
 * seconde vague de constructions DEM dans le SW).
 *
 * Lancement :  npx tsx script-test-bench/audit/d-basemap-quality.ts
 * Sortie 1 quand la lecture du profil périmé se reproduit.
 */
import { subscribeDem3dQuality, getActiveDem3dQuality } from '../../src/features/map3d/lib/dem3dQualityBus.ts';
import { subscribeDemProfilePreference, getActiveDemProfilePreference } from '../../src/features/map3d/lib/demProfileBus.ts';
import { publishDem3dSelection } from '../../src/features/map3d/lib/publishDem3dSelection.ts';

// Le vrai éditeur utilisé par ControlPanelContainer (aucune copie qui pourrait diverger).
const applyDem3dSelection = (value: string): void => publishDem3dSelection(value);

const events: string[] = [];
subscribeDem3dQuality((q) => {
  // Ce que demanderait demSource.setDem3dQuality('hd') : buildDemTilesTemplate(bust, getActiveDemProfile()).
  events.push(`quality→${q} (controller builds tiles for profile='${getActiveDemProfilePreference()}')`);
});
subscribeDemProfilePreference((p) => {
  events.push(`profile→${p} (reloadMapElevationForProfile: ${getActiveDem3dQuality() === 'fast-30m' ? 'no-op in fast-30m' : 'setTiles again'})`);
});

let failures = 0;
const transitions: Array<[string, string, string]> = [
  ['fast-30m', 'terrain-1m', 'terrain'],
  ['terrain-1m', 'fast-30m', 'default'],
  ['fast-30m', 'slow-040', 'default'],
  ['slow-040', 'terrain-1m', 'terrain'],
];
for (const [from, to, expectedProfile] of transitions) {
  applyDem3dSelection(from);
  events.length = 0;
  applyDem3dSelection(to);
  console.log(`${from} → ${to}`);
  for (const e of events) console.log(`   ${e}`);
  const hdBuild = events.find((e) => e.startsWith('quality→hd'));
  if (hdBuild && !hdBuild.includes(`profile='${expectedProfile}'`)) {
    failures += 1;
    console.log(`   FAIL HD terrain first bound with the stale profile (expected '${expectedProfile}') → double DEM tile wave`);
  }
}
console.log(failures ? `\nFAILURES: ${failures}` : '\nall checks passed');
process.exit(failures ? 1 : 0);
