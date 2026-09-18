// Dump a single DEM column so the row structure of the raster is readable as
// plain numbers (staircase / duplication / oscillation).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = 'public/sw-dem';
const files = [
  `${ROOT}/core/config.js`, `${ROOT}/core/geo.js`, `${ROOT}/core/interpolation.js`,
  `${ROOT}/sources/ign-fetcher.js`,
];
const sandbox = {
  console, fetch, AbortController, AbortSignal, performance, URL, URLSearchParams, Request, Response, Headers,
  setTimeout, clearTimeout, TextEncoder, TextDecoder, Math, Date, JSON, Number, Map, Set, Promise,
  Float32Array, Uint8Array, Uint16Array, Int32Array, Uint32Array, DataView, ArrayBuffer, Error, isNaN, parseInt, parseFloat,
  caches: { open: async () => ({ match: async () => null, put: async () => {}, keys: async () => [], delete: async () => {} }) },
  self: { location: { href: 'https://x.test/sw.js' }, addEventListener() {}, clients: { claim: async () => {} } },
  swLog: { isDebug: () => false, debug() {}, info() {}, warn() {}, error() {} },
  navigator: { hardwareConcurrency: 8 },
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
for (const f of files) vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });

const S = 256;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tileOf = (lng, lat, z) => vm.runInContext(`(() => { const n = 1 << ${z}; const x = Math.floor(((${lng} + 180) / 360) * n); const lr = ${lat} * Math.PI / 180; const y = Math.floor(((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n); return { z: ${z}, x, y }; })()`, ctx);

async function raw(t) {
  const b = vm.runInContext(`mercatorTileBounds(${t.z}, ${t.x}, ${t.y})`, ctx);
  const u = `https://data.geopf.fr/wms-r/wms?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent('IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G')}&STYLES=&FORMAT=${encodeURIComponent('image/x-bil;bits=32')}&CRS=EPSG:4326&BBOX=${[b.south, b.west, b.north, b.east].join(',')}&WIDTH=256&HEIGHT=256`;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(u, { headers: { 'User-Agent': 'redview-probe' } });
    if (r.status === 429) { await sleep(1300 * (i + 1)); continue; }
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    return buf.byteLength === S * S * 4 ? new Float32Array(buf) : null;
  }
  return null;
}

const t = tileOf(6.07, 45.09, 15);
const before = await raw(t);
await sleep(1500);
ctx.__z = t.z; ctx.__x = t.x; ctx.__y = t.y;
let after = null;
for (let i = 0; i < 5 && !after; i++) { after = await vm.runInContext('getMnsWmsTile(__z, __x, __y, null)', ctx); if (!after) await sleep(2000); }
console.log(`tile ${t.z}/${t.x}/${t.y}  before=${!!before} after=${!!after}`);

const COL = 60, R0 = 100, N = 46;
for (const [label, f] of [['BEFORE (degree-square)', before], ['AFTER (metre-square + decomb)', after]]) {
  if (!f) continue;
  console.log(`\n--- ${label} : column x=${COL}, rows ${R0}..${R0 + N - 1} ---`);
  const vals = [];
  for (let y = R0; y < R0 + N; y++) vals.push(f[y * S + COL]);
  console.log('  elevation:');
  console.log('   ', vals.map((v) => v.toFixed(2).padStart(8)).join(''));
  const d = [];
  for (let i = 1; i < vals.length; i++) d.push(vals[i] - vals[i - 1]);
  console.log('  delta y  :');
  console.log('   ', d.map((v) => v.toFixed(2).padStart(8)).join(''));
  // how many transitions are exactly zero vs near-zero
  const exact = d.filter((v) => v === 0).length;
  const near = d.filter((v) => v !== 0 && Math.abs(v) < 0.01).length;
  console.log(`  zero transitions: exact=${exact}/${d.length}  |delta|<1cm=${near}`);
  // horizontal delta on the same rows, for comparison
  const dx = [];
  for (let i = 1; i < vals.length; i++) dx.push(f[(R0 + i) * S + COL] - f[(R0 + i) * S + COL - 1]);
  console.log('  delta x (same rows, one col left):');
  console.log('   ', dx.map((v) => v.toFixed(2).padStart(8)).join(''));
}
