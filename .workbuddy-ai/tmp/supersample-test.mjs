// HYPOTHESIS: the IGN WMS point-samples (nearest-neighbour) the 0.40 m LiDAR-HD
// MNS into the requested grid instead of averaging, so requesting 256 rows over
// a 3.4 m/px tile aliases the canopy/rock micro-relief into a multi-metre row
// oscillation. Fix = supersample the request and box-average client-side.
//
// Test: same tile, requests at 256 / 512 / 1024 rows, box-averaged to 256,
// column dump + spurious-dY energy + rendered slope.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import vm from 'node:vm';

const ROOT = 'public/sw-dem';
const files = [
  `${ROOT}/core/config.js`, `${ROOT}/core/geo.js`, `${ROOT}/core/interpolation.js`,
  `${ROOT}/core/terrain-rgb.js`, `${ROOT}/workers/slope-math.js`,
];
const sandbox = {
  console, fetch, AbortController, AbortSignal, performance, URL, URLSearchParams, Request, Response, Headers,
  setTimeout, clearTimeout, TextEncoder, TextDecoder, Math, Date, JSON, Number, Map, Set, Promise,
  Float32Array, Uint8Array, Uint16Array, Int32Array, Uint32Array, DataView, ArrayBuffer, Blob, Error, isNaN, parseInt, parseFloat,
  CompressionStream: globalThis.CompressionStream,
  caches: { open: async () => ({ match: async () => null, put: async () => {}, keys: async () => [], delete: async () => {} }) },
  self: { location: { href: 'https://x.test/sw.js' }, addEventListener() {}, clients: { claim: async () => {} } },
  swLog: { isDebug: () => false, debug() {}, info() {}, warn() {}, error() {} },
  navigator: { hardwareConcurrency: 8 },
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
for (const f of files) vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });

