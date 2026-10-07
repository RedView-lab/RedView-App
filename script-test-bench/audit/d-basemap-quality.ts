/**
 * Audit D (basemap) — "Qualité 3D" selector bus ordering.
 *
 * ControlPanelContainer publishes through publishDem3dSelection(); it used to publish the quality FIRST and
 * the DEM profile SECOND. The map controller's quality listener
 * (useMapSubscriptions → lifecycle.setDem3dQuality → demSource.ts:544-560)
 * reads the profile synchronously from demProfileBus to build the DEM tile
 * URL. When the user goes from "30 m" to "1 m Sol Nu (MNT)", the quality
 * listener therefore sees the STALE profile ('default' = 0.40 m MNS surface),
 * binds MNS tiles, and only then the profile listener swaps to MNT tiles
 * (second setTiles + second wave of SW DEM builds).
 *
 * Run:  npx tsx script-test-bench/audit/d-basemap-quality.ts
 * Exit 1 when the stale-profile read reproduces.
 */
import { subscribeDem3dQuality, getActiveDem3dQuality } from '../../src/features/map3d/lib/dem3dQualityBus.ts';
import { subscribeDemProfilePreference, getActiveDemProfilePreference } from '../../src/features/map3d/lib/demProfileBus.ts';
import { publishDem3dSelection } from '../../src/features/map3d/lib/publishDem3dSelection.ts';

// The real publisher used by ControlPanelContainer (no copy to drift).
const applyDem3dSelection = (value: string): void => publishDem3dSelection(value);

const events: string[] = [];
subscribeDem3dQuality((q) => {
  // What demSource.setDem3dQuality('hd') would request: buildDemTilesTemplate(bust, getActiveDemProfile()).
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
