/**
 * Audit D (fond de carte) — pipeline du thème RedView « Standard
 * (clair/sombre) », classeur des catégories d'étiquettes et coût d'une
 * sérialisation façon getStyle().
 *
 * Lancement :  npx tsx script-test-bench/audit/d-basemap-theme.ts
 *
 * A besoin du JSON du style Mapbox outdoors-v12. Cherché dans $RV_STYLE_DIR
 * (par défaut : dossier temporaire de l'OS /rv-audit-styles). S'il manque et
 * que VITE_MAPBOX_TOKEN est dans .env, il est récupéré UNE fois (1 requête) et
 * mis en cache.
 *
 * Code de sortie 1 quand une régression se reproduit :
 *   - le style thématisé ne passe pas la validation du style-spec Mapbox,
 *   - des couches du fond qui ne sont PAS des étiquettes / POI sont classées
 *     'poi' (masquées par la bascule d'étiquettes « POI »), ou des couches de
 *     l'application sont classées tout court.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import {
  applyBasemapTheme,
  REDVIEW_TOPO_DARK_STYLE_URL,
  REDVIEW_TOPO_LIGHT_STYLE_URL,
} from '../../src/features/map3d/lib/basemapThemes/index.ts';
import { buildThemeOverrides } from '../../src/features/map3d/lib/basemapThemes/engine.ts';
import { TOPO_LIGHT_PALETTE } from '../../src/features/map3d/lib/basemapThemes/palettes.ts';
import { getLayerCategory, isAppCustomLayer } from '../../src/features/labels/hooks/useLabels.ts';

const require = createRequire(import.meta.url);
const styleSpec = require('mapbox-gl/dist/style-spec/index.cjs') as {
  validate: (style: unknown) => Array<{ message: string }>;
};

type Layer = Record<string, unknown> & { id: string; type: string };
type Style = Record<string, unknown> & { layers: Layer[] };

const STYLE_DIR = process.env.RV_STYLE_DIR ?? path.join(os.tmpdir(), 'rv-audit-styles');

async function loadOutdoors(): Promise<Style> {
  const file = path.join(STYLE_DIR, 'outdoors-v12.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as Style;
  const env = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
  const token = /^VITE_MAPBOX_TOKEN=(.*)$/m.exec(env)?.[1]?.trim().replace(/^"|"$/g, '');
  if (!token) throw new Error(`No ${file} and no VITE_MAPBOX_TOKEN in .env`);
  const res = await fetch(`https://api.mapbox.com/styles/v1/mapbox/outdoors-v12?access_token=${token}`, {
    headers: { Origin: 'https://app.redview.tech' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching outdoors-v12`);
  const json = await res.json();
  fs.mkdirSync(STYLE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json));
  return json as Style;
}

// `clone()` de Mapbox (copie profonde des tableaux / objets simples), ce
// qu'appliquent Layout/Transitionable.getValue() à chaque serialize().
function mbClone<T>(input: T): T {
  if (Array.isArray(input)) return input.map(mbClone) as T;
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(input)) out[k] = mbClone((input as Record<string, unknown>)[k]);
    return out as T;
  }
  return input;
}

/** Forme de `Style.serialize()` → `_serializeLayers()` (paint / layout copiés en profondeur). */
function getStyleLike(style: Style): Style {
  return {
    ...style,
    sources: { ...(style.sources as object) },
    layers: style.layers.map((l) => ({
      id: l.id, type: l.type, slot: l.slot, source: l.source, 'source-layer': l['source-layer'],
      metadata: l.metadata, minzoom: l.minzoom, maxzoom: l.maxzoom, filter: l.filter,
      layout: l.layout ? mbClone(l.layout) : undefined,
      paint: l.paint ? mbClone(l.paint) : undefined,
    })) as Layer[],
  };
}

