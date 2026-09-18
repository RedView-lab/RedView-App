// Fallback layers (correl / RGE ALTI) carry a fixed 2x Y-upsampling whatever
// the request geometry. Candidate fix: request H = 2*TILE rows and box-average
// 2x2 back down, which is the exact inverse of a 2x nearest-neighbour upsample.
const WMS = 'https://data.geopf.fr/wms-r/wms';
const LAYERS = {
  correl: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS',
  rge: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES',
};
const S = 256;
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
async function get(t, layer, w, h) {
  const b = bounds(t.z, t.x, t.y);
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
// NaN-aware box average of a w x h raster down to S x S
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
      out[y * S + x] = n > 0 ? s / n : NaN;
    }
  }
  return out;
}
const t = tile(6.05, 45.05, 14);
for (const [lname, layer] of Object.entries(LAYERS)) {
  console.log(`\n### ${lname}`);
  for (const [label, w, h] of [['current 362x256', 362, 256], ['fix 256x512', 256, 512], ['fix 362x512', 362, 512], ['fix 512x512', 512, 512]]) {
    const raw = await get(t, layer, w, h);
    await sleep(1400);
    if (!raw) { console.log(`  ${label}: fetch failed`); continue; }
    const out = boxAvg(raw, w, h);
    console.log(`  ${label.padEnd(15)} raw: eqY=${eqY(raw, w, h).toFixed(2).padStart(6)}% distinctRows=${distinct(raw, w, h)}/${h} comb=${comb(raw, w, h).toFixed(3)}   => out256: eqY=${eqY(out, S, S).toFixed(2)}% distinctRows=${distinct(out, S, S)}/${S} comb=${comb(out, S, S).toFixed(3)}`);
  }
}
