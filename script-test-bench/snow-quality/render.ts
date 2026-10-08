// ============================================================================
// Image avant / après du moteur neige
//   npm run bench:snow:image
// Écrit script-test-bench/reports/snow-quality/avant-apres.{html,png} :
//   1. relief réel (LiDAR HD de l'IGN, Aiguilles Rouges) avec une situation de
//      plein hiver plausible : v1 contre v2 ;
//   2. monde synthétique à référence connue : référence / v1 / v2 / erreurs.
// Le PNG est une capture d'écran Edge sans interface de la page HTML.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeSnowDistribution } from '../../src/features/snow/lib/engine/pipeline';
import type { SnowEngineResult } from '../../src/features/snow/lib/engine/types';
import { computeSnowRedistribution } from './legacy/redistribute';
import { DEFAULT_SNOW_CONFIG } from './legacy/config';
import { depthColor, encodePng, errorColor, hillshade, renderDepth } from './png';
import { buildRealScene } from './realTerrain';
import { REPORT_DIR, runScenario } from './run';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function pngUri(rgb: Uint8Array, w: number, h: number): string {
  return `data:image/png;base64,${Buffer.from(encodePng(rgb, w, h)).toString('base64')}`;
}

function stats(a: Float32Array) {
  let s = 0, covered = 0, max = 0, sCovered = 0;
  for (const v of a) {
    s += v;
    if (v > 1) { covered++; sCovered += v; }
    if (v > max) max = v;
  }
  return { mean: s / a.length, coverage: (100 * covered) / a.length, max, meanCovered: covered ? sCovered / covered : 0 };
}

function colorbar(kind: 'depth' | 'error'): string {
  const w = 360, h = 14;
  const rgb = new Uint8Array(w * h * 3);
  for (let x = 0; x < w; x++) {
    const c = kind === 'depth' ? depthColor((x / (w - 1)) * 500) : errorColor(((x / (w - 1)) * 2 - 1) * 150);
    for (let y = 0; y < h; y++) {
      const o = (y * w + x) * 3;
      rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
    }
  }
  return pngUri(rgb, w, h);
}

function legacyRun(z: Float32Array, n: number, size: number, legacy: { aromeData: Float32Array; aromeW: number; aromeH: number; aromeBounds: [number, number, number, number] }): Float32Array {
  const log = console.log;
  console.log = () => {};
  try {
    return computeSnowRedistribution({
      aromeData: legacy.aromeData, aromeW: legacy.aromeW, aromeH: legacy.aromeH, aromeBounds: legacy.aromeBounds,
      heightmap: z, terrainW: n, terrainH: n, terrainOrigin: [0, 0], terrainSize: [size, size],
      config: { ...DEFAULT_SNOW_CONFIG, maxResolution: n },
    }).data;
  } finally {
    console.log = log;
  }
}

const fmt = (v: number, d = 0) => v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