const S = 256;
const MINV = -500, MAXV = 9000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tileOf = (lng, lat, z) => vm.runInContext(`(() => { const n = 1 << ${z}; const x = Math.floor(((${lng} + 180) / 360) * n); const lr = ${lat} * Math.PI / 180; const y = Math.floor(((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n); return { z: ${z}, x, y }; })()`, ctx);
const cellSizes = (t) => {
  const b = vm.runInContext(`mercatorTileBounds(${t.z}, ${t.x}, ${t.y})`, ctx);
  const lr = ((b.north + b.south) / 2) * Math.PI / 180;
  return { cX: ((b.east - b.west) * Math.PI * 6378137 * Math.cos(lr) / 180) / S, cY: ((b.north - b.south) * Math.PI * 6378137 / 180) / S };
};
async function fetchWms(t, w, h) {
  const b = vm.runInContext(`mercatorTileBounds(${t.z}, ${t.x}, ${t.y})`, ctx);
  const u = `https://data.geopf.fr/wms-r/wms?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent('IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G')}&STYLES=&FORMAT=${encodeURIComponent('image/x-bil;bits=32')}&CRS=EPSG:4326&BBOX=${[b.south, b.west, b.north, b.east].join(',')}&WIDTH=${w}&HEIGHT=${h}`;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(u, { headers: { 'User-Agent': 'redview-probe' } });
    if (r.status === 429) { await sleep(1400 * (i + 1)); continue; }
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength !== w * h * 4) return null;
    return new Float32Array(buf);
  }
  return null;
}
function boxAvg(raw, w, h) {
  const out = new Float32Array(S * S);
  const sx = w / S, sy = h / S;
  for (let y = 0; y < S; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(h, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < S; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(w, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const v = raw[yy * w + xx];
        if (!Number.isNaN(v) && v >= MINV && v <= MAXV) { s += v; n++; }
      }
      out[y * S + x] = n ? s / n : NaN;
    }
  }
  return out;
}
// "roughness": RMS of the 2nd difference along Y — measures row-scale noise
function roughY(f) {
  let s = 0, n = 0;
  for (let y = 1; y < S - 1; y++) for (let x = 0; x < S; x++) {
    const v = f[(y - 1) * S + x] - 2 * f[y * S + x] + f[(y + 1) * S + x];
    if (Number.isFinite(v)) { s += v * v; n++; }
  }
  return Math.sqrt(s / n);
}
function roughX(f) {
  let s = 0, n = 0;
  for (let y = 0; y < S; y++) for (let x = 1; x < S - 1; x++) {
    const v = f[y * S + x - 1] - 2 * f[y * S + x] + f[y * S + x + 1];
    if (Number.isFinite(v)) { s += v * v; n++; }
  }
  return Math.sqrt(s / n);
}
function slopeRgba(elev, t) {
  const { cX, cY } = cellSizes(t);
  ctx.__e = elev; ctx.__cx = cX; ctx.__cy = cY;
  return vm.runInContext('(() => { const p = buildPaddedElevationsFromArrays(__e, {}); return computeAndEncodeSlopeFused(p.pad, __e, __cx, __cy, p.edgeNeighbours); })()', ctx);
}
function pngChunks(buf) { const out = []; let o = 8; while (o + 8 <= buf.length) { const len = buf.readUInt32BE(o); out.push({ type: buf.toString('ascii', o + 4, o + 8), data: buf.subarray(o + 8, o + 8 + len) }); o += 12 + len; } return out; }
function decodePng(buf) {
  const idat = Buffer.concat(pngChunks(buf).filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = inflateSync(idat), rowBytes = 1 + S * 4, px = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) { const off = y * rowBytes + 1, dst = y * S * 4; for (let i = 0; i < S * 4; i++) px[dst + i] = (raw[off + i] + (i >= 4 ? px[dst + i - 4] : 0)) & 0xff; }
  return px;
}
function bilinear(px, f) {
  const w = S * f, out = new Uint8Array(w * w * 4);
  for (let y = 0; y < w; y++) {
    const sy = (y + 0.5) / f - 0.5, y0 = Math.max(0, Math.min(S - 1, Math.floor(sy))), y1 = Math.max(0, Math.min(S - 1, y0 + 1)), ty = sy - Math.floor(sy);
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) / f - 0.5, x0 = Math.max(0, Math.min(S - 1, Math.floor(sx))), x1 = Math.max(0, Math.min(S - 1, x0 + 1)), tx = sx - Math.floor(sx);
      const i00 = (y0 * S + x0) * 4, i10 = (y0 * S + x1) * 4, i01 = (y1 * S + x0) * 4, i11 = (y1 * S + x1) * 4, di = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) { const a = px[i00 + c] * (1 - tx) + px[i10 + c] * tx, b = px[i01 + c] * (1 - tx) + px[i11 + c] * tx; out[di + c] = Math.round(a * (1 - ty) + b * ty); }
      out[di + 3] = 255;
    }
  }
  return out;
}
const RAMP = ['#3FAE2A', '#77C043', '#B7CF3A', '#F1D43B', '#F6AD2F', '#F47C20', '#E84A27', '#C81E1E', '#6F1010', '#000000'];
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const rampColor = (t) => { const n = RAMP.length - 1, i = Math.min(Math.floor(t * n), n - 1), f = t * n - i; const a = hex(RAMP[i]), b = hex(RAMP[i + 1]); return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; };
const STOPS = [0, 10, 20, 30, 40, 50, 90].map((d, i) => ({ v: d === 0 ? 0 : Math.sqrt(d * 90), c: rampColor(i / 6) }));
function pal(r) { const V = (r / 255) * 90; let i = 0; while (i < STOPS.length - 2 && V > STOPS[i + 1].v) i++; const a = STOPS[i], b = STOPS[Math.min(i + 1, STOPS.length - 1)]; const t = b.v === a.v ? 0 : Math.max(0, Math.min(1, (V - a.v) / (b.v - a.v))); return [a.c[0] + (b.c[0] - a.c[0]) * t, a.c[1] + (b.c[1] - a.c[1]) * t, a.c[2] + (b.c[2] - a.c[2]) * t]; }
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b, s, l) => { let c = 0xffffffff; for (let i = s; i < s + l; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, d) { const b = new Uint8Array(12 + d.length), v = new DataView(b.buffer); v.setUint32(0, d.length); for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i); b.set(d, 8); v.setUint32(8 + d.length, crc32(b, 4, 4 + d.length)); return b; }
function encodePng(w, h, rgba) {
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1);
  const ih = new Uint8Array(13), v = new DataView(ih.buffer); v.setUint32(0, w); v.setUint32(4, h); ih[8] = 8; ih[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw), { level: 6 }))), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return Buffer.from(out);
}

