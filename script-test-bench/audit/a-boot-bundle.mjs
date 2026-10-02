#!/usr/bin/env node
// Audit A / tâche 2 — poids de démarrage du bundle (dist/ fraîchement buildé).
//
// Usage : node script-test-bench/audit/a-boot-bundle.mjs [--dist=dist] [--json=out.json] [--no-brotli]
//
// Parcourt le graphe de modules à partir de dist/index.html :
//   - scénario "login"  : entry <script type=module> + <link rel=modulepreload> + CSS de index.html,
//                         plus leurs imports statiques transitifs (ce que charge l'écran de connexion) ;
//   - scénario "dashboard" : + import dynamique de Dashboard (App.tsx `lazy(() => import('./pages/Dashboard'))`)
//                         avec les dépendances préchargées par Vite (`__vite__mapDeps` / `m.f=[...]`)
//                         et les imports statiques transitifs de chacune.
// Rapporte brut / gzip-6 / gzip-9 / brotli par fichier et au total, avec et sans les
// index LiDAR NZ (nzLazIndex.ts, tableau `[{id:"NZ…",base:"…/pc-bulk/…"`) et Japon (japanLazIndex.ts, `[{…dir:"{z}/{L}/{s}/"`).
// Les ressources externes (Google Fonts, analytics, Mapbox GL CSS/tiles), les workers et
// les .wasm chargés à l'exécution ne sont PAS comptés dans le boot (listés à part).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const DIST = path.resolve(ROOT, args.dist || 'dist');
const BROTLI = !args['no-brotli'];

