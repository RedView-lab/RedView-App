/**
 * RedView Workbench — assemble un seul fichier HTML autonome pour le designer :
 * copie noir et blanc du dashboard réel (capture.mjs), vraie mise en page
 * (modules de l'app bundlés), inspecteur typo / espacements, export JSON.
 *
 * Usage :
 *   npm run workbench                     capture (serveur dev requis) + HTML
 *   npm run workbench -- --skip-capture   HTML depuis .cache/capture.json
 *   npm run workbench -- --viewport 1920x953 --out chemin/fichier.html
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { ATTR_PROPS, buildOriginMap, parseSheet, workbenchCss } from './css.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = path.join(HERE, '.cache');
const argValue = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const OUT = path.resolve(ROOT, argValue('out') ?? path.join(HERE, 'out', 'redview-workbench.html'));
const log = (...a) => console.log('[build]', ...a);

// ── 1. Capture ────────────────────────────────────────────────────────────
if (!process.argv.includes('--skip-capture')) {
  const args = [path.join(HERE, 'capture.mjs')];
  for (const k of ['viewport', 'dpr']) if (argValue(k)) args.push(`--${k}`, argValue(k));
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const capture = JSON.parse(fs.readFileSync(path.join(CACHE, 'capture.json'), 'utf8'));

// ── 2. CSS de l'app en noir et blanc + métadonnées des règles ─────────────
const referenced = new Set();
for (const rec of Object.values(capture.attr)) {
  for (const e of Object.values(rec)) {
    for (const c of e.o ?? []) if (c[1]) referenced.add(c[1]);
    for (const [, cs] of e.h ?? []) for (const c of cs) if (c[1]) referenced.add(c[1]);
  }
}
const SHORTHAND_PROPS = ['font', 'padding', 'gap', 'padding-block', 'padding-inline'];
let appCss = '';
const rules = {};
const tokens = [];
for (const sheet of capture.sheets) {
  if (sheet.firstId == null) continue;
  const origin = buildOriginMap(path.resolve(ROOT, sheet.file), sheet.text, ROOT);
  const parsed = parseSheet(sheet.text, sheet.firstId, origin);
  for (const r of parsed.rules) {
    if (sheet.file === 'src/shared/styles/typography.css' && r.selector.trim() === ':root') {
      for (const [prop, value] of Object.entries(r.decls)) {
        const m = prop.match(/^--rv-font-size-(.+)$/);
        if (m) tokens.push({ name: prop, short: m[1], value });
      }
    }
    if (!referenced.has(r.id)) continue;
    const d = {};
    for (const p of [...ATTR_PROPS, ...SHORTHAND_PROPS]) if (r.decls[p] != null) d[p] = r.decls[p];
    rules[r.id] = { s: r.selector.replace(/\s+/g, ' ').trim(), f: r.file, l: r.line, c: r.conds, d };
  }
  appCss += `/* ${sheet.file} */\n${workbenchCss(parsed)}\n`;
}
log(`CSS app : ${(appCss.length / 1e3).toFixed(0)} ko, ${Object.keys(rules).length} règles référencées, ${tokens.length} tokens`);

// ── 3. Gris N&B ───────────────────────────────────────────────────────────
const hex = (v) => {
  const c = Math.max(0, Math.min(255, Math.round(v)));
  const h = c.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
};
/** Fonds : clairs (la maquette est blanche), noir pur pour les accents. */
const bgGray = (n) => (n === 0 ? 17 : n / 20 >= 0.86 ? 255 : 255 - (1 - n / 20) * 255 * 0.78);
const fgGray = (n) => (n / 20) * 235;
const bdGray = (n) => 255 - (1 - n / 20) * 255 * 0.82;
let bw = '';
for (let n = 0; n <= 20; n++) {
  bw += `.wb-b${n}{background-color:${hex(bgGray(n))}!important}`;
  bw += `.wb-c${n}{color:${hex(fgGray(n))}!important}`;
  bw += `.wb-d${n}{border-color:${hex(bdGray(n))}!important}`;
  for (const [s, side] of [['t', 'top'], ['r', 'right'], ['b', 'bottom'], ['l', 'left']]) {
    bw += `.wb-d${s}${n}{border-${side}-color:${hex(bdGray(n))}!important}`;
  }
  for (const [p, pseudo] of [['pb', 'before'], ['pa', 'after']]) {
    bw += `.wb-${p}${n}::${pseudo}{background-color:${hex(bgGray(n))}!important}`;
    bw += `.wb-${p}c${n}::${pseudo}{color:${hex(fgGray(n))}!important}`;
    bw += `.wb-${p}d${n}::${pseudo}{border-color:${hex(bdGray(n))}!important}`;
    for (const [s, side] of [['t', 'top'], ['r', 'right'], ['b', 'bottom'], ['l', 'left']]) {
      bw += `.wb-${p}d${s}${n}::${pseudo}{border-${side}-color:${hex(bdGray(n))}!important}`;
    }
  }
}

// ── 4. Fichiers de public/ (icônes en mask-image, <img>) embarqués ───────
const assetVars = new Map();
let assetCss = '';
function dataUri(urlPath) {
  const file = path.join(ROOT, 'public', decodeURIComponent(urlPath.split(/[?#]/)[0]));
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (/\.svg$/i.test(file)) return `data:image/svg+xml,${encodeURIComponent(buf.toString('utf8').replace(/\s+/g, ' ').trim())}`;
  const mime = /\.png$/i.test(file) ? 'image/png' : /\.jpe?g$/i.test(file) ? 'image/jpeg' : /\.webp$/i.test(file) ? 'image/webp' : null;
  return mime ? `data:${mime};base64,${buf.toString('base64')}` : null;
}
/** url(/chemin) → var(--wb-uN), une variable par fichier (définie sur :root). */
function assetVar(urlPath) {
  if (assetVars.has(urlPath)) return assetVars.get(urlPath);
  const uri = dataUri(urlPath);
  if (!uri) return null;
  const name = `--wb-u${assetVars.size}`;
  assetVars.set(urlPath, name);
  assetCss += `${name}:url("${uri}");`;
  return name;
}
const URL_RE = /url\((&quot;|"|')?(\/(?!\/)[^"')&]+?)(&quot;|"|')?\)/g;
const inlineUrls = (text) => text.replace(URL_RE, (m, q1, p) => {
  const v = assetVar(p);
  return v ? `var(${v})` : m;
});
const imgCache = new Map();
const withAssets = (html) => inlineUrls(html).replace(/ src="(\/(?!\/)[^"]+)"/g, (m, p) => {
  if (!imgCache.has(p)) imgCache.set(p, dataUri(p.replace(/&amp;/g, '&')));
  const uri = imgCache.get(p);
  return uri ? ` src="${uri.replace(/"/g, '&quot;')}"` : m;
});
appCss = inlineUrls(appCss);

