// Comb (row-duplication) detector + visual proof on smooth terrain.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WMS = 'https://data.geopf.fr/wms-r/wms';
const FMT = 'image/x-bil;bits=32';
const S = 256;
const LIDAR = 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';
const RGE = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES';
const MINV = -500, MAXV = 9000;

function bounds(z, x, y) {
  const n = Math.PI - (2 * Math.PI * y) / (1 << z), s = Math.PI - (2 * Math.PI * (y + 1)) / (1 << z);
  return { west: (x / (1 << z)) * 360 - 180, east: ((x + 1) / (1 << z)) * 360 - 180, north: Math.atan(Math.sinh(n)) * 180 / Math.PI, south: Math.atan(Math.sinh(s)) * 180 / Math.PI };
}
function tile(lng, lat, z) {
  const n = 1 << z, x = Math.floor(((lng + 180) / 360) * n), lr = lat * Math.PI / 180;
  return { z, x, y: Math.floor(((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n) };
}
function url(t, layer, w, h) {
  const b = bounds(t.z, t.x, t.y);
  return `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent(layer)}&STYLES=&FORMAT=${encodeURIComponent(FMT)}&CRS=EPSG:4326&BBOX=${[b.south, b.west, b.north, b.east].join(',')}&WIDTH=${w}&HEIGHT=${h}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(u, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(u, { headers: { 'User-Agent': 'redview-probe' } });
    if (r.status === 429) { await sleep(1200 * (i + 1)); continue; }
    if (!r.ok) return null;
    return new Float32Array(await r.arrayBuffer());
  }
  return null;
}
function boxAvg(hi, ss) {
  const n = S * ss, out = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let s = 0, c = 0;
    for (let yy = 0; yy < ss; yy++) for (let xx = 0; xx < ss; xx++) {
      const v = hi[(y * ss + yy) * n + x * ss + xx];
      if (!Number.isNaN(v) && v >= MINV && v <= MAXV) { s += v; c++; }
    }
    out[y * S + x] = c > 0 ? s / c : NaN;
  }
  return out;
}
// comb amplitude on row-to-row |delta| series (0 = no comb, 1 = full alternation)
function comb(f, n) {
  const rows = [];
  for (let y = 0; y + 1 < n; y++) {
    let s = 0, c = 0;
    for (let x = 0; x < n; x++) { const d = Math.abs(f[(y + 1) * n + x] - f[y * n + x]); if (Number.isFinite(d)) { s += d; c++; } }
    rows.push(c ? s / c : 0);
  }
  let ev = 0, ne = 0, od = 0, no = 0;
  rows.forEach((v, i) => { if (i % 2 === 0) { ev += v; ne++; } else { od += v; no++; } });
  const a = ev / ne, b = od / no;
  return { even: a, odd: b, comb: Math.abs(a - b) / ((a + b) / 2) };
}
// duplicate-row ratio
function eqY(f, n) { let e = 0, t = 0; for (let y = 1; y < n; y++) for (let x = 0; x < n; x++) { t++; if (f[y * n + x] === f[(y - 1) * n + x]) e++; } return 100 * e / t; }

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b, s, l) { let c = 0xffffffff; for (let i = s; i < s + l; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(t, d) { const b = new Uint8Array(12 + d.length), v = new DataView(b.buffer); v.setUint32(0, d.length); for (let i = 0; i < 4; i++) b[4 + i] = t.charCodeAt(i); b.set(d, 8); v.setUint32(8 + d.length, crc32(b, 4, 4 + d.length)); return b; }
function png(w, h, rgba) {
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1);
  const ih = new Uint8Array(13), v = new DataView(ih.buffer); v.setUint32(0, w); v.setUint32(4, h); ih[8] = 8; ih[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw)))), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return Buffer.from(out);
}
function slopeRgba(own, t) {
  const b = bounds(t.z, t.x, t.y), lr = ((b.north + b.south) / 2) * Math.PI / 180;
  const cX = ((b.east - b.west) * Math.PI * 6378137 * Math.cos(lr) / 180) / S;
  const cY = ((b.north - b.south) * Math.PI * 6378137 / 180) / S;
  const P = S + 2, p = new Float32Array(P * P);
  for (let r = 0; r < S; r++) p.set(own.subarray(r * S, (r + 1) * S), (r + 1) * P + 1);
  for (let c = 0; c < S; c++) { p[c + 1] = own[c]; p[(S + 1) * P + c + 1] = own[(S - 1) * S + c]; }
  for (let r = 0; r < S; r++) { p[(r + 1) * P] = own[r * S]; p[(r + 1) * P + S + 1] = own[r * S + S - 1]; }
  p[0] = own[0]; p[S + 1] = own[S - 1]; p[(S + 1) * P] = own[(S - 1) * S]; p[(S + 1) * P + S + 1] = own[(S - 1) * S + S - 1];
  const i8x = 1 / (8 * cX), i8y = 1 / (8 * cY), K = 255 / Math.sqrt(Math.PI / 2);
  const rgba = new Uint8Array(S * S * 4);
  for (let row = 0; row < S; row++) {
    const r0 = row * P, r1 = (row + 1) * P, r2 = (row + 2) * P, o = row * S;
    for (let col = 0; col < S; col++) {
      const idx = (o + col) * 4;
      if (!(own[o + col] > -10000)) continue;
      const a = p[r0 + col], bb = p[r0 + col + 1], c = p[r0 + col + 2], d = p[r1 + col], f = p[r1 + col + 2], g = p[r2 + col], h = p[r2 + col + 1], i = p[r2 + col + 2];
      const gx = ((c + 2 * f + i) - (a + 2 * d + g)) * i8x, gy = ((g + 2 * h + i) - (a + 2 * bb + c)) * i8y;
      let e = Math.sqrt(Math.atan(Math.hypot(gx, gy))) * K;
      if (e < 0) e = 0; else if (e > 255) e = 255;
      rgba[idx] = e + 0.5 | 0; rgba[idx + 3] = 255;
    }
  }
  return rgba;
}
function mag2(r) { const o = new Uint8Array(S * 2 * S * 2 * 4); for (let y = 0; y < S * 2; y++) for (let x = 0; x < S * 2; x++) { const s = (((y >> 1) * S) + (x >> 1)) * 4, d = (y * S * 2 + x) * 4; o[d] = r[s]; o[d + 3] = 255; } return o; }

const sites = [
  ['valensole-smooth', tile(5.98, 43.83, 14)],
  ['beauce-farmland', tile(1.90, 48.20, 14)],
];
const OUT = '.workbuddy-ai/tmp';
for (const [name, t] of sites) {
  console.log(`\n##### ${name}  z${t.z} ${t.x}/${t.y} #####`);
  for (const [label, layer] of [['lidarHD', LIDAR], ['rgeAlti', RGE]]) {
    for (const ss of [1, 2]) {
      const n = S * ss;
      const hi = await get(url(t, layer, n, n));
      if (!hi) { console.log(`  ${label} ss=${ss}: fetch failed`); continue; }
      const out = ss === 1 ? hi : boxAvg(hi, ss);
      const c1 = comb(hi, n), c2 = comb(out, S);
      console.log(`  ${label} ss=${ss} | raw ${n}px eqY=${eqY(hi, n).toFixed(2)}% comb=${c1.comb.toFixed(3)} (even ${c1.even.toFixed(3)} / odd ${c1.odd.toFixed(3)}) | out256 eqY=${eqY(out, S).toFixed(2)}% comb=${c2.comb.toFixed(3)}`);
      writeFileSync(`${OUT}/comb-${name}-${label}-ss${ss}.png`, png(S * 2, S * 2, mag2(slopeRgba(out, t))));
      await sleep(1300);
    }
  }
}
console.log('done');