const readAsset = (rel) => fs.readFileSync(path.join(DIST, rel.replace(/^\//, '')));
const kb = (n) => (n / 1024).toFixed(1).padStart(9) + ' KiB';
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MiB';

const sizeCache = new Map();
function sizes(rel, buf = readAsset(rel)) {
  const key = rel + ':' + buf.length;
  if (sizeCache.has(key)) return sizeCache.get(key);
  const s = {
    raw: buf.length,
    gz6: zlib.gzipSync(buf, { level: 6 }).length,
    gz9: zlib.gzipSync(buf, { level: 9 }).length,
    br: BROTLI ? zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length : 0,
  };
  sizeCache.set(key, s);
  return s;
}

// ── Parsing du graphe ───────────────────────────────────────────────────────
const STATIC_IMPORT_RE = /(?:^|[;\s})])(?:import|export)\s*(?:\{[^}]*\}|\*\s*as\s*[\w$]+|[\w$]+(?:\s*,\s*\{[^}]*\})?)?\s*(?:from\s*)?["']\.\/([^"']+\.js)["']/g;
const DYN_IMPORT_RE = /import\(\s*[`"']\.\/([^`"']+\.js)[`"']\s*\)/g;
const MAPDEPS_RE = /m\.f\|\|\(m\.f=\[([^\]]*)\]\)/;
// Vite émet `new URL(`/assets/x.js`,``+import.meta.url)` (et `/redviewalgo_bg.wasm` en dur côté worker).
const WORKER_RE = /new URL\(\s*[`"'](?:\.\/|\/assets\/|\/)?([^`"']+?(?:\.js|\.wasm))[`"']\s*,\s*(?:``\s*\+\s*)?(?:import\.meta\.url|self\.location\.href)\s*\)/g;

const graph = new Map();
function parseChunk(rel) {
  if (graph.has(rel)) return graph.get(rel);
  const src = readAsset(rel).toString('utf8');
  const staticDeps = new Set();
  for (const m of src.matchAll(STATIC_IMPORT_RE)) staticDeps.add('assets/' + m[1]);
  const dynamic = [...new Set([...src.matchAll(DYN_IMPORT_RE)].map((m) => 'assets/' + m[1]))];
  const mapDepsRaw = MAPDEPS_RE.exec(src)?.[1];
  const mapDeps = mapDepsRaw ? [...mapDepsRaw.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  const runtime = [...new Set([...src.matchAll(WORKER_RE)].map((m) => m[1]))];
  const node = { rel, staticDeps: [...staticDeps], dynamic, mapDeps, runtime };
  graph.set(rel, node);
  return node;
}
function staticClosure(roots) {
  const out = new Set();
  const stack = [...roots];
  while (stack.length) {
    const rel = stack.pop();
    if (out.has(rel)) continue;
    out.add(rel);
    if (rel.endsWith('.js')) for (const d of parseChunk(rel).staticDeps) stack.push(d);
  }
  return out;
}

// ── Index LiDAR : plages d'octets de l'objet littéral ────────────────────────
function objectSpanAround(src, markerIdx, open = '{') {
  // remonte jusqu'à l'accolade (ou le crochet) ouvrant du littéral contenant le marqueur
  let start = src.lastIndexOf(open, markerIdx);
  let depth = 0;
  let inStr = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return [start, i + 1];
    }
  }
  return null;
}
const INDEX_MARKERS = [
  // Première occurrence = premier jeu du tableau, sans « [ » avant elle dans l'objet.
  { name: 'nzLazIndex (NZ_LIDAR_DATASETS)', marker: 'opentopography.s3.sdsc.edu/pc-bulk/', open: '[' },
  { name: 'japanLazIndex (JAPAN_LIDAR_DATASETS)', marker: '{z}/{L}/{s}/', open: '[' },
];
function stripIndexes(rel) {
  const buf = readAsset(rel);
  const src = buf.toString('latin1'); // 1 char = 1 octet, offsets cohérents avec le Buffer
  const spans = [];
  for (const { name, marker, open } of INDEX_MARKERS) {
    const idx = src.indexOf(marker);
    if (idx < 0) continue;
    const span = objectSpanAround(src, idx, open);
    if (span) spans.push({ name, start: span[0], end: span[1], bytes: span[1] - span[0] });
  }
  if (!spans.length) return null;
  spans.sort((a, b) => b.start - a.start);
  let out = src;
  for (const s of spans) out = out.slice(0, s.start) + '{}' + out.slice(s.end);
  return { spans, stripped: Buffer.from(out, 'latin1') };
}

// ── Scénarios ───────────────────────────────────────────────────────────────
const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const entry = [...html.matchAll(/<script[^>]+type="module"[^>]+src="\/(assets\/[^"]+)"/g)].map((m) => m[1]);
const preloads = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/(assets\/[^"]+)"/g)].map((m) => m[1]);
const cssLinks = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/(assets\/[^"]+)"/g)].map((m) => m[1]);
const externals = [...html.matchAll(/(?:src|href)="(https:\/\/[^"]+)"/g)].map((m) => m[1]).filter((u) => !/preconnect|dns-prefetch/.test(u));

const loginSet = staticClosure([...entry, ...preloads]);
for (const c of cssLinks) loginSet.add(c);

const entryNode = parseChunk(entry[0]);
const dashboardChunk = entryNode.dynamic.find((d) => /Dashboard-/.test(d));
const dashboardSet = new Set(loginSet);
if (dashboardChunk) {
  // mapDeps de main = deps du seul import dynamique (Dashboard) → toutes préchargées par __vitePreload
  const deps = [dashboardChunk, ...entryNode.mapDeps];
  for (const d of staticClosure(deps.filter((d) => d.endsWith('.js')))) dashboardSet.add(d);
  for (const d of deps) dashboardSet.add(d);
}

function table(label, set) {
  const rows = [...set].map((rel) => ({ rel, ...sizes(rel) })).sort((a, b) => b.raw - a.raw);
  const tot = rows.reduce((t, r) => ({ raw: t.raw + r.raw, gz6: t.gz6 + r.gz6, gz9: t.gz9 + r.gz9, br: t.br + r.br }), { raw: 0, gz6: 0, gz9: 0, br: 0 });
  console.log(`\n## ${label} — ${rows.length} files`);
  console.log(`${'file'.padEnd(42)}${'raw'.padStart(14)}${'gzip-6'.padStart(14)}${'gzip-9'.padStart(14)}${BROTLI ? 'brotli-9'.padStart(14) : ''}`);
  for (const r of rows) console.log(`${r.rel.padEnd(42)}${kb(r.raw)}${kb(r.gz6)}${kb(r.gz9)}${BROTLI ? kb(r.br) : ''}`);
  console.log(`${'TOTAL'.padEnd(42)}${kb(tot.raw)}${kb(tot.gz6)}${kb(tot.gz9)}${BROTLI ? kb(tot.br) : ''}   (${mb(tot.raw)} raw / ${mb(tot.gz6)} gz6)`);
  return { rows, tot };
}

console.log(`# a-boot-bundle — ${DIST}`);
console.log(`entry=${entry.join(',')} modulepreload=${preloads.join(',')} css=${cssLinks.join(',')}`);
console.log(`external (not counted): ${externals.join(' , ')}`);
console.log(`Dashboard dynamic import: ${dashboardChunk}; preloaded deps (m.f): ${entryNode.mapDeps.join(', ')}`);

const login = table('Login screen (unauthenticated) — boot download', loginSet);
const dash = table('Authenticated user — boot + Dashboard (incl. preloaded deps)', dashboardSet);

// Sans index NZ / Japon
let saved = { raw: 0, gz6: 0, gz9: 0, br: 0 };
const indexReport = [];
for (const rel of dashboardSet) {
  if (!rel.endsWith('.js')) continue;
  const s = stripIndexes(rel);
  if (!s) continue;
  const before = sizes(rel);
  const after = sizes(rel + '#stripped', s.stripped);
  // Coût de parse/évaluation des littéraux (thread principal, V8) — indicatif
  for (const sp of s.spans) {
    const lit = readAsset(rel).toString('latin1').slice(sp.start, sp.end);
    const t0 = performance.now();
    const v = vm.runInNewContext('(' + lit + ')');
    sp.evalMs = Math.round(performance.now() - t0);
    sp.keys = Object.keys(v).length;
  }
  indexReport.push({ rel, spans: s.spans.map(({ name, bytes, keys, evalMs }) => ({ name, bytes, keys, evalMs })), before, after });
  for (const k of Object.keys(saved)) saved[k] += before[k] - after[k];
  console.log(`\n## LiDAR indexes inside ${rel}`);
  for (const sp of s.spans) console.log(`  ${sp.name.padEnd(36)} ${kb(sp.bytes)} raw literal, ${sp.keys} keys, node vm parse+eval ${sp.evalMs} ms`);
  console.log(`  chunk with indexes   : ${kb(before.raw)} raw ${kb(before.gz6)} gz6 ${BROTLI ? kb(before.br) + ' br' : ''}`);
  console.log(`  chunk without indexes: ${kb(after.raw)} raw ${kb(after.gz6)} gz6 ${BROTLI ? kb(after.br) + ' br' : ''}`);
}
const noIdx = Object.fromEntries(Object.entries(dash.tot).map(([k, v]) => [k, v - saved[k]]));
console.log(`\n## Authenticated boot WITHOUT NZ/Japan indexes`);
console.log(`  raw ${mb(noIdx.raw)} | gzip-6 ${mb(noIdx.gz6)} | gzip-9 ${mb(noIdx.gz9)}${BROTLI ? ` | brotli-9 ${mb(noIdx.br)}` : ''}`);
console.log(`  indexes account for ${(100 * saved.raw / dash.tot.raw).toFixed(1)}% raw, ${(100 * saved.gz6 / dash.tot.gz6).toFixed(1)}% gzip-6 of authenticated boot JS+CSS`);

// Ressources d'exécution (workers, wasm) référencées par les chunks du boot — non comptées
const runtime = new Set();
for (const rel of dashboardSet) if (rel.endsWith('.js')) for (const r of parseChunk(rel).runtime) runtime.add(r);
const allAssets = fs.readdirSync(path.join(DIST, 'assets'));
const runtimeRows = [...runtime].map((r) => {
  const base = path.basename(r);
  const file = allAssets.includes(base) ? `assets/${base}` : (fs.existsSync(path.join(DIST, base)) ? base : null);
  return { ref: r, file, raw: file ? readAsset(file).length : 0 };
});
if (runtimeRows.length) {
  console.log(`\n## Runtime-loaded (workers / wasm via new URL(…, import.meta.url)) — not in boot totals`);
  for (const r of runtimeRows) console.log(`  ${String(r.ref).padEnd(44)} ${r.file ? kb(r.raw) : '(unresolved)'}`);
}
// Chunks jamais atteints depuis index.html (viewer, workers…)
const unreached = allAssets.filter((f) => !dashboardSet.has('assets/' + f));
console.log(`\nassets not in authenticated boot: ${unreached.join(', ')}`);

// Doublon : viewer.html importe aussi lazParser ?
for (const v of ['viewer.html']) {
  if (!fs.existsSync(path.join(DIST, v))) continue;
  const vh = fs.readFileSync(path.join(DIST, v), 'utf8');
  const ve = [...vh.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  const vset = staticClosure(ve.filter((x) => x.endsWith('.js')));
  for (const c of ve) vset.add(c);
  const vt = [...vset].reduce((t, rel) => t + readAsset(rel).length, 0);
  console.log(`\n${v} static boot: ${[...vset].join(', ')} → ${mb(vt)} raw`);
}

if (args.json) {
  fs.writeFileSync(String(args.json), JSON.stringify({ login: login.tot, dashboard: dash.tot, withoutIndexes: noIdx, indexReport, loginFiles: [...loginSet], dashboardFiles: [...dashboardSet], runtime: runtimeRows }, null, 2));
}