// ── 5. Police (même CSS Google Fonts que index.html), embarquée ───────────
async function fontsCss() {
  const cacheFile = path.join(CACHE, 'fonts.css');
  if (fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile, 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const href = html.match(/href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)"/)[1].replace(/&amp;/g, '&');
  const css = await (await fetch(href, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' },
  })).text();
  let out = '';
  for (const block of css.split('/*').slice(1)) {
    const subset = block.slice(0, block.indexOf('*/')).trim();
    if (subset !== 'latin' && subset !== 'latin-ext') continue;
    const face = block.slice(block.indexOf('@font-face'));
    const url = face.match(/url\((https:[^)]+)\)/)[1];
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    out += face.replace(url, `data:font/woff2;base64,${buf.toString('base64')}`) + '\n';
  }
  fs.writeFileSync(cacheFile, out);
  return out;
}
const fonts = await fontsCss();

// ── 6. Mise en page : vrais modules de l'app (esbuild) ────────────────────
const scalePlugin = {
  name: 'wb-scale-params',
  setup(build) {
    build.onLoad({ filter: /shared[\\/]lib[\\/]appScale\.ts$/ }, async (args) => {
      let src = fs.readFileSync(args.path, 'utf8');
      const before = src;
      src = src.replace(/export const (APP_SCALE_(MAX|GROW_FACTOR|HIDPI_SHRINK_FACTOR|HIDPI_MIN))\b/g, 'export let $1');
      src = src.replace('export function computeAppScale(viewport: AppScaleViewport): number {', 'function __wbComputeAppScale(viewport: AppScaleViewport): number {');
      if (src === before || !src.includes('__wbComputeAppScale') || (src.match(/export let APP_SCALE_/g) ?? []).length !== 4) {
        throw new Error('appScale.ts a changé de forme : adapter le plugin wb-scale-params (build.mjs)');
      }
      src += `
let __wbForced: number | null = null;
export function __wbForceScale(scale: number | null) { __wbForced = scale; }
export function __wbSetScaleParams(p: { max?: number; grow?: number; hidpiShrink?: number; hidpiMin?: number }) {
  if (p.max != null) APP_SCALE_MAX = p.max;
  if (p.grow != null) APP_SCALE_GROW_FACTOR = p.grow;
  if (p.hidpiShrink != null) APP_SCALE_HIDPI_SHRINK_FACTOR = p.hidpiShrink;
  if (p.hidpiMin != null) APP_SCALE_HIDPI_MIN = p.hidpiMin;
}
export function __wbScaleParams() {
  return { max: APP_SCALE_MAX, grow: APP_SCALE_GROW_FACTOR, hidpiShrink: APP_SCALE_HIDPI_SHRINK_FACTOR, hidpiMin: APP_SCALE_HIDPI_MIN };
}
export function computeAppScale(viewport: AppScaleViewport): number {
  return __wbForced ?? __wbComputeAppScale(viewport);
}
`;
      return { contents: src, loader: 'ts' };
    });
  },
};
const layoutBundle = await esbuild.build({
  entryPoints: [path.join(HERE, 'runtime', 'layout-entry.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'RVLayout',
  platform: 'browser',
  target: 'es2020',
  tsconfig: path.join(ROOT, 'tsconfig.app.json'),
  plugins: [scalePlugin],
  minify: true,
  logLevel: 'error',
});
const layoutJs = layoutBundle.outputFiles[0].text;

// ── 7. Données (attribution dédupliquée) ──────────────────────────────────
const sets = [];
const setIndex = new Map();
const attr = {};
for (const [id, rec] of Object.entries(capture.attr)) {
  attr[id] = ATTR_PROPS.map((p) => {
    const e = rec[p];
    if (!e) return -1;
    const k = JSON.stringify(e);
    let i = setIndex.get(k);
    if (i == null) {
      i = sets.length;
      sets.push(e);
      setIndex.set(k, i);
    }
    return i;
  });
}
const mapRegions = (obj) => Object.fromEntries(Object.entries(obj).map(([k, html]) => [k, withAssets(typeof html === 'string' ? html : html.html)]));
const data = {
  meta: { ...capture.meta, props: ATTR_PROPS },
  order: Object.keys(capture.base),
  base: mapRegions(capture.base),
  triggers: capture.triggers.map((t) => ({
    ...t,
    patches: (t.patches || []).map((p) => ({ ...p, html: withAssets(p.html) })),
    layers: (t.layers || []).map((l) => ({ ...l, html: withAssets(l.html) })),
  })),
  el: capture.meta2,
  attr,
  sets,
  rules,
  tokens,
};
// Compressé (gzip + base64), décompressé par le runtime (DecompressionStream).
const rawJson = JSON.stringify(data);
const dataJson = zlib.gzipSync(Buffer.from(rawJson), { level: 9 }).toString('base64');

// ── 8. Assemblage ─────────────────────────────────────────────────────────
const runtimeCss = fs.readFileSync(path.join(HERE, 'runtime', 'workbench.css'), 'utf8');
const runtimeJs = fs.readFileSync(path.join(HERE, 'runtime', 'workbench.js'), 'utf8');
const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, minimum-scale=1.0">
<title>RedView Workbench</title>
<style id="wb-fonts">${fonts}</style>
<style id="wb-app">${appCss}</style>
<style id="wb-bw">${bw}:root{${assetCss}}</style>
<style id="wb-ui-css">${runtimeCss}</style>
</head>
<body>
<div id="wb-stage"><div id="wb-canvas" data-rv-canvas=""></div><div id="wb-portal"></div></div>
<div id="wb-ui"></div>
<script type="application/octet-stream" id="wb-data">${dataJson}</script>
<script>${layoutJs}</script>
<script>${runtimeJs}</script>
</body>
</html>
`;
const leak = (html + rawJson).match(/pk\.eyJ[\w-]{10,}|access_token=|sk_(live|test)_\w+/);
if (leak) throw new Error(`jeton détecté dans le HTML : ${leak[0].slice(0, 16)}…`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
log(`OK — ${(html.length / 1e6).toFixed(2)} Mo → ${path.relative(ROOT, OUT)}`);
