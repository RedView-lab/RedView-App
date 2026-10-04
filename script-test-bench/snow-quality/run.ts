// ============================================================================
// Snow quality bench: v1 (frozen) vs v2 engine on synthetic alpine worlds
// ----------------------------------------------------------------------------
//   npm run bench:snow                 physics checks + 4 scenarios + report
//   npm run bench:snow -- --quick      2 scenarios
//   npm run bench:snow -- --only=a,b   named scenarios
// Writes script-test-bench/reports/snow-quality/SNOW_QUALITY_REPORT.md and
// results.json. Exit code 1 when a physics check fails or v2 does not beat v1
// on its hard criteria (mass, altitude-band bias, correlation, station LOO).
//
// Honest scope: the reference snow comes from a model written in this bench
// (world.ts) with formulations and parameters different from the engine's;
// it tests downscaling, assimilation, conservation and process directions, not
// the real-world accuracy of the fine drift patterns (no measured maps yet).
// ============================================================================

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSnowDistribution } from '../../src/features/snow/lib/engine/pipeline';
import type { SnowEngineResult } from '../../src/features/snow/lib/engine/types';
import { runLegacy } from './legacyAdapter';
import { skill, type SkillMetrics } from './metrics';
import { runPhysicsChecks, type CheckResult } from './physics';
import { SCENARIOS } from './scenarios';
import { buildWorld, type World } from './world';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPORT_DIR = join(HERE, '..', 'reports', 'snow-quality');

export interface ScaleSkill {
  scaleM: number;
  v1: { r: number; rmseCm: number; nse: number };
  v2: { r: number; rmseCm: number; nse: number };
}

export interface ScenarioResult {
  name: string;
  analysis: string;
  sceneAltitude: [number, number];
  truthMeanCm: number;
  v1: SkillMetrics & { ms: number };
  v2: SkillMetrics & { ms: number };
  scales: ScaleSkill[];
  stations: { count: number; backgroundRmseCm: number; looRmseCm: number } | null;
  diagnostics: SnowEngineResult['diagnostics'];
}

function blockMean(a: Float32Array, n: number, b: number): Float32Array {
  const bw = Math.floor(n / b);
  const out = new Float32Array(bw * bw);
  for (let y = 0; y < bw * b; y++) for (let x = 0; x < bw * b; x++) out[Math.floor(y / b) * bw + Math.floor(x / b)] += a[y * n + x] / (b * b);
  return out;
}

function basic(m: Float32Array, t: Float32Array) {
  let mm = 0, mt = 0;
  for (let i = 0; i < m.length; i++) { mm += m[i]; mt += t[i]; }
  mm /= m.length; mt /= m.length;
  let c = 0, vm = 0, vt = 0, se = 0;
  for (let i = 0; i < m.length; i++) {
    c += (m[i] - mm) * (t[i] - mt);
    vm += (m[i] - mm) ** 2;
    vt += (t[i] - mt) ** 2;
    se += (m[i] - t[i]) ** 2;
  }
  return { r: vm > 0 && vt > 0 ? c / Math.sqrt(vm * vt) : 0, rmseCm: Math.sqrt(se / m.length), nse: vt > 0 ? 1 - se / vt : 0 };
}

export interface ScenarioRun {
  world: World;
  v1: Float32Array;
  v2: SnowEngineResult;
  result: ScenarioResult;
}

export function runScenario(name: string): ScenarioRun {
  const spec = SCENARIOS.find((s) => s.name === name);
  if (!spec) throw new Error(`unknown scenario ${name}`);
  const world = buildWorld(spec);
  const log = console.log;
  console.log = () => {};
  let t = performance.now();
  const v1 = runLegacy(world);
  const v1Ms = performance.now() - t;
  console.log = log;
  t = performance.now();
  const v2 = computeSnowDistribution(world.input);
  const v2Ms = performance.now() - t;
  const n = world.sceneW;
  const scales: ScaleSkill[] = [30, 100, 400].map((scaleM) => {
    const b = Math.max(1, Math.round(scaleM / world.sceneCell));
    const tb = blockMean(world.truth, n, b);
    return { scaleM, v1: basic(blockMean(v1, n, b), tb), v2: basic(blockMean(v2.hsCm, n, b), tb) };
  });
  let zMin = Infinity, zMax = -Infinity, tm = 0;
  for (let i = 0; i < world.sceneZ.length; i++) { zMin = Math.min(zMin, world.sceneZ[i]); zMax = Math.max(zMax, world.sceneZ[i]); tm += world.truth[i]; }
  const used = v2.diagnostics.assimilation.stations.filter((s) => s.used);
  const stations = used.length > 0 ? {
    count: used.length,
    backgroundRmseCm: Math.sqrt(used.reduce((a, s) => a + (s.backgroundCm - s.observedCm) ** 2, 0) / used.length),
    looRmseCm: Math.sqrt(used.reduce((a, s) => a + (s.looAnalysisCm - s.observedCm) ** 2, 0) / used.length),
  } : null;
  const result: ScenarioResult = {
    name,
    analysis: spec.analysisIso,
    sceneAltitude: [Math.round(zMin), Math.round(zMax)],
    truthMeanCm: tm / world.truth.length,
    v1: { ...skill(v1, world.truth, world.sceneZ, n, n, world.sceneCell), ms: v1Ms },
    v2: { ...skill(v2.hsCm, world.truth, world.sceneZ, n, n, world.sceneCell), ms: v2Ms },
    scales,
    stations,
    diagnostics: v2.diagnostics,
  };
  return { world, v1, v2, result };
}

