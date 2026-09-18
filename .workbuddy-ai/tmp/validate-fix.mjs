// Validate the proposed fix end-to-end:
//   (A) aspect-corrected WMS request  WIDTH = round(HEIGHT / cos(lat))
//   (B) NaN-aware X box-downsample to 256
//   (C) decomb pass that undoes residual nearest-neighbour row duplication
// Measures the Horn-domain comb before/after and renders before/after PNGs.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WMS = 'https://data.geopf.fr/wms-r/wms';
const FMT = 'image/x-bil;bits=32';
const S = 256;
const LAYERS = {
  lidarHD: 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G',
  correl: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS',
};
const MINV = -500, MAXV = 9000;

function bounds(z, x, y) {
  const n = Math.PI - (2 * Math.PI * y) / (1 << z), s = Math.PI - (2 * Math.PI * (y + 1)) / (1 << z);
  return { west: (x / (1 << z)) * 360 - 180, east: ((x + 1) / (1 << z)) * 360 - 180, north: Math.atan(Math.sinh(n)) * 180 / Math.PI, south: Math.atan(Math.sinh(s)) * 180 / Math.PI };
}
function tile(lng, lat, z) {
  const n = 1 << z, x = Math.floor(((lng + 180) / 360) * n), lr = lat * Math.PI / 180;
  return { z, x, y: Math.floor(((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(u, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(u, { headers: { 'User-Agent': 'redview-probe' } });
    if (r.status === 429) { await sleep(1200 * (i + 1)); continue; }
    if (!r.ok) return { err: r.status };
    const b = await r.arrayBuffer();
    return { f: new Float32Array(b), bytes: b.byteLength };
  }
  return { err: 'rate' };
}
function mkUrl(t, layer, w, h) {
  const b = bounds(t.z, t.x, t.y);
  return `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent(layer)}&STYLES=&FORMAT=${encodeURIComponent(FMT)}&CRS=EPSG:4326&BBOX=${[b.south, b.west, b.north, b.east].join(',')}&WIDTH=${w}&HEIGHT=${h}`;
}

// ── PROPOSED FIX (mirrors what will go into ign-fetcher.js) ────────────
function mnsWmsRequestSize(t, supersample = 1) {
  const b = bounds(t.z, t.x, t.y);
  const midLat = (b.north + b.south) / 2;
  const cosLat = Math.max(0.35, Math.min(1, Math.cos((midLat * Math.PI) / 180)));
  const height = S * supersample;
  const width = Math.max(height, Math.round(height / cosLat));
  return { width, height };
}
function rowsIdentical(f, w, y1, y2) {
  const a = y1 * w, b = y2 * w;
  for (let x = 0; x < w; x++) if (f[a + x] !== f[b + x]) return false;
  return true;
}
function decombRows(f, w, h) {
  let repaired = 0;
  for (let pass = 0; pass < 2; pass++) {
    let run = 0;
    for (let y = 1; y <= h; y++) {
      const dup = y < h && rowsIdentical(f, w, y, y - 1);
      if (dup) { run++; continue; }
      if (run > 0) {
        const top = y - run - 1, bottom = y < h ? y : -1;
        if (top >= 0 && bottom >= 0) {
          for (let k = 1; k <= run; k++) {
            const t = k / (run + 1), o = (top + k) * w, a = top * w, b = bottom * w;
            for (let x = 0; x < w; x++) f[o + x] = f[a + x] + (f[b + x] - f[a + x]) * t;
          }
          repaired += run;
        }
      }
      run = 0;
    }
  }
  return repaired;
}
function resampleToTile(raw, srcW, srcH) {
  const out = new Float32Array(S * S);
  const sx = srcW / S, sy = srcH / S;
  for (let y = 0; y < S; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(srcH, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < S; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(srcW, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * srcW;
        for (let xx = x0; xx < x1; xx++) {
          const v = raw[row + xx];
          if (!Number.isNaN(v) && v >= MINV && v <= MAXV) { sum += v; n++; }
        }
      }
      out[y * S + x] = n > 0 ? sum / n : NaN;
    }
  }
  decombRows(out, S, S);
  return out;
}

// ── metrics ───────────────────────────────────────────────────────────
function eqY(f, w, h) { let e = 0, t = 0; for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) { t++; if (f[y * w + x] === f[(y - 1) * w + x]) e++; } return 100 * e / t; }
function comb(f, w, h) {
  const rows = [];
  for (let y = 0; y + 1 < h; y++) { let s = 0, c = 0; for (let x = 0; x < w; x++) { const d = Math.abs(f[(y + 1) * w + x] - f[y * w + x]); if (Number.isFinite(d)) { s += d; c++; } } rows.push(c ? s / c : 0); }
  let ev = 0, ne = 0, od = 0, no = 0;
  rows.forEach((v, i) => { if (i % 2 === 0) { ev += v; ne++; } else { od += v; no++; } });
  const a = ev / ne, b = od / no;
  return Math.abs(a - b) / ((a + b) / 2 || 1);
}
function hornRgba(own, t) {
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
// Row-profile strip: mean slope per row, 1 px per row, so a comb shows as
// alternating bright/dark scanlines. Amplified x8 for visibility.
function strip(rgba) {
  const out = new Uint8Array(S * 8 * 4);
  for (let y = 0; y < S; y++) {
    let s = 0, c = 0;
    for (let x = 0; x < S; x++) { const v = rgba[(y * S + x) * 4]; if (rgba[(y * S + x) * 4 + 3]) { s += v; c++; } }
    const m = c ? s / c : 0;
    const lo = 100, hi = 200;
    const g = Math.max(0, Math.min(255, Math.round(((m - lo) / (hi - lo)) * 255)));
    for (let k = 0; k < 8; k++) { const i = ((y * 8 + k) * 4); out[i] = g; out[i + 1] = g; out[i + 2] = g; out[i + 3] = 255; }
  }
  return out;
}
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

const OUT = '.workbuddy-ai/tmp';
const sites = [['valensole', 5.98, 43.83], ['alpes', 6.05, 45.05]];
for (const [name, lng, lat] of sites) {
  const t = tile(lng, lat, 14);
  console.log(`\n### ${name} z14 ${t.x}/${t.y}`);
  for (const [lname, layer] of Object.entries(LAYERS)) {
    // BEFORE — current behaviour: degree-square 256x256, used as-is
    const before = await get(mkUrl(t, layer, S, S));
    await sleep(1300);
    // AFTER — aspect-corrected request + resample + decomb
    const { width: W, height: H } = mnsWmsRequestSize(t, 1);
    const after = await get(mkUrl(t, layer, W, H));
    await sleep(1300);
    if (!before || before.err || !after || after.err) { console.log(`  ${lname}: fetch issue`); continue; }
    const fixed = resampleToTile(after.f, W, H);
    const sB = hornRgba(before.f, t), sA = hornRgba(fixed, t);
    console.log(`  ${lname}: request ${S}x${S} -> ${W}x${H}`);
    console.log(`    BEFORE eqY=${eqY(before.f, S, S).toFixed(2)}%  comb(deg-encoded slope)=${comb(sB, S, S).toFixed(4)}`);
    console.log(`    AFTER  eqY=${eqY(fixed, S, S).toFixed(2)}%  comb(deg-encoded slope)=${comb(sA, S, S).toFixed(4)}`);
    writeFileSync(`${OUT}/fx-${name}-${lname}-before.png`, png(S, S, sB));
    writeFileSync(`${OUT}/fx-${name}-${lname}-after.png`, png(S, S, sA));
    writeFileSync(`${OUT}/fx-${name}-${lname}-before-strip.png`, png(8, S, strip(sB)));
    writeFileSync(`${OUT}/fx-${name}-${lname}-after-strip.png`, png(8, S, strip(sA)));
  }
}
console.log('\ndone');
