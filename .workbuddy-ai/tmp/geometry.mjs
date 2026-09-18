// Find the WMS request geometry that yields a row-clean raster.
const WMS = 'https://data.geopf.fr/wms-r/wms';
const FMT = 'image/x-bil;bits=32';
const LIDAR = 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';
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
function eqY(f, w, h) { let e = 0, t = 0; for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) { t++; if (f[y * w + x] === f[(y - 1) * w + x]) e++; } return 100 * e / t; }
function eqX(f, w, h) { let e = 0, t = 0; for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) { t++; if (f[y * w + x] === f[y * w + x - 1]) e++; } return 100 * e / t; }
function distinct(f, w, h, axis) {
  const s = new Set();
  const n = axis === 'row' ? h : w;
  for (let i = 0; i < n; i++) {
    let hash = 0;
    const len = axis === 'row' ? w : h;
    for (let j = 0; j < len; j++) {
      const v = axis === 'row' ? f[i * w + j] : f[j * w + i];
      hash = (hash * 31 + Math.round(v * 100)) | 0;
    }
    s.add(hash);
  }
  return s.size;
}

const SITE = { lng: 6.05, lat: 45.05 };
const cos = Math.cos(SITE.lat * Math.PI / 180);
const t = tile(SITE.lng, SITE.lat, 14);
const b = bounds(t.z, t.x, t.y);
console.log(`z14 tile ${t.x}/${t.y} lat ${b.south.toFixed(5)}..${b.north.toFixed(5)} cos=${cos.toFixed(4)} 1/cos=${(1 / cos).toFixed(4)}`);
const combos = [
  [256, 256], [512, 512], [256, 181], [256, 362], [362, 256], [512, 256], [256, 512], [384, 384], [256, 128], [256, 91],
];
for (const [w, h] of combos) {
  const u = `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent(LIDAR)}&STYLES=&FORMAT=${encodeURIComponent(FMT)}&CRS=EPSG:4326&BBOX=${[b.south, b.west, b.north, b.east].join(',')}&WIDTH=${w}&HEIGHT=${h}`;
  const r = await get(u);
  if (!r || r.err) { console.log(`  W=${w} H=${h}: ${r && r.err}`); await sleep(1300); continue; }
  const expected = w * h * 4;
  if (r.bytes !== expected) { console.log(`  W=${w} H=${h}: bytes=${r.bytes} expected=${expected}`); await sleep(1300); continue; }
  const dr = distinct(r.f, w, h, 'row'), dc = distinct(r.f, w, h, 'col');
  console.log(`  W=${w} H=${h}: bytes ok | distinctRows=${dr}/${h} distinctCols=${dc}/${w} | eqY=${eqY(r.f, w, h).toFixed(1)}% eqX=${eqX(r.f, w, h).toFixed(1)}%`);
  await sleep(1300);
}
