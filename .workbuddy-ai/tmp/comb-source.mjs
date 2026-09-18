// Where exactly does the comb live? Row-by-row signed statistics of the raw WMS raster.
const WMS = 'https://data.geopf.fr/wms-r/wms';
const FMT = 'image/x-bil;bits=32';
const S = 256;
const LAYERS = {
  lidarHD: 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G',
  correl: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS',
  rge: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES',
};
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
    if (!r.ok) return null;
    return new Float32Array(await r.arrayBuffer());
  }
  return null;
}
function mkUrl(t, layer, w, h) {
  const b = bounds(t.z, t.x, t.y);
  return `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent(layer)}&STYLES=&FORMAT=${encodeURIComponent(FMT)}&CRS=EPSG:4326&BBOX=${[b.south, b.west, b.north, b.east].join(',')}&WIDTH=${w}&HEIGHT=${h}`;
}

const t = tile(6.05, 45.05, 14);
for (const [lname, layer] of Object.entries(LAYERS)) {
  const f = await get(mkUrl(t, layer, S, S));
  await sleep(1300);
  if (!f) { console.log(`${lname}: fail`); continue; }
  console.log(`\n===== ${lname} (256x256) =====`);
  // signed row delta, split by parity of the transition index
  let ev = 0, ne = 0, od = 0, no = 0;
  const deltas = [];
  for (let y = 0; y + 1 < S; y++) {
    let s = 0, c = 0;
    for (let x = 0; x < S; x++) { const d = f[(y + 1) * S + x] - f[y * S + x]; if (Number.isFinite(d)) { s += d; c++; } }
    const m = c ? s / c : 0;
    deltas.push(m);
    if (y % 2 === 0) { ev += Math.abs(m); ne++; } else { od += Math.abs(m); no++; }
  }
  console.log(`  |mean dY| even-transitions=${(ev / ne).toFixed(3)}  odd=${(od / no).toFixed(3)}  comb=${(Math.abs(ev / ne - od / no) / ((ev / ne + od / no) / 2)).toFixed(3)}`);
  // lag-2 autocorrelation of the row-delta series -> detects period-2 comb
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const den = deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / deltas.length;
  for (const lag of [1, 2, 3, 4]) {
    let num = 0;
    for (let i = 0; i + lag < deltas.length; i++) num += (deltas[i] - mean) * (deltas[i + lag] - mean);
    console.log(`  autocorr(dY) lag${lag} = ${(num / deltas.length / den).toFixed(3)}`);
  }
  // print the first 32 signed row deltas: a comb shows as +g,-g,+g,-g
  console.log('  first 32 signed row deltas:');
  console.log('   ', deltas.slice(0, 32).map((v) => v.toFixed(2).padStart(6)).join(''));
  // row means
  const rm = [];
  for (let y = 0; y < S; y++) { let s = 0; for (let x = 0; x < S; x++) s += f[y * S + x]; rm.push(s / S); }
  console.log('  first 16 row means:', rm.slice(0, 16).map((v) => v.toFixed(2)).join(' '));
}