/** Hard criteria v2 must meet on every scenario. */
function criteria(r: ScenarioResult): string[] {
  const fails: string[] = [];
  if (Math.abs(r.v2.massRatio - 1) > 0.3) fails.push(`masse v2 ${r.v2.massRatio.toFixed(2)} hors [0,7 ; 1,3]`);
  if (r.v2.bandBiasCm > r.v1.bandBiasCm) fails.push(`biais par tranche d'altitude v2 ${r.v2.bandBiasCm.toFixed(0)} > v1 ${r.v1.bandBiasCm.toFixed(0)} cm`);
  if (r.v2.r < r.v1.r) fails.push(`corrélation v2 ${r.v2.r.toFixed(2)} < v1 ${r.v1.r.toFixed(2)}`);
  if (r.v2.rmseCm > r.v1.rmseCm) fails.push(`RMSE v2 ${r.v2.rmseCm.toFixed(0)} > v1 ${r.v1.rmseCm.toFixed(0)} cm`);
  // Within the 3 cm station noise when AROME is already right.
  if (r.stations && r.stations.looRmseCm > Math.max(1.1 * r.stations.backgroundRmseCm, r.stations.backgroundRmseCm + 3)) {
    fails.push(`stations : LOO ${r.stations.looRmseCm.toFixed(0)} > AROME ${r.stations.backgroundRmseCm.toFixed(0)} cm`);
  }
  return fails;
}

const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);

