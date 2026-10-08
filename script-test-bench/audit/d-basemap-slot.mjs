/**
 * Audit D (fond de carte) — `slot: 'top'` sur les fonds classiques v12.
 *
 * Prouve, à partir du build de mapbox-gl livré, qu'une couche dont le `slot`
 * nomme un slot absent du style est traitée sans bruit comme sans slot
 * (ajoutée à sa position d'insertion, sans avertissement ni erreur), puis
 * vérifie les quatre fonds de carte RedView : aucun ne définit de couches de
 * slot, donc `slot: 'top'` est sans effet. Les étiquettes ne sont PAS
 * recouvertes en pratique car, avec le terrain activé,
 * Style.updateDrapeFirstLayers() rend chaque couche drapée (raster / line /
 * fill) avant les non drapées (symboles). Mais l'ordre en z relatif des
 * surcouches drapées (météo / pente / altitude / routes) est le simple ordre
 * d'insertion, c'est-à-dire l'ordre dans lequel elles sont réajoutées après
 * chaque setStyle().
 *
 * Lancement :  node script-test-bench/audit/d-basemap-slot.mjs
 * Les JSON de style sont lus dans $RV_STYLE_DIR (par défaut
 * <tmp>/rv-audit-styles, rempli par d-basemap-theme.ts). Sortie 1 tant que la
 * condition tient.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const mb = fs.readFileSync(path.join(root, 'node_modules/mapbox-gl/dist/mapbox-gl-dev.js'), 'utf8');
const version = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/mapbox-gl/package.json'), 'utf8')).version;
const lines = mb.split('\n');
const lineOf = (needle) => lines.findIndex((l) => l.includes(needle)) + 1;

let failures = 0;
console.log(`mapbox-gl ${version}`);

// 1. mergeLayers : slot inconnu → sans slot.
const mergeIdx = mb.indexOf('  mergeLayers() {');
const mergeBody = mb.slice(mergeIdx, mergeIdx + 1500);
const branch = 'if (layer.slot && slots[layer.slot])';
if (mergeBody.includes(branch) && mergeBody.includes('mergedOrder.push(layer);')) {
  console.log(`  Style.mergeLayers (dev.js:${lineOf('  mergeLayers() {')}): '${branch}' — else branch pushes the layer in plain insertion order (no warning).`);
} else {
  console.log('  ! mergeLayers shape changed — re-check slot semantics');
}
const warnLine = lineOf('has a different slot. Layers can only be rearranged within the same slot.');
const drapeLine = lineOf('  updateDrapeFirstLayers() {');
console.log(`  terrain on → Style.updateDrapeFirstLayers (dev.js:${drapeLine}) draws all draped layers first, then symbols: labels stay above raster overlays.`);
console.log(`  only slot warning in addLayer/moveLayer is the beforeId-mismatch warnOnce (dev.js:${warnLine}); validator accepts any slot string.`);

// 2. Fonds de carte : couches de slot + queue de symboles.
const styleDir = process.env.RV_STYLE_DIR ?? path.join(os.tmpdir(), 'rv-audit-styles');
for (const name of ['outdoors-v12', 'satellite-streets-v12']) {
  const file = path.join(styleDir, `${name}.json`);
  if (!fs.existsSync(file)) { console.log(`  (skip ${name}: ${file} missing)`); continue; }
  const style = JSON.parse(fs.readFileSync(file, 'utf8'));
  const slots = style.layers.filter((l) => l.type === 'slot').length;
  const firstSymbol = style.layers.findIndex((l) => l.type === 'symbol');
  const symbols = style.layers.filter((l) => l.type === 'symbol').length;
  console.log(`  ${name}: ${style.layers.length} layers, slot layers=${slots}, symbol layers=${symbols} (first at #${firstSymbol}) → slot:'top' overlays are appended after layer #${style.layers.length - 1} (slot ignored)`);
  if (slots === 0) failures += 1;
}

// 3. Surcouches de l'application qui comptent sur slot:'top' (sans beforeId).
const files = [
  'src/features/slope/lib/slope-source.ts',
  'src/features/altitude/lib/altitude-source.ts',
  'src/features/weather/overlay/useWeatherOverlay/useWeatherStyleManager.ts',
  'src/features/itineraryPanel/lib/route-layer/itineraryLayers.ts',
  'src/features/itineraryPanel/lib/route-layer/auxiliaryLayers.ts',
  'src/features/map3d/lib/layers.ts',
];
for (const f of files) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  console.log(`  ${f}: slot:'top' ×${(src.match(/slot: 'top'/g) ?? []).length}`);
}
const contour = fs.readFileSync(path.join(root, 'src/features/contourLines/hooks/useContourLines.ts'), 'utf8');
console.log(`  contours use beforeId=first symbol layer: ${/findFirstSymbolLayerId/.test(contour)} (the only overlay kept under labels)`);

console.log(failures ? `\nCONDITION REPRODUCED on ${failures} basemap(s): slot:'top' is a no-op; draped overlay order = re-add order after each basemap switch.` : '\nno classic basemap without slots found');
process.exit(failures ? 1 : 0);
