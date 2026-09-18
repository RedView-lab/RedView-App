// Final deliverable: BEFORE (current degree-square WMS) vs AFTER (patched pipeline),
// rendered with the real slope kernel from slope-math.js and the app's actual
// colour ramp, so the artifact and its removal are directly comparable to the
// user's screenshot.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import vm from 'node:vm';

const ROOT = 'public/sw-dem';
const files = [
  `${ROOT}/core/config.js`, `${ROOT}/core/geo.js`, `${ROOT}/core/interpolation.js`,
  `${ROOT}/core/terrain-rgb.js`, `${ROOT}/sources/ign-fetcher.js`, `${ROOT}/workers/slope-math.js`,
];
const sandbox = {
  console, fetch, AbortController, AbortSignal, performance, URL, URLSearchParams, Request, Response, Headers,
  setTimeout, clearTimeout, TextEncoder, TextDecoder, Math, Date, JSON, Number, Map, Set, Promise,
  Float32Array, Uint8Array, Uint16Array, Int32Array, Uint32Array, DataView, ArrayBuffer, Blob,
  CompressionStream: globalThis.CompressionStream, Error, isNaN, parseInt, parseFloat,
  caches: { open: async () => ({ match: async () => null, put: async () => {}, keys: async () => [], delete: async () => {} }) },
  self: { location: { href: 'https://x.test/sw-dem.js' }, addEventListener() {}, clients: { claim: async () => {} } },
  swLog: { isDebug: () => false, debug() {}, info() {}, warn() {}, error() {} },
  navigator: { hardwareConcurrency: 8 },
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
for (const f of files) vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });

const S = 256;
const WMS = 'https://data.geopf.fr/wms-r/wms';
const LIDAR = 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tileOf = (lng, lat, z) => vm.runInContext(`(() => { const n = 1 << ${z}; const x = Math.floor(((${lng} + 180) / 360) * n); const lr = ${lat} * Math.PI / 180; const y = Math.floor(((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n); return { z: ${z}, x, y }; })()`, ctx);
const tileBounds = (t) => vm.runInContext(`mercatorTileBounds(${t.z}, ${t.x}, ${t.y})`, ctx);

async function fetchRawDegreeSquare(t) {
  const b = tileBounds(t);
  const u = `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent(LIDAR)}&STYLES=&FORMAT=${encodeURIComponent('image/x-bil;bits=32')}&CRS=EPSG:4326&BBOX=${[b.south, b.west, b.north, b.east].join(',')}&WIDTH=${S}&HEIGHT=${S}`;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(u, { headers: { 'User-Agent': 'redview-probe' } });
    if (r.status === 429) { await sleep(1200 * (i + 1)); continue; }
    if (!r.ok) return null;
    return new Float32Array(await r.arrayBuffer());
  }
  return null;
}
async function fetchPatched(t) {
  ctx.__z = t.z; ctx.__x = t.x; ctx.__y = t.y;
  for (let i = 0; i < 6; i++) {
    const out = await vm.runInContext('getMnsWmsTile(__z, __x, __y, null)', ctx);
    if (out) return out;
    await sleep(2000);
  }
  return null;
}

// ── PNG plumbing ──────────────────────────────────────────────────────
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

// ── App colour ramp (mirrors COLOR_RAMP + degStop in slope-config.ts) ──
const RAMP = ['#3FAE2A', '#77C043', '#B7CF3A', '#F1D43B', '#F6AD2F', '#F47C20', '#E84A27', '#C81E1E', '#6F1010', '#000000'];
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const rampColor = (t) => {
  const n = RAMP.length - 1, i = Math.min(Math.floor(t * n), n - 1), f = t * n - i;
  const a = hex(RAMP[i]), b = hex(RAMP[i + 1]);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
};
const BREAKS = [0, 10, 20, 30, 40, 50, 90];
const STOPS = BREAKS.map((d, i) => ({ v: d === 0 ? 0 : Math.sqrt(d * 90), c: rampColor(i / (BREAKS.length - 1)) }));
function paletteOfR(r) {
  const V = (r / 255) * 90;
  let i = 0;
  while (i < STOPS.length - 2 && V > STOPS[i + 1].v) i++;
  const a = STOPS[i], b = STOPS[Math.min(i + 1, STOPS.length - 1)];
  const t = b.v === a.v ? 0 : Math.max(0, Math.min(1, (V - a.v) / (b.v - a.v)));
  return [a.c[0] + (b.c[0] - a.c[0]) * t, a.c[1] + (b.c[1] - a.c[1]) * t, a.c[2] + (b.c[2] - a.c[2]) * t];
}