const t = tileOf(6.07, 45.09, 15);
const { cX, cY } = cellSizes(t);
console.log(`tile ${t.z}/${t.x}/${t.y}  cell ${cX.toFixed(2)}x${cY.toFixed(2)} m`);
const variants = [
  ['WMS 256x256 (current)', 256, 256],
  ['WMS 512x362', 512, 362],
  ['WMS 724x512', 724, 512],
  ['WMS 1024x724', 1024, 724],
];
const COL = 60, R0 = 100, N = 24;
const panels = [];
for (const [label, w, h] of variants) {
  const raw = await fetchWms(t, w, h);
  await sleep(1500);
  if (!raw) { console.log(`${label}: fetch failed`); continue; }
  const out = boxAvg(raw, w, h);
  console.log(`\n${label} -> 256x256`);
  console.log(`  roughness: Y=${roughY(out).toFixed(3)} m  X=${roughX(out).toFixed(3)} m`);
  const vals = [];
  for (let y = R0; y < R0 + N; y++) vals.push(out[y * S + COL]);
  console.log('  col x=60 :', vals.map((v) => v.toFixed(2).padStart(8)).join(''));
  const d = [];
  for (let i = 1; i < vals.length; i++) d.push(vals[i] - vals[i - 1]);
  console.log('  delta y  :', d.map((v) => v.toFixed(2).padStart(8)).join(''));
  const sRgba = slopeRgba(out, t);
  ctx.__rgba = sRgba;
  const png = await vm.runInContext('buildRawPngSlope(DEM_TILE_SIZE, DEM_TILE_SIZE, __rgba).then(b => b.arrayBuffer())', ctx);
  const decoded = decodePng(Buffer.from(png));
  const mag = bilinear(decoded, 2);
  const colored = new Uint8Array(mag.length);
  for (let i = 0; i < S * 2 * S * 2; i++) { const c = pal(mag[i * 4]); colored[i * 4] = c[0]; colored[i * 4 + 1] = c[1]; colored[i * 4 + 2] = c[2]; colored[i * 4 + 3] = 255; }
  panels.push({ label, img: colored, w: S * 2, h: S * 2 });
}
if (panels.length) {
  const gap = 6, W = panels[0].w * panels.length + gap * (panels.length - 1), H = panels[0].h;
  const canvas = new Uint8Array(W * H * 4);
  panels.forEach((p, k) => { const ox = k * (p.w + gap); for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) { const si = (y * p.w + x) * 4, di = (y * W + ox + x) * 4; canvas[di] = p.img[si]; canvas[di + 1] = p.img[si + 1]; canvas[di + 2] = p.img[si + 2]; canvas[di + 3] = 255; } });
  for (let k = 1; k < panels.length; k++) { const x0 = k * (panels[0].w + gap) - gap; for (let y = 0; y < H; y++) for (let x = x0; x < x0 + gap; x++) { const i = (y * W + x) * 4; canvas[i] = canvas[i + 1] = canvas[i + 2] = 80; canvas[i + 3] = 255; } }
  writeFileSync('.workbuddy-ai/tmp/supersample-ab.png', encodePng(W, H, canvas));
  console.log(`\nwrote supersample-ab.png (${W}x${H}) — panels: ${panels.map((p) => p.label).join(' | ')}`);
}