export function renderReport(physics: CheckResult[], results: ScenarioResult[], date: string): string {
  const lines: string[] = [];
  lines.push('# Moteur neige v2 — banc de qualité', '');
  lines.push(`Généré le ${date} par \`npm run bench:snow\` (script-test-bench/snow-quality).`, '');
  lines.push('**Portée.** La vérité terrain est synthétique : un modèle de référence écrit dans le banc, avec des formulations et des paramètres différents de ceux du moteur (manteau degré-jour sans terme radiatif, vent statistique type Winstral, rétention exponentielle 20·e^(−0,065·S), routage ∝ pente⁴, fonte par exposition sans ombres portées, bruit corrélé de 12 %). Le banc vérifie la descente d’échelle, l’assimilation, la conservation de la masse et le sens des processus ; il ne mesure pas la justesse réelle des congères fines (pas encore de cartes de hauteur mesurées).', '');
  lines.push('## Tests physiques', '');
  lines.push('| Test | Résultat | Détail |', '|---|---|---|');
  for (const c of physics) lines.push(`| ${c.name} | ${c.pass ? 'OK' : '**ÉCHEC**'} | ${c.detail} |`);
  lines.push('');
  lines.push('## Scénarios (scène 2,4 km, maille 3,76 m)', '');
  lines.push('| Scénario | Date | Vérité moy. | RMSE v1 → v2 (cm) | Biais v1 → v2 (cm) | r v1 → v2 | Masse v1 → v2 | Biais/altitude v1 → v2 (cm) | SSIM 30 m v1 → v2 | κ neige v1 → v2 | Temps v1 / v2 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    lines.push(`| ${r.name} | ${r.analysis.slice(0, 10)} | ${f1(r.truthMeanCm)} cm | ${f1(r.v1.rmseCm)} → **${f1(r.v2.rmseCm)}** | ${f1(r.v1.biasCm)} → **${f1(r.v2.biasCm)}** | ${f2(r.v1.r)} → **${f2(r.v2.r)}** | ${f2(r.v1.massRatio)} → **${f2(r.v2.massRatio)}** | ${f1(r.v1.bandBiasCm)} → **${f1(r.v2.bandBiasCm)}** | ${f2(r.v1.ssim)} → **${f2(r.v2.ssim)}** | ${f2(r.v1.kappa)} → **${f2(r.v2.kappa)}** | ${(r.v1.ms / 1000).toFixed(1)} s / ${(r.v2.ms / 1000).toFixed(1)} s |`);
  }
  lines.push('');
  lines.push('### Par échelle d’agrégation (corrélation r et NSE)', '');
  lines.push('| Scénario | 30 m v1 → v2 | 100 m v1 → v2 | 400 m v1 → v2 |', '|---|---|---|---|');
  for (const r of results) {
    lines.push(`| ${r.name} | ${r.scales.map((s) => `r ${f2(s.v1.r)} → **${f2(s.v2.r)}**, NSE ${f2(s.v1.nse)} → **${f2(s.v2.nse)}**`).join(' | ')} |`);
  }
  lines.push('');
  lines.push('### Mesures (validation croisée : chaque station prédite par les autres)', '');
  lines.push('| Scénario | Stations | Erreur AROME brut (RMSE) | Erreur après assimilation (LOO) | Facteur précip. k | Décalage limite pluie-neige | BRA |', '|---|---|---|---|---|---|---|');
  for (const r of results) {
    const a = r.diagnostics.assimilation;
    if (!r.stations) lines.push(`| ${r.name} | 0 | – | – | ${f2(a.precipitationFactor)} | ${a.snowlineShiftM} m | ${a.braUsed ? 'oui' : 'non'} |`);
    else lines.push(`| ${r.name} | ${r.stations.count} | ${f1(r.stations.backgroundRmseCm)} cm | **${f1(r.stations.looRmseCm)} cm** | ${f2(a.precipitationFactor)} | ${a.snowlineShiftM} m | ${a.braUsed ? 'oui' : 'non'} |`);
  }
  lines.push('');
  lines.push('### Ce que le moteur a fait', '');
  lines.push('| Scénario | Gradient profil | Vent (source, % déplacé) | Avalanches (% déplacé) | Fonte à plat | Facteur radiatif (BRA) | σ modèle / σ Helbig |', '|---|---|---|---|---|---|---|');
  for (const r of results) {
    const d = r.diagnostics;
    lines.push(`| ${r.name} | ${f1(d.profile.gradientCmPer100m)} cm/100 m | ${d.wind.source}, ${f1(d.wind.redistributedPct)} % | ${f1(d.gravity.movedPct)} % | ${f1(d.melt.flatMeltCm)} cm | ${f2(d.melt.radiationScale)}${d.melt.braCalibrated ? ' (calé BRA)' : ''} | ${f1(d.variability.modelSigmaCm)} / ${f1(d.variability.targetSigmaCm)} cm |`);
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');
  const quick = args.includes('--quick');
  const names = only ?? (quick ? SCENARIOS.slice(0, 2).map((s) => s.name) : SCENARIOS.map((s) => s.name));
  console.log('Tests physiques…');
  const physics = runPhysicsChecks();
  for (const c of physics) console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name} — ${c.detail}`);
  const results: ScenarioResult[] = [];
  const failures: string[] = physics.filter((c) => !c.pass).map((c) => `physique : ${c.name}`);
  for (const name of names) {
    console.log(`Scénario ${name}…`);
    const { result } = runScenario(name);
    results.push(result);
    console.log(`  v1 RMSE ${f1(result.v1.rmseCm)} r ${f2(result.v1.r)} masse ${f2(result.v1.massRatio)} | v2 RMSE ${f1(result.v2.rmseCm)} r ${f2(result.v2.r)} masse ${f2(result.v2.massRatio)} (${(result.v2.ms / 1000).toFixed(1)} s)`);
    for (const f of criteria(result)) failures.push(`${name} : ${f}`);
  }
  mkdirSync(REPORT_DIR, { recursive: true });
  const date = new Date().toISOString();
  writeFileSync(join(REPORT_DIR, 'SNOW_QUALITY_REPORT.md'), renderReport(physics, results, date));
  writeFileSync(join(REPORT_DIR, 'results.json'), JSON.stringify({ date, physics, results }, null, 1));
  console.log(`Rapport : ${join(REPORT_DIR, 'SNOW_QUALITY_REPORT.md')}`);
  if (failures.length > 0) {
    console.log('Critères non tenus :');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('run.ts')) void main();