function bench(label: string, fn: () => void, iterations = 400): number {
  for (let i = 0; i < 30; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const per = (performance.now() - t0) / iterations;
  console.log(`  ${label}: ${per.toFixed(3)} ms/op`);
  return per;
}

let failures = 0;
const fail = (msg: string) => { failures += 1; console.log(`  FAIL ${msg}`); };
const ok = (msg: string) => console.log(`  ok   ${msg}`);

const base = await loadOutdoors();
console.log(`outdoors-v12: ${base.layers.length} layers, ${(JSON.stringify(base).length / 1024).toFixed(1)} KiB JSON`);

// ── 1. Pipeline du thème ─────────────────────────────────────────────────
console.log('\n[1] RedView themes (applyBasemapTheme on outdoors-v12)');
const baseIds = new Set(base.layers.map((l) => l.id));
const overrideIds = Object.keys(buildThemeOverrides(TOPO_LIGHT_PALETTE));
const orphan = overrideIds.filter((id) => !baseIds.has(id));
console.log(`  overrides: ${overrideIds.length}, matching layers: ${overrideIds.length - orphan.length}, orphan ids (no-op): ${orphan.length}`);
if (orphan.length) console.log(`    orphan: ${orphan.join(', ')}`);

for (const url of [REDVIEW_TOPO_LIGHT_STYLE_URL, REDVIEW_TOPO_DARK_STYLE_URL]) {
  const t0 = performance.now();
  const themed = applyBasemapTheme(url, structuredClone(base)) as Style;
  const ms = performance.now() - t0;
  const errors = styleSpec.validate(themed);
  const removed = base.layers.length - themed.layers.length;
  console.log(`  ${url}: ${ms.toFixed(1)} ms, ${themed.layers.length} layers (removed ${removed}), JSON ${(JSON.stringify(themed).length / 1024).toFixed(1)} KiB`);
  if (errors.length) fail(`${url} style-spec validation: ${errors.slice(0, 5).map((e) => e.message).join(' | ')}`);
  else ok(`${url} validates against mapbox-gl 3.x style-spec`);
  if (themed.layers.some((l) => l.id === 'contour-line' || l.id === 'contour-label')) fail('native contours not removed');
}

// Slot on a non-slot style: validator view.
{
  const s = structuredClone(base);
  s.layers.push({ id: 'slope-overlay', type: 'raster', source: 'composite', slot: 'top', paint: {} } as unknown as Layer);
  const errs = styleSpec.validate(s).filter((e) => /slot/i.test(e.message));
  console.log(`  slot:'top' on outdoors-v12 (no slot layers): validator slot errors = ${errs.length}${errs.length ? ` (${errs[0].message})` : ''}`);
}

// ── 2. Label classifier on real basemap + app layer ids ───────────────────
console.log('\n[2] useLabels.getLayerCategory on outdoors-v12 (+ satellite-streets if cached)');
const NON_LABEL_POI_RE = /^(road|bridge|tunnel)-(path-trail|rail|rail-tracks)$|^gate-fence-hedge$/;
const misfiled: string[] = [];
const byCategory: Record<string, number> = {};
for (const layer of base.layers) {
  const cat = getLayerCategory(layer as never) ?? 'none';
  byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  if (cat === 'poi' && layer.type !== 'symbol') misfiled.push(`${layer.id} (${layer.type})`);
}
console.log(`  categories: ${JSON.stringify(byCategory)}`);
if (misfiled.length) {
  fail(`${misfiled.length} non-symbol basemap layers classified 'poi' (hidden by the POI label toggle): ${misfiled.join(', ')}`);
  const trails = misfiled.filter((m) => NON_LABEL_POI_RE.test(m.split(' ')[0]));
  console.log(`    of which trails/rail/fences: ${trails.join(', ')}`);
}

const APP_LAYER_IDS = [
  'brouter-route-line-3f2a9c', 'brouter-route-casing-3f2a9c', 'brouter-route-gravel-pattern-3f2a9c',
  'brouter-analysis-hover-point-layer', 'brouter-analysis-hover-halo-layer',
  'brouter-route-hover-preview-point-layer', 'brouter-route-hover-preview-halo-layer',
  'brouter-analysis-selection-line-layer', 'brouter-analysis-flyover-progress-line-layer',
  'brouter-route-audit-line-layer', 'brouter-forbidden-zone-fill-layer', 'brouter-forbidden-zone-draft-vertex-layer',
  'redview-analysis-zone-fill-layer', 'redview-analysis-zone-draft-vertex', 'ign-ortho-layer',
  'rv-contour-lines-line', 'rv-poi-gpu-symbols', 'slope-overlay', 'altitude-overlay',
  'weather-overlay-layer-rain-radar', 'wind-particles', 'sunlight-map-image', 'shadow-image', 'sun-disk',
];
const OVERLAY_RE = /(road|street|highway|motorway|trunk|primary|secondary|tertiary|pedestrian|path|track|junction|shield|tunnel|bridge|traffic|railway|rail|transit|ferry|aerialway|aeroway|runway|taxiway|admin|boundary|border|country|state|province|poi|place|settlement|locality|natural|park|protected|water.*label|waterway.*label|marine.*label)/i;
// useLabels.isAppCustomLayer (désormais exporté) : les couches protégées de
// l'application sont sautées par applyAll / applyMasterDisable avant toute
// correspondance de motif.
for (const id of APP_LAYER_IDS) {
  if (isAppCustomLayer(id)) continue;
  const cat = getLayerCategory({ id, type: 'circle', slot: 'top' } as never);
  const masterHit = OVERLAY_RE.test(`${id} top`);
  if (cat || masterHit) fail(`app layer '${id}' NOT protected by isAppCustomLayer → category=${cat ?? 'none'} masterDisableMatch=${masterHit} (hidden by Étiquettes toggles)`);
}
const satFile = path.join(STYLE_DIR, 'satellite-streets-v12.json');
if (fs.existsSync(satFile)) {
  const sat = JSON.parse(fs.readFileSync(satFile, 'utf8')) as Style;
  const satPoi = sat.layers.filter((l) => l.type !== 'symbol' && getLayerCategory(l as never) === 'poi').map((l) => l.id);
  console.log(`  satellite-streets-v12 (${sat.layers.length} layers): non-symbol layers classified 'poi': ${satPoi.join(', ') || 'none'}`);
}

// ── 3. Coût façon getStyle() (piste 7) ───────────────────────────────────
console.log('\n[3] getStyle() cost model (Style.serialize deep-clones paint/layout of every layer)');
const themed = applyBasemapTheme(REDVIEW_TOPO_LIGHT_STYLE_URL, structuredClone(base)) as Style;
// Ajoute ~40 couches d'application (routes ×3 variantes, surcouches) pour imiter un projet chargé.
for (let i = 0; i < 40; i++) {
  themed.layers.push({ id: `brouter-route-line-${i}`, type: 'line', source: `s${i}`, paint: { 'line-color': '#f00', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 16, 6] } } as unknown as Layer);
}
const serialized = getStyleLike(themed);
console.log(`  serialized style: ${themed.layers.length} layers, JSON.stringify = ${(JSON.stringify(serialized).length / 1024).toFixed(1)} KiB`);
const perGetStyle = bench('getStyle()-like (deep clone paint/layout)', () => { getStyleLike(themed); });
const perApplyAll = bench('applyAll (getStyle + classify + getLayoutProperty clone per layer)', () => {
  const s = getStyleLike(themed);
  for (const l of s.layers) {
    const c = getLayerCategory(l as never);
    if (c) mbClone((l.layout as Record<string, unknown> | undefined)?.visibility);
  }
});
bench('JSON.stringify(getStyle()) (upper bound if someone stringifies)', () => { JSON.stringify(getStyleLike(themed)); }, 100);
console.log(`  → per styledata burst (labels only): ~${perApplyAll.toFixed(2)} ms; route replay adds 1 getStyle per route per replay (~${perGetStyle.toFixed(2)} ms each).`);

console.log(`\n${failures ? `FAILURES: ${failures}` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
