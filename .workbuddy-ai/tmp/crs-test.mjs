// Try alternate request CRS: if the anisotropy comes from the degree-square
// EPSG:4326 grid, a metre-square CRS (3857 / 2154) should return a clean raster.
const WMS = 'https://data.geopf.fr/wms-r/wms';
const FMT = 'image/x-bil;bits=32';
const S = 256;
const LAYERS = {
  lidarHD: 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G',
  correl: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS',
};
const R = 6378137;
function mercBounds3857(z, x, y) {
  const n = 1 << z, span = (2 * Math.PI * R) / n;
  return { minx: -Math.PI * R + x * span, maxx: -Math.PI * R + (x + 1) * span, miny: Math.PI * R - (y + 1) * span, maxy: Math.PI * R - y * span };
}
function bounds4326(z, x, y) {
  const n = Math.PI - (2 * Math.PI * y) / (1 << z), s = Math.PI - (2 * Math.PI * (y + 1)) / (1 << z);
  return { west: (x / (1 << z)) * 360 - 180, east: ((x + 1) / (1 << z)) * 360 - 180, north: Math.atan(Math.sinh(n)) * 180 / Math.PI, south: Math.atan(Math.sinh(s)) * 180 / Math.PI };
}
function tile(lng, lat, z) {
  const n = 1 << z, x = Math.floor(((lng + 180) / 360) * n), lr = lat * Math.PI / 180;
  return { z, x, y: Math.floor(((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(u, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(u, { headers: { 'User-Agent': 'redview-probe' } });
    if (r.status === 429) { await sleep(1200 * (i + 1)); continue; }
    if (!r.ok) return { err: r.status };
    const b = await r.arrayBuffer();
    return { f: new Float32Array(b), bytes: b.byteLength, ct: r.headers.get('content-type') };
  }
  return { err: 'rate' };
}
function eqY(f, w, h) { let e = 0, t = 0; for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) { t++; if (f[y * w + x] === f[(y - 1) * w + x]) e++; } return 100 * e / t; }
function eqX(f, w, h) { let e = 0, t = 0; for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) { t++; if (f[y * w + x] === f[y * w + x - 1]) e++; } return 100 * e / t; }
function combY(f, w, h) {
  const d = [];
  for (let y = 0; y + 1 < h; y++) { let s = 0, c = 0; for (let x = 0; x < w; x++) { const v = Math.abs(f[(y + 1) * w + x] - f[y * w + x]); if (Number.isFinite(v)) { s += v; c++; } } d.push(c ? s / c : 0); }
  let ev = 0, ne = 0, od = 0, no = 0;
  d.forEach((v, i) => { if (i % 2 === 0) { ev += v; ne++; } else { od += v; no++; } });
  const a = ev / ne, b = od / no;
  return { comb2: Math.abs(a - b) / ((a + b) / 2 || 1), d };
}
function autocorr(d, lag) {
  const m = d.reduce((a, b) => a + b, 0) / d.length;
  const den = d.reduce((a, b) => a + (b - m) ** 2, 0) / d.length;
  let num = 0;
  for (let i = 0; i + lag < d.length; i++) num += (d[i] - m) * (d[i + lag] - m);
  return num / d.length / den;
}
function distinct(f, w, h) { const s = new Set(); for (let y = 0; y < h; y++) { let k = 0; for (let x = 0; x < w; x++) k = (k * 31 + Math.round(f[y * w + x] * 100)) | 0; s.add(k); } return s.size; }

const t = tile(6.05, 45.05, 14);
const b = bounds4326(t.z, t.x, t.y);
const m = mercBounds3857(t.z, t.x, t.y);
const cos = Math.cos(((b.north + b.south) / 2) * Math.PI / 180);
// EPSG:2154 bbox = approximate Lambert-93 of the tile corners
function wgs84ToL93(lng, lat) {
  // rough inverse CC42 (good to ~1 m over the tile) — enough to build a bbox
  const a = 6378137, f = 1 / 298.257222101, e2 = 2 * f - f * f;
  const n = 0.7256077650, C = 11754255.426, xs = 700000, ys = 6600000, lc = 2.33722917;
  const phi = lat * Math.PI / 180, lam = lng * Math.PI / 180;
  const e = Math.sqrt(e2);
  const phiIso = Math.log(Math.tan(Math.PI / 4 + phi / 2) * Math.pow((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi)), e / 2));
  const Rc = C * Math.exp(-n * phiIso);
  const theta = n * (lam - lc * Math.PI / 180);
  return { x: xs + Rc * Math.sin(theta), y: ys - Rc * Math.cos(theta) };
}
const c1 = wgs84ToL93(b.west, b.south), c2 = wgs84ToL93(b.east, b.north);
const l93 = [Math.min(c1.x, c2.x), Math.min(c1.y, c2.y), Math.max(c1.x, c2.x), Math.max(c1.y, c2.y)];

const cases = [
  ['EPSG:4326 (current)', `CRS=EPSG:4326&BBOX=${[b.south, b.west, b.north, b.east].join(',')}`],
  ['EPSG:3857 256x256', `CRS=EPSG:3857&BBOX=${[m.minx, m.miny, m.maxx, m.maxy].join(',')}`],
  ['EPSG:2154 256x256', `CRS=EPSG:2154&BBOX=${l93.join(',')}`],
  ['EPSG:4326 aspect 256x181', `CRS=EPSG:4326&BBOX=${[b.south, b.west, b.north, b.east].join(',')}`, 256, 181],
  ['EPSG:3857 384x384', `CRS=EPSG:3857&BBOX=${[m.minx, m.miny, m.maxx, m.maxy].join(',')}`, 384, 384],
];
for (const [lname, layer] of Object.entries(LAYERS)) {
  console.log(`\n##### ${lname} #####`);
  for (const [label, crs, w = S, h = S] of cases) {
    const u = `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent(layer)}&STYLES=&FORMAT=${encodeURIComponent(FMT)}&${crs}&WIDTH=${w}&HEIGHT=${h}`;
    const r = await get(u);
    await sleep(1300);
    if (!r || r.err) { console.log(`  ${label.padEnd(26)} -> ${r && r.err}`); continue; }
    if (r.bytes !== w * h * 4) { console.log(`  ${label.padEnd(26)} -> bytes ${r.bytes} != ${w * h * 4} (${r.ct})`); continue; }
    const c = combY(r.f, w, h);
    console.log(`  ${label.padEnd(26)} -> distinctRows=${distinct(r.f, w, h)}/${h} eqY=${eqY(r.f, w, h).toFixed(2)}% eqX=${eqX(r.f, w, h).toFixed(2)}% comb=${c.comb2.toFixed(3)} ac4=${autocorr(c.d, 4).toFixed(3)}`);
  }
}
