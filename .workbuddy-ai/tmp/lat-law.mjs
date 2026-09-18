// Confirm the 1/cos(lat) law and validate the candidate fix at several latitudes.
const WMS = 'https://data.geopf.fr/wms-r/wms';
const FMT = 'image/x-bil;bits=32';
const LIDAR = 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';
const CORREL = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS';
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
function eqY(f, w, h) { let e = 0, t = 0; for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) { t++; if (f[y * w + x] === f[(y - 1) * w + x]) e++; } return 100 * e / t; }
function eqX(f, w, h) { let e = 0, t = 0; for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) { t++; if (f[y * w + x] === f[y * w + x - 1]) e++; } return 100 * e / t; }
function dr(f, w, h) { const s = new Set(); for (let y = 0; y < h; y++) { let k = 0; for (let x = 0; x < w; x++) k = (k * 31 + Math.round(f[y * w + x] * 100)) | 0; s.add(k); } return s.size; }

const sites = [
  ['alpes', 6.05, 45.05],
  ['pyrenees', 0.15, 42.80],
  ['vosges', 7.05, 48.30],
];
for (const [name, lng, lat] of sites) {
  const cos = Math.cos(lat * Math.PI / 180);
  const t = tile(lng, lat, 14);
  console.log(`\n### ${name} ${lat}N  cos=${cos.toFixed(4)}  1/cos=${(1 / cos).toFixed(4)}  -> predicted dup ${(100 * (1 - cos)).toFixed(1)}%`);
  const cases = [
    ['current  256x256', 256, 256],
    [`fix A    256x${Math.round(256 * cos)}`, 256, Math.round(256 * cos)],
    [`fix B    ${Math.round(256 / cos)}x256`, Math.round(256 / cos), 256],
  ];
  for (const [label, w, h] of cases) {
    for (const [lname, layer] of [['lidarHD', LIDAR], ['correl', CORREL]]) {
      const r = await get(mkUrl(t, layer, w, h));
      if (!r || r.err) { console.log(`  ${label} ${lname}: ${r && r.err}`); await sleep(1300); continue; }
      if (r.bytes !== w * h * 4) { console.log(`  ${label} ${lname}: bytes ${r.bytes} != ${w * h * 4}`); await sleep(1300); continue; }
      console.log(`  ${label} ${lname.padEnd(7)} | distinctRows=${dr(r.f, w, h)}/${h} eqY=${eqY(r.f, w, h).toFixed(2)}% eqX=${eqX(r.f, w, h).toFixed(2)}%`);
      await sleep(1200);
    }
  }
}
