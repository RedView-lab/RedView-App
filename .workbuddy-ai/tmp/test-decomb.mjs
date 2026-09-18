// Does decombDuplicateRows() clean the fallback layers (correl / RGE ALTI),
// which carry a fixed 2x row upsampling independent of the request geometry?
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

const WMS = 'https://data.geopf.fr/wms-r/wms';
const LAYERS = {
  'lidarHD (primary)': 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G',
  'correl (fallback)': 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS',
  'RGE ALTI': 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES',
};
const S = 256;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tileOf = (lng, lat, z) => vm.runInContext(`(() => { const n = 1 << ${z}; const x = Math.floor(((${lng} + 180) / 360) * n); const lr = ${lat} * Math.PI / 180; const y = Math.floor(((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n); return { z: ${z}, x, y }; })()`, ctx);

function eqY(f, w, h) { let e = 0, t = 0; for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) { t++; if (f[y * w + x] === f[(y - 1) * w + x]) e++; } return 100 * e / t; }
function distinct(f, w, h) { const s = new Set(); for (let y = 0; y < h; y++) { let k = 0; for (let x = 0; x < w; x++) k = (k * 31 + Math.round(f[y * w + x] * 100)) | 0; s.add(k); } return s.size; }
function comb(f, w, h) {
  const d = [];
  for (let y = 0; y + 1 < h; y++) { let s = 0, c = 0; for (let x = 0; x < w; x++) { const v = Math.abs(f[(y + 1) * w + x] - f[y * w + x]); if (Number.isFinite(v)) { s += v; c++; } } d.push(c ? s / c : 0); }
  let ev = 0, ne = 0, od = 0, no = 0;
  d.forEach((v, i) => { if (i % 2 === 0) { ev += v; ne++; } else { od += v; no++; } });
  const a = ev / ne, b = od / no;
  return Math.abs(a - b) / ((a + b) / 2 || 1);
}
async function fetchRaster(t, layer, w, h) {
  const b = vm.runInContext(`mercatorTileBounds(${t.z}, ${t.x}, ${t.y})`, ctx);
  const u = `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent(layer)}&STYLES=&FORMAT=${encodeURIComponent('image/x-bil;bits=32')}&CRS=EPSG:4326&BBOX=${[b.south, b.west, b.north, b.east].join(',')}&WIDTH=${w}&HEIGHT=${h}`;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(u, { headers: { 'User-Agent': 'redview-probe' } });
    if (r.status === 429) { await sleep(1200 * (i + 1)); continue; }
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength !== w * h * 4) return null;
    return new Float32Array(buf);
  }
  return null;
}

const t = tileOf(6.05, 45.05, 14);
const sz = vm.runInContext(`mnsWmsRequestSize(${t.z}, ${t.x}, ${t.y}, 1)`, ctx);
console.log(`request geometry: ${sz.width}x${sz.height}\n`);
for (const [label, layer] of Object.entries(LAYERS)) {
  const raw = await fetchRaster(t, layer, sz.width, sz.height);
  await sleep(1400);
  if (!raw) { console.log(`${label}: fetch failed`); continue; }
  ctx.__raw = raw; ctx.__w = sz.width; ctx.__h = sz.height;
  const out = vm.runInContext('mnsWmsResampleToTile(__raw, __w, __h)', ctx);
  const repaired = vm.runInContext('(() => { const f = new Float32Array(__raw.length); f.set(__raw); return decombDuplicateRows(f, __w, __h); })()', ctx);
  console.log(`${label}`);
  console.log(`  raw ${sz.width}x${sz.height}   eqY=${eqY(raw, sz.width, sz.height).toFixed(2).padStart(6)}%  distinctRows=${distinct(raw, sz.width, sz.height)}/${sz.height}  comb=${comb(raw, sz.width, sz.height).toFixed(3)}`);
  console.log(`  decomb alone     eqY=${eqY(repaired, sz.width, sz.height).toFixed(2).padStart(6)}%  distinctRows=${distinct(repaired, sz.width, sz.height)}/${sz.height}  comb=${comb(repaired, sz.width, sz.height).toFixed(3)}   (rows repaired: ${repaired === raw ? '?' : ''})`);
  console.log(`  resample+decomb  eqY=${eqY(out, S, S).toFixed(2).padStart(6)}%  distinctRows=${distinct(out, S, S)}/${S}  comb=${comb(out, S, S).toFixed(3)}`);
}