function slopePng(elev, t) {
  const b = tileBounds(t);
  const midLat = (b.north + b.south) / 2, lr = midLat * Math.PI / 180;
  const cX = ((b.east - b.west) * Math.PI * 6378137 * Math.cos(lr) / 180) / S;
  const cY = ((b.north - b.south) * Math.PI * 6378137 / 180) / S;
  ctx.__elev = elev; ctx.__t = t; ctx.__cX = cX; ctx.__cY = cY;
  const rgba = vm.runInContext('(() => { const padded = buildPaddedElevationsFromArrays(__elev, {}); const P = DEM_TILE_SIZE + 2; const out = computeAndEncodeSlopeFused(padded.pad, __elev, __cX, __cY, padded.edgeNeighbours); return out; })()', ctx);
  return rgba;
}
const MAG = 2;
function panel(rgba) {
  const out = new Uint8Array(S * MAG * S * MAG * 4);
  for (let y = 0; y < S * MAG; y++) for (let x = 0; x < S * MAG; x++) {
    const si = ((y / MAG | 0) * S + (x / MAG | 0)) * 4, di = (y * S * MAG + x) * 4;
    const c = paletteOfR(rgba[si]);
    out[di] = c[0]; out[di + 1] = c[1]; out[di + 2] = c[2]; out[di + 3] = 255;
  }
  return out;
}
// Row-mean slope band: one column per DEM row, so a row comb shows as stripes.
function rowBand(rgba, width) {
  const out = new Uint8Array(width * 128 * 4);
  const colW = Math.floor(width / S);
  for (let y = 0; y < S; y++) {
    let s = 0, c = 0;
    for (let x = 0; x < S; x++) { const i = (y * S + x) * 4; if (rgba[i + 3]) { s += rgba[i]; c++; } }
    const meanR = c ? s / c : 0;
    const col = paletteOfR(meanR);
    for (let k = 0; k < colW; k++) {
      const px = y * colW + k;
      for (let yy = 0; yy < 128; yy++) {
        const di = (yy * width + px) * 4;
        out[di] = col[0]; out[di + 1] = col[1]; out[di + 2] = col[2]; out[di + 3] = 255;
      }
    }
  }
  return out;
}

const OUT = '.workbuddy-ai/tmp';
const sites = [['alpes', 6.05, 45.05], ['valensole', 5.98, 43.83]];
for (const [name, lng, lat] of sites) {
  const t = tileOf(lng, lat, 14);
  console.log(`\n### ${name} z14 ${t.x}/${t.y}`);
  const before = await fetchRawDegreeSquare(t);
  await sleep(1400);
  const after = await fetchPatched(t);
  if (!before || !after) { console.log('  fetch issue', !!before, !!after); continue; }
  const sB = slopePng(before, t), sA = slopePng(after, t);
  const W = S * MAG * 2 + 4;
  const H = S * MAG + 8 + 128;
  const img = new Uint8Array(W * H * 4);
  const put = (buf, ox, oy, bw, bh) => {
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const si = (y * bw + x) * 4, di = ((oy + y) * W + ox + x) * 4;
      img[di] = buf[si]; img[di + 1] = buf[si + 1]; img[di + 2] = buf[si + 2]; img[di + 3] = 255;
    }
  };
  put(panel(sB), 0, 0, S * MAG, S * MAG);
  put(panel(sA), S * MAG + 4, 0, S * MAG, S * MAG);
  for (let y = 0; y < H; y++) for (let x = S * MAG; x < S * MAG + 4; x++) { const i = (y * W + x) * 4; img[i] = img[i + 1] = img[i + 2] = 60; img[i + 3] = 255; }
  put(rowBand(sB, S * MAG), 0, S * MAG + 8, S * MAG, 128);
  put(rowBand(sA, S * MAG), S * MAG + 4, S * MAG + 8, S * MAG, 128);
  writeFileSync(`${OUT}/compare-${name}.png`, encodePng(W, H, img));
  console.log(`  wrote compare-${name}.png  (${W}x${H})  left = BEFORE / right = AFTER`);

  // slope-domain comb metric
  const combOf = (f, w, h) => { const d = []; for (let y = 0; y + 1 < h; y++) { let s = 0, c = 0; for (let x = 0; x < w; x++) { const i = ((y + 1) * w + x) * 4; if (f[i + 3] && f[(y * w + x) * 4 + 3]) { s += Math.abs(f[i] - f[(y * w + x) * 4]); c++; } } d.push(c ? s / c : 0); } let ev = 0, ne = 0, od = 0, no = 0; d.forEach((v, i) => { if (i % 2 === 0) { ev += v; ne++; } else { od += v; no++; } }); const a = ev / ne, b = od / no; return Math.abs(a - b) / ((a + b) / 2 || 1); };
  console.log(`  slope-domain row comb: BEFORE=${combOf(sB, S, S).toFixed(4)}  AFTER=${combOf(sA, S, S).toFixed(4)}`);
}
console.log('\ndone');
