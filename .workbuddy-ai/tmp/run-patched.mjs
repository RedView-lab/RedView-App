// Run the PATCHED SW modules in a VM sandbox and hit the live IGN server,
// so we validate the real shipped code path (not a re-implementation).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = 'public/sw-dem';
const files = [
  `${ROOT}/core/config.js`,
  `${ROOT}/core/geo.js`,
  `${ROOT}/core/interpolation.js`,
  `${ROOT}/sources/ign-fetcher.js`,
];

const sandbox = {
  console,
  fetch,
  AbortController,
  AbortSignal,
  performance,
  URL,
  URLSearchParams,
  Request,
  Response,
  Headers,
  setTimeout,
  clearTimeout,
  TextEncoder,
  TextDecoder,
  Math,
  Date,
  JSON,
  Number,
  Map,
  Set,
  Promise,
  Float32Array,
  Uint8Array,
  Uint16Array,
  Int32Array,
  DataView,
  ArrayBuffer,
  Error,
  isNaN,
  parseInt,
  parseFloat,
  caches: {
    open: async () => ({ match: async () => null, put: async () => {}, keys: async () => [], delete: async () => {} }),
  },
  self: { location: { href: 'https://example.test/sw-dem.js' }, addEventListener() {}, clients: { claim: async () => {} } },
  swLog: { isDebug: () => false, debug() {}, info() {}, warn: console.warn, error: console.error },
  navigator: { hardwareConcurrency: 8 },
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  try {
    vm.runInContext(src, ctx, { filename: f });
  } catch (e) {
    console.error('LOAD FAIL', f, e.message);
    process.exit(1);
  }
}
console.log('modules loaded OK');
console.log('DEM_TILE_SIZE =', vm.runInContext('DEM_TILE_SIZE', ctx));
console.log('MIN/MAX valid =', vm.runInContext('MIN_VALID_ELEVATION_M', ctx), vm.runInContext('MAX_VALID_ELEVATION_M', ctx));

// ── Request geometry across latitudes ─────────────────────────────────
console.log('\n-- mnsWmsRequestSize across France --');
for (const [name, lng, lat] of [['Pyrénées', 0.15, 42.8], ['Alpes', 6.05, 45.05], ['Vosges', 7.05, 48.3], ['Nord', 2.5, 50.6]]) {
  for (const z of [14, 15, 16]) {
    const r = vm.runInContext(`(() => { const n = 1 << ${z}; const x = Math.floor(((${lng} + 180) / 360) * n); const lr = ${lat} * Math.PI / 180; const y = Math.floor(((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n); const s = mnsWmsRequestSize(${z}, x, y, 1); return { x, y, w: s.width, h: s.height, url: buildMnsWmsTileURL(${z}, x, y, IGN_LIDAR_MNS_LAYER, s.width, s.height) }; })()`, ctx);
    if (z === 14) console.log(`  ${name.padEnd(9)} z${z} tile ${r.x}/${r.y} -> W=${r.w} H=${r.h}`);
  }
}

// ── Live call of the real getMnsWmsTile ───────────────────────────────
function eqY(f, w, h) { let e = 0, t = 0; for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) { t++; if (f[y * w + x] === f[(y - 1) * w + x]) e++; } return 100 * e / t; }
function eqX(f, w, h) { let e = 0, t = 0; for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) { t++; if (f[y * w + x] === f[y * w + x - 1]) e++; } return 100 * e / t; }
function comb(f, w, h) {
  const d = [];
  for (let y = 0; y + 1 < h; y++) { let s = 0, c = 0; for (let x = 0; x < w; x++) { const v = Math.abs(f[(y + 1) * w + x] - f[y * w + x]); if (Number.isFinite(v)) { s += v; c++; } } d.push(c ? s / c : 0); }
  let ev = 0, ne = 0, od = 0, no = 0;
  d.forEach((v, i) => { if (i % 2 === 0) { ev += v; ne++; } else { od += v; no++; } });
  const a = ev / ne, b = od / no;
  return Math.abs(a - b) / ((a + b) / 2 || 1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n-- live getMnsWmsTile() through the patched pipeline --');
const S = 256;
for (const [name, lng, lat] of [['Pyrénées', 0.15, 42.8], ['Alpes', 6.05, 45.05], ['Vosges', 7.05, 48.3]]) {
  const z = 14;
  const coords = vm.runInContext(`(() => { const n = 1 << ${z}; const x = Math.floor(((${lng} + 180) / 360) * n); const lr = ${lat} * Math.PI / 180; const y = Math.floor(((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n); return { x, y }; })()`, ctx);
  let out = null;
  for (let attempt = 0; attempt < 5 && !out; attempt++) {
    ctx.__z = z; ctx.__x = coords.x; ctx.__y = coords.y;
    try {
      out = await vm.runInContext('getMnsWmsTile(__z, __x, __y, null)', ctx);
    } catch (e) { console.log('  err', e.message); }
    if (!out) await sleep(2000);
  }
  if (!out) { console.log(`  ${name}: no tile (rate limited / no coverage)`); continue; }
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  for (const v of out) { if (Number.isFinite(v)) { n++; sum += v; if (v < min) min = v; if (v > max) max = v; } }
  console.log(`  ${name.padEnd(9)} z14 ${coords.x}/${coords.y} | len=${out.length} valid=${n}/${S * S} elev ${min.toFixed(0)}..${max.toFixed(0)} m mean=${(sum / n).toFixed(0)}`);
  console.log(`             eqY=${eqY(out, S, S).toFixed(2)}%  eqX=${eqX(out, S, S).toFixed(2)}%  comb(elev)=${comb(out, S, S).toFixed(3)}`);
  await sleep(2500);
}
