// A/B render: IGN LiDAR-HD MNS (new WMS path) vs legacy HIGHRES.MNS (WMTS/correlation),
// rendered through the EXACT slope.js pipeline so the artifact is visible.
import { writeFileSync } from 'node:fs';

const IGN_WMS_BASE = 'https://data.geopf.fr/wms-r/wms';
const FMT = 'image/x-bil;bits=32';
const S = 256;
const LAYERS = {
  lidarHD: 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G',
  correlMNS: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS',
  rgeAlti: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES',
};
const MINV = -500, MAXV = 9000;

function mercatorTileBounds(z, x, y) {
  const n = Math.PI - (2 * Math.PI * y) / (1 << z);
  const s = Math.PI - (2 * Math.PI * (y + 1)) / (1 << z);
  return {
    west: (x / (1 << z)) * 360 - 180,
    east: ((x + 1) / (1 << z)) * 360 - 180,
    north: (Math.atan(Math.sinh(n)) * 180) / Math.PI,
    south: (Math.atan(Math.sinh(s)) * 180) / Math.PI,
  };
}
function lonLatToTile(lng, lat, z) {
  const n = 1 << z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { z, x, y };
}
function url(z, x, y, layer) {
  const b = mercatorTileBounds(z, x, y);
  const bbox = [b.south, b.west, b.north, b.east].join(',');
  return `${IGN_WMS_BASE}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent(layer)}&STYLES=&FORMAT=${encodeURIComponent(FMT)}&CRS=EPSG:4326&BBOX=${bbox}&WIDTH=${S}&HEIGHT=${S}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTile(z, x, y, layer, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url(z, x, y, layer), { headers: { 'User-Agent': 'redview-probe' } });
    if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
    if (!r.ok) { console.log('  HTTP', r.status, (await r.text()).slice(0, 200)); return null; }
    const buf = await r.arrayBuffer();
    if (buf.byteLength !== S * S * 4) { console.log('  size', buf.byteLength); return null; }
    return new Float32Array(buf);
  }
  console.log('  rate-limited out');
  return null;
}

// ── PNG encoder (mirror of terrain-rgb.js buildRawPng) ────────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf, s, l) { let c = 0xffffffff; for (let i = s; i < s + l; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const buf = new Uint8Array(12 + data.length); const v = new DataView(buf.buffer);
  v.setUint32(0, data.length);
  buf[4] = type.charCodeAt(0); buf[5] = type.charCodeAt(1); buf[6] = type.charCodeAt(2); buf[7] = type.charCodeAt(3);
  buf.set(data, 8); v.setUint32(8 + data.length, crc32(buf, 4, 4 + data.length));
  return buf;
}
import { deflateSync } from 'node:zlib';
function png(w, h, rgba) {
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) { raw[y * (1 + w * 4)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1); }
  const idat = new Uint8Array(deflateSync(Buffer.from(raw), { level: 6 }));
  const ihdr = new Uint8Array(13); const v = new DataView(ihdr.buffer);
  v.setUint32(0, w); v.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return Buffer.from(out);
}

// ── slope.js Horn kernel + sqrt-gamma encode ──────────────────────────
function computeCellSize(z, x, y) {
  const b = mercatorTileBounds(z, x, y);
  const midLat = (b.north + b.south) / 2, latRad = midLat * Math.PI / 180;
  return {
    cellSizeX: ((b.east - b.west) * Math.PI * 6378137 * Math.cos(latRad) / 180) / S,
    cellSizeY: ((b.north - b.south) * Math.PI * 6378137 / 180) / S,
  };
}
function pad(own) {
  const P = S + 2, p = new Float32Array(P * P);
  for (let r = 0; r < S; r++) p.set(own.subarray(r * S, (r + 1) * S), (r + 1) * P + 1);
  for (let c = 0; c < S; c++) { p[c + 1] = own[c]; p[(S + 1) * P + c + 1] = own[(S - 1) * S + c]; }
  for (let r = 0; r < S; r++) { p[(r + 1) * P] = own[r * S]; p[(r + 1) * P + S + 1] = own[r * S + S - 1]; }
  p[0] = own[0]; p[S + 1] = own[S - 1]; p[(S + 1) * P] = own[(S - 1) * S]; p[(S + 1) * P + S + 1] = own[(S - 1) * S + S - 1];
  return p;
}
function slopeRgba(own, z, x, y) {
  const p = pad(own);
  const { cellSizeX, cellSizeY } = computeCellSize(z, x, y);
  const P = S + 2, inv8x = 1 / (8 * cellSizeX), inv8y = 1 / (8 * cellSizeY);
  const K = 255 / Math.sqrt(Math.PI / 2);
  const rgba = new Uint8Array(S * S * 4);
  for (let row = 0; row < S; row++) {
    const r0 = row * P, r1 = (row + 1) * P, r2 = (row + 2) * P, out = row * S;
    for (let col = 0; col < S; col++) {
      const elev = own[out + col];
      const idx = (out + col) * 4;
      if (!(elev > -10000)) continue;
      const a = p[r0 + col], b = p[r0 + col + 1], c = p[r0 + col + 2];
      const d = p[r1 + col], f = p[r1 + col + 2];
      const g = p[r2 + col], h = p[r2 + col + 1], i = p[r2 + col + 2];
      const dzDx = ((c + 2 * f + i) - (a + 2 * d + g)) * inv8x;
      const dzDy = ((g + 2 * h + i) - (a + 2 * b + c)) * inv8y;
      let enc = Math.sqrt(Math.atan(Math.sqrt(dzDx * dzDx + dzDy * dzDy))) * K;
      if (enc < 0) enc = 0; else if (enc > 255) enc = 255;
      rgba[idx] = enc + 0.5 | 0; rgba[idx + 1] = 0; rgba[idx + 2] = 0; rgba[idx + 3] = 255;
    }
  }
  return rgba;
}
function grayRgba(f, lo, hi) {
  const rgba = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const v = f[i];
    const t = Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(((v - lo) / (hi - lo)) * 255))) : 0;
    rgba[i * 4] = t; rgba[i * 4 + 1] = t; rgba[i * 4 + 2] = t; rgba[i * 4 + 3] = 255;
  }
  return rgba;
}
// 2x nearest magnification to expose pixel-scale noise
function mag2(rgba) {
  const out = new Uint8Array(S * 2 * S * 2 * 4);
  for (let y = 0; y < S * 2; y++) for (let x = 0; x < S * 2; x++) {
    const si = (((y >> 1) * S) + (x >> 1)) * 4, di = (y * S * 2 + x) * 4;
    out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = 255;
  }
  return out;
}
function stats(f) {
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  for (const v of f) { if (Number.isNaN(v) || v < MINV || v > MAXV) continue; n++; sum += v; if (v < min) min = v; if (v > max) max = v; }
  return { min, max, mean: sum / n, n };
}
// Roughness metric: mean |laplacian| in metres (pixel-scale noise detector)
function rough(f) {
  let s = 0, n = 0;
  for (let y = 1; y < S - 1; y++) for (let x = 1; x < S - 1; x++) {
    const i = y * S + x;
    const l = 4 * f[i] - f[i - 1] - f[i + 1] - f[i - S] - f[i + S];
    if (!Number.isFinite(l)) continue; s += Math.abs(l); n++;
  }
  return s / n;
}

const OUT = process.argv[2] || '.workbuddy-ai/tmp';
const target = lonLatToTile(6.05, 45.05, 14);
const variants = [
  ['lidarHD', LAYERS.lidarHD],
  ['correlMNS', LAYERS.correlMNS],
  ['rgeAlti', LAYERS.rgeAlti],
];
for (const [name, layer] of variants) {
  const f = await fetchTile(target.z, target.x, target.y, layer);
  if (!f) continue;
  const st = stats(f);
  console.log(`${name}: min=${st.min.toFixed(1)} max=${st.max.toFixed(1)} mean=${st.mean.toFixed(1)} roughness(mean|lap|)=${rough(f).toFixed(3)} m`);
  writeFileSync(`${OUT}/elev-${name}.png`, png(S, S, grayRgba(f, st.min, st.max)));
  writeFileSync(`${OUT}/slope-${name}.png`, png(S, S, slopeRgba(f, target.z, target.x, target.y)));
  writeFileSync(`${OUT}/slope-${name}-x2.png`, png(S * 2, S * 2, mag2(slopeRgba(f, target.z, target.x, target.y))));
  await sleep(1200);
}
console.log('done ->', OUT);
