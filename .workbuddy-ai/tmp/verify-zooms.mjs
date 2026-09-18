// Run the PATCHED getMnsWmsTile() at every zoom the slope overlay engages,
// because the server's row-duplication ratio was constant (181/256) from z14 to
// z17 on the RAW request — the fix must hold at all of them.
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

const eqY = (f, w, h) => { let e = 0, t = 0; for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) { t++; if (f[y * w + x] === f[(y - 1) * w + x]) e++; } return 100 * e / t; };
const eqX = (f, w, h) => { let e = 0, t = 0; for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) { t++; if (f[y * w + x] === f[y * w + x - 1]) e++; } return 100 * e / t; };
const dist = (f, w, h) => { const s = new Set(); for (let y = 0; y < h; y++) { let k = 0; for (let x = 0; x < w; x++) k = (k * 31 + Math.round(f[y * w + x] * 100)) | 0; s.add(k); } return s.size; };
const comb = (f, w, h) => {
  const d = [];
  for (let y = 0; y + 1 < h; y++) { let s = 0, c = 0; for (let x = 0; x < w; x++) { const v = Math.abs(f[(y + 1) * w + x] - f[y * w + x]); if (Number.isFinite(v)) { s += v; c++; } } d.push(c ? s / c : 0); }
  let ev = 0, ne = 0, od = 0, no = 0;
  d.forEach((v, i) => { if (i % 2 === 0) { ev += v; ne++; } else { od += v; no++; } });
  const a = ev / ne, b = od / no;
  return Math.abs(a - b) / ((a + b) / 2 || 1);
};
// raw degree-square request, exactly what the pre-fix code sent
async function raw256(t) {
  const b = vm.runInContext(`mercatorTileBounds(${t.z}, ${t.x}, ${t.y})`, ctx);
  const u = `https://data.geopf.fr/wms-r/wms?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent('IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G')}&STYLES=&FORMAT=${encodeURIComponent('image/x-bil;bits=32')}&CRS=EPSG:4326&BBOX=${[b.south, b.west, b.north, b.east].join(',')}&WIDTH=256&HEIGHT=256`;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(u, { headers: { 'User-Agent': 'redview-probe' } });
    if (r.status === 429) { await sleep(1300 * (i + 1)); continue; }
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength !== S * S * 4) return null;
    return new Float32Array(buf);
  }
  return null;
}

const lng = 6.05, lat = 45.05;
for (const z of [13, 14, 15, 16, 17]) {
  const t = tileOf(lng, lat, z);
  const sz = vm.runInContext(`mnsWmsRequestSize(${t.z}, ${t.x}, ${t.y}, 1)`, ctx);
  const mpp = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (256 * (1 << z));
  console.log(`\nz${z}  ${mpp.toFixed(2)} m/px  tile ${t.x}/${t.y}  request ${sz.width}x${sz.height}`);

  const before = await raw256(t);
  await sleep(1400);
  if (before) console.log(`  BEFORE (degree-square 256x256) eqY=${eqY(before, S, S).toFixed(2).padStart(6)}% distinctRows=${dist(before, S, S)}/${S} comb=${comb(before, S, S).toFixed(3)}`);
  else console.log('  BEFORE: fetch failed');

  ctx.__z = t.z; ctx.__x = t.x; ctx.__y = t.y;
  let after = null;
  for (let i = 0; i < 4 && !after; i++) { after = await vm.runInContext('getMnsWmsTile(__z, __x, __y, null)', ctx); if (!after) await sleep(2000); }
  if (after) console.log(`  AFTER  (patched ${sz.width}x${sz.height})  eqY=${eqY(after, S, S).toFixed(2).padStart(6)}% distinctRows=${dist(after, S, S)}/${S} comb=${comb(after, S, S).toFixed(3)} eqX=${eqX(after, S, S).toFixed(2)}%`);
  else console.log('  AFTER: fetch failed');
  await sleep(1800);
}
