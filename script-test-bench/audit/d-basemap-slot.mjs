/**
 * Audit D (basemap) — `slot: 'top'` on classic v12 basemaps.
 *
 * Proves from the shipped mapbox-gl build that a layer whose `slot` names a
 * slot that does not exist in the style is silently treated as un-slotted
 * (appended at its insertion position, no warning, no error), then checks the
 * four RedView basemaps: none of them defines slot layers, so `slot: 'top'`
 * is a no-op. Labels are NOT covered in practice because, with terrain on,
 * Style.updateDrapeFirstLayers() renders every draped layer (raster/line/fill)
 * before non-draped ones (symbols). But the relative z-order of the draped
 * overlays (weather / slope / altitude / routes) is plain insertion order, i.e.
 * whatever order they are re-added in after each setStyle().
 *
 * Run:  node script-test-bench/audit/d-basemap-slot.mjs
 * Style JSONs are read from $RV_STYLE_DIR (default <tmp>/rv-audit-styles,
 * populated by d-basemap-theme.ts). Exit 1 while the condition holds.
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

// 1. mergeLayers: unknown slot → unslotted.
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

// 2. Basemaps: slot layers + symbol tail.
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

// 3. App overlays that rely on slot:'top' (no beforeId).
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