function engineSummary(r: SnowEngineResult): string {
  const d = r.diagnostics;
  const used = d.assimilation.stations.filter((s) => s.used).length;
  return [
    `${used} stations assimilées · précip. ×${fmt(d.assimilation.precipitationFactor, 2)}`,
    `vent ${fmt(d.wind.redistributedPct)} % · avalanches ${fmt(d.gravity.movedPct)} % · fonte à plat ${fmt(d.melt.flatMeltCm)} cm`,
  ].join('<br>');
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const cache = join(REPORT_DIR, 'cache');

  console.log('Relief réel (IGN LiDAR HD)…');
  const real = await buildRealScene(cache);
  const size = real.cell * (real.n - 1);
  const realV1 = legacyRun(real.z, real.n, size, real.legacy);
  const realV2 = computeSnowDistribution(real.input);
  const shadeReal = hillshade(real.z, real.n, real.n, real.cell);
  let zMin = Infinity, zMax = -Infinity;
  for (const v of real.z) { zMin = Math.min(zMin, v); zMax = Math.max(zMax, v); }
  const s1 = stats(realV1), s2 = stats(realV2.hsCm);

  console.log('Monde synthétique (vérité connue)…');
  const syn = runScenario('hiver-arome-biaise+stations');
  const n = syn.world.sceneW;
  const shadeSyn = hillshade(syn.world.sceneZ, n, n, syn.world.sceneCell);
  const err1 = syn.v1.map((v, i) => v - syn.world.truth[i]);
  const err2 = syn.v2.hsCm.map((v, i) => v - syn.world.truth[i]);
  const r = syn.result;

  const reliefOnly = renderDepth(new Float32Array(real.n * real.n), shadeReal, real.n, real.n);
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Neige — avant / après</title>
<style>
  :root { --ink: #1d232b; --muted: #5b6573; --line: #dde3ea; --bg: #f6f8fa; --accent: #2b5fb4; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.45 "Segoe UI", system-ui, sans-serif; width: 1800px; }
  main { padding: 36px 44px 28px; }
  h1 { font-size: 30px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); margin: 0 0 26px; font-size: 15px; }
  h2 { font-size: 19px; margin: 0 0 4px; }
  .note { color: var(--muted); font-size: 13.5px; margin: 0 0 14px; max-width: 1600px; }
  section { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 22px 24px; margin-bottom: 22px; }
  .row { display: flex; gap: 18px; }
  figure { margin: 0; }
  figure img { display: block; border-radius: 8px; border: 1px solid var(--line); image-rendering: auto; }
  figcaption { margin-top: 8px; font-size: 13.5px; color: var(--muted); }
  figcaption b { color: var(--ink); font-size: 15px; display: block; margin-bottom: 2px; }
  .big img { width: 548px; height: 548px; }
  .small img { width: 322px; height: 322px; }
  .tag { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 99px; margin-left: 6px; vertical-align: 2px; }
  .before { background: #fde8e6; color: #9b2c22; }
  .after { background: #e3edfb; color: #1f4f9a; }
  .legend { display: flex; gap: 36px; align-items: center; margin-top: 14px; font-size: 13px; color: var(--muted); }
  .legend img { display: block; width: 360px; height: 14px; border-radius: 3px; border: 1px solid var(--line); }
  .ticks { display: flex; justify-content: space-between; width: 360px; font-size: 12px; }
  table { border-collapse: collapse; margin-top: 14px; font-size: 13.5px; }
  th, td { padding: 6px 14px; border-bottom: 1px solid var(--line); text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  td.good { color: #1f4f9a; font-weight: 600; }
  footer { color: var(--muted); font-size: 12.5px; padding: 0 4px; }
</style></head><body><main>
  <h1>Répartition de la neige — avant / après</h1>
  <p class="sub">Moteur v1 (AROME interpolé + facteurs de terrain) contre moteur v2 (descente d'échelle altitudinale, assimilation des mesures, vent, avalanches, fonte par exposition).</p>

  <section>
    <h2>Relief réel — ${real.label}</h2>
    <p class="note">${fmt(zMin)}–${fmt(zMax)} m. Situation de neige plausible de début mars (pas de neige réelle le 4 octobre) : profil de mi-hiver du versant nord de Chamonix lu à l'orographie du modèle, AROME volontairement 20 % trop bas, 8 stations aux emplacements réels des postes Météo-France / Nivôse (valeurs du même profil ± 4 cm), coups de vent de nord-ouest puis une semaine ensoleillée.</p>
    <div class="row big">
      <figure><img src="${pngUri(reliefOnly, real.n, real.n)}"><figcaption><b>Relief</b>MNT LiDAR HD IGN, ombrage nord-ouest</figcaption></figure>
      <figure><img src="${pngUri(renderDepth(realV1, shadeReal, real.n, real.n), real.n, real.n)}"><figcaption><b>Avant <span class="tag before">v1</span></b>moyenne ${fmt(s1.mean)} cm · max ${fmt(s1.max)} cm · ${fmt(s1.coverage)} % enneigé</figcaption></figure>
      <figure><img src="${pngUri(renderDepth(realV2.hsCm, shadeReal, real.n, real.n), real.n, real.n)}"><figcaption><b>Après <span class="tag after">v2</span></b>moyenne ${fmt(s2.mean)} cm · max ${fmt(s2.max)} cm · ${fmt(s2.coverage)} % enneigé<br>${engineSummary(realV2)}</figcaption></figure>
    </div>
    <div class="legend">
      <div><img src="${colorbar('depth')}"><div class="ticks"><span>0</span><span>100</span><span>200</span><span>300</span><span>400</span><span>500 cm</span></div></div>
      <div>Gris-brun : sol nu (&lt; 1 cm).</div>
    </div>
  </section>

  <section>
    <h2>Monde synthétique à vérité connue — « hiver, AROME biaisé + stations »</h2>
    <p class="note">Relief alpin de synthèse (2,4 km, maille 3,8 m). La vérité vient d'un modèle de référence indépendant écrit dans le banc (autres formulations, autres paramètres). AROME : précipitations −30 % et limite pluie-neige +200 m ; ${r.stations?.count ?? 0} stations à ± 3 cm.</p>
    <div class="row small">
      <figure><img src="${pngUri(renderDepth(syn.world.truth, shadeSyn, n, n), n, n)}"><figcaption><b>Vérité</b>moyenne ${fmt(r.truthMeanCm)} cm</figcaption></figure>
      <figure><img src="${pngUri(renderDepth(syn.v1, shadeSyn, n, n), n, n)}"><figcaption><b>Avant <span class="tag before">v1</span></b>RMSE ${fmt(r.v1.rmseCm)} cm · biais ${fmt(r.v1.biasCm)} cm</figcaption></figure>
      <figure><img src="${pngUri(renderDepth(syn.v2.hsCm, shadeSyn, n, n), n, n)}"><figcaption><b>Après <span class="tag after">v2</span></b>RMSE ${fmt(r.v2.rmseCm)} cm · biais ${fmt(r.v2.biasCm)} cm</figcaption></figure>
      <figure><img src="${pngUri(renderDepth(err1, shadeSyn, n, n, 'error'), n, n)}"><figcaption><b>Erreur avant</b>v1 − vérité</figcaption></figure>
      <figure><img src="${pngUri(renderDepth(err2, shadeSyn, n, n, 'error'), n, n)}"><figcaption><b>Erreur après</b>v2 − vérité</figcaption></figure>
    </div>
    <div class="legend">
      <div><img src="${colorbar('error')}"><div class="ticks"><span>−150 cm (trop peu)</span><span>0</span><span>+150 cm (trop)</span></div></div>
    </div>
    <table>
      <tr><th>Indicateur</th><th>v1</th><th>v2</th></tr>
      <tr><td>Masse de neige / vérité</td><td>${fmt(r.v1.massRatio, 2)}</td><td class="good">${fmt(r.v2.massRatio, 2)}</td></tr>
      <tr><td>Biais moyen par tranche de 100 m d'altitude</td><td>${fmt(r.v1.bandBiasCm)} cm</td><td class="good">${fmt(r.v2.bandBiasCm)} cm</td></tr>
      <tr><td>Corrélation spatiale (pixel 3,8 m / 100 m)</td><td>${fmt(r.v1.r, 2)} / ${fmt(r.scales[1].v1.r, 2)}</td><td class="good">${fmt(r.v2.r, 2)} / ${fmt(r.scales[1].v2.r, 2)}</td></tr>
      <tr><td>Similarité structurelle (SSIM, blocs de 30 m)</td><td>${fmt(r.v1.ssim, 2)}</td><td class="good">${fmt(r.v2.ssim, 2)}</td></tr>
      <tr><td>Stations : erreur AROME brut → validation croisée</td><td>${fmt(r.stations?.backgroundRmseCm ?? 0)} cm</td><td class="good">${fmt(r.stations?.looRmseCm ?? 0)} cm</td></tr>
    </table>
  </section>
  <footer>Généré par npm run bench:snow:image — ${new Date().toISOString().slice(0, 10)}. Références : Grünewald et al. 2013/2014, Helbig et al. 2015, Bernhardt &amp; Schulz 2010, Gruber 2007, Quéno et al. 2024, Winstral et al. 2002, Liston &amp; Elder 2006, Li &amp; Pomeroy 1997, Varhola et al. 2010, Hock 1999, de Rosnay et al. (ECMWF) 2014.</footer>
</main></body></html>`;
  const htmlPath = join(REPORT_DIR, 'avant-apres.html');
  writeFileSync(htmlPath, html);
  console.log(`HTML : ${htmlPath}`);
  const pngPath = join(REPORT_DIR, 'avant-apres.png');
  if (existsSync(EDGE)) {
    const res = spawnSync(EDGE, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--window-size=1800,1790', `--screenshot=${pngPath}`, pathToFileURL(htmlPath).href,
    ], { stdio: 'ignore', timeout: 120_000 });
    console.log(res.status === 0 && existsSync(pngPath) ? `PNG : ${pngPath}` : 'Capture Edge impossible (ouvrir le HTML).');
  } else {
    console.log('Edge introuvable : ouvrir le HTML pour la planche.');
  }
}

void main();
