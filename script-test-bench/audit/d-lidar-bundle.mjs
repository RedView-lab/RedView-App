/**
 * Audit D / LIDAR — poids dans le bundle des index LAZ de Nouvelle-Zélande / du Japon.
 *
 *   node script-test-bench/audit/d-lidar-bundle.mjs        (nécessite un `dist/` récent)
 *
 * 1. dist/ : quel chunk embarque l'index NZ (URL pc-bulk d'opentopography) et
 *    l'index Japon (préfixes virtual-shizuoka), sa taille brute / gzip, et quels
 *    chunks d'entrée / pages HTML l'importent ou le préchargent (modulepreload)
 *    statiquement.
 * 2. Hypothèse esbuild (sans changer le source) : empaqueter les vrais modules
 *    avec `./nz/stacClient` + `./japan/stacClient` marqués externes montre que
 *    ces deux imports de downloader.ts sont les SEULES arêtes qui tirent les
 *    index dans le graphe du Dashboard (le barrel `./japan` de coordConvert est
 *    éliminé par le tree-shaking).
 * 3. CSP : chaque hôte LIDAR utilisé par src/features/lidar est autorisé par la
 *    CSP que le serveur de prod local (127.0.0.1:3000) envoie réellement sur
 *    `/` et `/viewer`.
 *
 * Code de sortie = nombre de contrôles qui reproduisent un problème.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { build, stop } from 'esbuild';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const NZ_MARK = 'opentopography.s3.sdsc.edu/pc-bulk/';
const JP_MARK = 'virtual-shizuoka.s3.ap-northeast-1.amazonaws.com/2019/LP/Ground/';
let problems = 0;
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';

// ── 1. analyse de dist ──────────────────────────────────────────────────
const assets = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => f.endsWith('.js'));
const heavy = [];
for (const f of assets) {
  const src = fs.readFileSync(path.join(DIST, 'assets', f), 'utf8');
  if (src.includes(NZ_MARK) || src.includes(JP_MARK)) {
    heavy.push({ f, raw: Buffer.byteLength(src), gz: zlib.gzipSync(src).length, nz: src.includes(NZ_MARK), jp: src.includes(JP_MARK) });
  }
}
for (const h of heavy) {
  console.log(`[dist] ${h.f}: ${mb(h.raw)} raw / ${mb(h.gz)} gzip, NZ index=${h.nz}, JP index=${h.jp}`);
  const staticImporters = [];
  for (const f of assets) {
    if (f === h.f) continue;
    const src = fs.readFileSync(path.join(DIST, 'assets', f), 'utf8');
    if (new RegExp(`from"\\./${h.f.replace(/[.$]/g, '\\$&')}"`).test(src)) staticImporters.push(f);
  }
  const preloadingHtml = ['index.html', 'viewer.html'].filter((p) => fs.readFileSync(path.join(DIST, p), 'utf8').includes(h.f));
  console.log(`[dist]   static importers: ${staticImporters.join(', ') || '(none)'}; modulepreloaded by: ${preloadingHtml.join(', ') || '(none)'}`);
  if (staticImporters.some((f) => /^Dashboard-|^viewer-|^main-/.test(f)) || preloadingHtml.length) problems++;
}
if (!heavy.length) console.log('[dist] no chunk embeds the NZ/JP indices (fixed?)');

// ── 2. hypothèse esbuild ────────────────────────────────────────────────
const cssStub = { name: 'stub-assets', setup(b) { b.onLoad({ filter: /\.(css|png|svg|wasm)$/ }, () => ({ contents: '', loader: 'js' })); } };
const externalStac = {
  name: 'external-stac',
  setup(b) { b.onResolve({ filter: /\/(nz|japan)\/stacClient$/ }, (a) => ({ path: a.path, external: true })); },
};
async function bundle(entry, plugins = []) {
  const r = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'browser', treeShaking: true,
    minify: true, packages: 'external', alias: { '@': path.join(ROOT, 'src') }, plugins: [cssStub, ...plugins], logLevel: 'silent',
    jsx: 'automatic',
  });
  const out = r.outputFiles[0].text;
  return { size: Buffer.byteLength(out), nz: out.includes(NZ_MARK), jp: out.includes(JP_MARK) };
}
const ctx = path.join(ROOT, 'src/features/lidar/components/LidarContext.tsx');
const cc = path.join(ROOT, 'src/features/lidar/lib/coordConvert.ts');
const now = await bundle(ctx);
const cut = await bundle(ctx, [externalStac]);
const ccOnly = await bundle(cc);
console.log(`[esbuild] LidarContext.tsx (Dashboard import) today: ${mb(now.size)} (NZ=${now.nz}, JP=${now.jp})`);
console.log(`[esbuild] same with nz|japan/stacClient external (= dynamic import in downloader.ts:7-8): ${mb(cut.size)} (NZ=${cut.nz}, JP=${cut.jp})`);
console.log(`[esbuild] coordConvert.ts alone (imports './japan' barrel): ${mb(ccOnly.size)} (NZ=${ccOnly.nz}, JP=${ccOnly.jp})`);
if (now.nz || now.jp) problems++;

// ── 3. couverture par la CSP ────────────────────────────────────────────
const hosts = new Set();
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name) && !/LazIndex\.ts$/.test(e.name)) {
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/https:\/\/([a-z0-9.${}-]+)\//gi)) hosts.add(m[1].replace(/\$\{[^}]+\}/g, '1'));
    }
  }
}
walk(path.join(ROOT, 'src/features/lidar'));
hosts.add('opentopography.s3.sdsc.edu'); // index NZ
hosts.add('virtual-shizuoka.s3.ap-northeast-1.amazonaws.com'); // index JP
hosts.add('japan-pointcloud.s3.ap-northeast-1.amazonaws.com'); // index JP
hosts.add('kanagawa-pointcloud.s3.ap-northeast-1.amazonaws.com'); // index JP
hosts.add('gsvrg.ipri.aist.go.jp'); // index JP (COPC AIST 3DDB)
hosts.delete('www.google.com'); // simple <a href>, pas récupéré
function allowed(directive, host) {
  return directive.split(/\s+/).some((src) => {
    const m = src.match(/^https:\/\/([^/]+)/);
    if (!m) return false;
    const pat = m[1];
    return pat.startsWith('*.') ? host.endsWith(pat.slice(1)) : host === pat;
  });
}
for (const page of ['/', '/viewer']) {
  let csp = '';
  try {
    const res = await fetch(`http://127.0.0.1:3000${page}`);
    csp = res.headers.get('content-security-policy') || '';
  } catch (e) {
    console.log(`[csp] local server unreachable: ${e.message}`);
    break;
  }
  const directive = (name) => csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + ' ')) || '';
  const missing = [...hosts].filter((h) => !allowed(directive('connect-src'), h) && !allowed(directive('img-src'), h));
  console.log(`[csp] ${page}: ${hosts.size} LIDAR hosts checked, not allowed: ${missing.join(', ') || 'none'}`);
  if (missing.length) problems++;
}
console.log(`[csp] hosts: ${[...hosts].sort().join(', ')}`);
console.log(`\n${problems} problem(s)`);
await stop();
process.exitCode = problems;

// ── 4. Coût d'évaluation des index du gros chunk (node/V8, processeur de bureau) ──
{
  const { transform } = await import('esbuild');
  for (const rel of ['src/features/lidar/lib/nz/nzLazIndex.ts', 'src/features/lidar/lib/japan/japanLazIndex.ts']) {
    const ts = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const { code } = await transform(ts, { loader: 'ts', format: 'cjs', minify: true });
    globalThis.gc?.();
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const mod = { exports: {} };
    new Function('module', 'exports', code)(mod, mod.exports);
    const dt = performance.now() - t0;
    const keys = Object.values(mod.exports).filter((v) => v && typeof v === 'object').reduce((n, o) => n + Object.keys(o).length, 0);
    console.log(`[eval] ${path.basename(rel)}: ${mb(code.length)} JS, parse+eval ${dt.toFixed(0)} ms, +${mb(process.memoryUsage().heapUsed - heap0)} heap, ${keys} keys`);
  }
  await stop();
}
