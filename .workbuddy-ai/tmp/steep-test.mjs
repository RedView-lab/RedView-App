// The dash amplitude is proportional to the true row-to-row elevation step,
// so the artefact only shows on STEEP terrain. Test steep flank locations at
// close zoom, through the full real slope pipeline, and quantify the spurious
// dY energy that the row duplication injects.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import vm from 'node:vm';

const ROOT = 'public/sw-dem';
const files = [
  `${ROOT}/core/config.js`, `${ROOT}/core/geo.js`, `${ROOT}/core/interpolation.js`,
  `${ROOT}/core/terrain-rgb.js`, `${ROOT}/sources/ign-fetcher.js`, `${ROOT}/workers/slope-math.js`,
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tileOf = (lng, lat, z) => vm.runInContext(`(() => { const n = 1 << ${z}; const x = Math.floor(((${lng} + 180) / 360) * n); const lr = ${lat} * Math.PI / 180; const y = Math.floor(((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n); return { z: ${z}, x, y }; })()`, ctx);

async function rawDegreeSquare(t) {
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
async function patched(t) {
  ctx.__z = t.z; ctx.__x = t.x; ctx.__y = t.y;
  for (let i = 0; i < 5; i++) {
    const r = await vm.runInContext('getMnsWmsTile(__z, __x, __y, null)', ctx);
    if (r) return r;
    await sleep(2000);
  }
  return null;
}
function cellSizes(t) {
  const b = vm.runInContext(`mercatorTileBounds(${t.z}, ${t.x}, ${t.y})`, ctx);
  const lr = ((b.north + b.south) / 2) * Math.PI / 180;
  return {
    cX: ((b.east - b.west) * Math.PI * 6378137 * Math.cos(lr) / 180) / S,
    cY: ((b.north - b.south) * Math.PI * 6378137 / 180) / S,
  };
}
// Spurious dY energy: RMS of the centred row difference, in metres per cell.
function dYrms(f) {
  let s = 0, n = 0;
  for (let y = 1; y < S - 1; y++) for (let x = 0; x < S; x++) {
    const v = (f[(y + 1) * S + x] - f[(y - 1) * S + x]) / 2;
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
  const raw = inflateSync(idat);
  const rowBytes = 1 + S * 4, px = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    const off = y * rowBytes + 1, dst = y * S * 4;
    for (let i = 0; i < S * 4; i++) px[dst + i] = (raw[off + i] + (i >= 4 ? px[dst + i - 4] : 0)) & 0xff;
  }
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
function pal(r) {
  const V = (r / 255) * 90; let i = 0;
  while (i < STOPS.length - 2 && V > STOPS[i + 1].v) i++;
  const a = STOPS[i], b = STOPS[Math.min(i + 1, STOPS.length - 1)];
  const t = b.v === a.v ? 0 : Math.max(0, Math.min(1, (V - a.v) / (b.v - a.v)));
  return [a.c[0] + (b.c[0] - a.c[0]) * t, a.c[1] + (b.c[1] - a.c[1]) * t, a.c[2] + (b.c[2] - a.c[2]) * t];
}
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

const OUT = '.workbuddy-ai/tmp';
const F = 3;
// steep flank locations (Alpe d'Huez / Villard-Reculas / Vercors cliffs)
const sites = [
  ['huez', 6.07, 45.09, [14, 15, 16]],
  ['vercors-cliff', 5.42, 44.96, [15]],
];
for (const [name, lng, lat, zooms] of sites) {
  for (const z of zooms) {
    const t = tileOf(lng, lat, z);
    const { cX, cY } = cellSizes(t);
    const before = await rawDegreeSquare(t);
    await sleep(1500);
    const after = await patched(t);
    if (!before || !after) { console.log(`${name} z${z}: fetch issue`); continue; }
    const dYB = dYrms(before), dYA = dYrms(after);
    console.log(`\n${name} z${z} (${t.x}/${t.y})  cell ${cX.toFixed(2)}x${cY.toFixed(2)} m`);
    console.log(`  spurious dY RMS: BEFORE=${dYB.toFixed(3)} m  AFTER=${dYA.toFixed(3)} m  (ratio ${(dYB / dYA).toFixed(2)}x)`);
    const imgs = [];
    for (const [label, elev] of [['BEFORE', before], ['AFTER', after]]) {
      const sRgba = slopeRgba(elev, t);
      ctx.__rgba = sRgba;
      const png = await vm.runInContext('buildRawPngSlope(DEM_TILE_SIZE, DEM_TILE_SIZE, __rgba).then(b => b.arrayBuffer())', ctx);
      const decoded = decodePng(Buffer.from(png));
      const mag = bilinear(decoded, F);
      const colored = new Uint8Array(mag.length);
      for (let i = 0; i < S * F * S * F; i++) { const c = pal(mag[i * 4]); colored[i * 4] = c[0]; colored[i * 4 + 1] = c[1]; colored[i * 4 + 2] = c[2]; colored[i * 4 + 3] = 255; }
      imgs.push({ label, img: colored, w: S * F, h: S * F });
      // mean slope of the decoded raster
      let sum = 0, n = 0;
      for (let i = 0; i < S * S; i++) if (decoded[i * 4 + 3]) { const V = (decoded[i * 4] / 255) * 90; sum += (V / 90) ** 2 * 90; n++; }
      console.log(`    ${label}: mean slope ${(sum / n).toFixed(1)} deg`);
    }
    const gap = 6, W = imgs[0].w * 2 + gap, H = imgs[0].h;
    const canvas = new Uint8Array(W * H * 4);
    imgs.forEach((r, k) => { const ox = k ? imgs[0].w + gap : 0; for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const si = (y * r.w + x) * 4, di = (y * W + ox + x) * 4; canvas[di] = r.img[si]; canvas[di + 1] = r.img[si + 1]; canvas[di + 2] = r.img[si + 2]; canvas[di + 3] = 255; } });
    for (let y = 0; y < H; y++) for (let x = imgs[0].w; x < imgs[0].w + gap; x++) { const i = (y * W + x) * 4; canvas[i] = canvas[i + 1] = canvas[i + 2] = 80; canvas[i + 3] = 255; }
    writeFileSync(`${OUT}/steep-${name}-z${z}.png`, encodePng(W, H, canvas));
    console.log(`    -> steep-${name}-z${z}.png`);
  }
}
console.log('\ndone');
