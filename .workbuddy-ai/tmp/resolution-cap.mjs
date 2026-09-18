// Does the IGN WMS cap its output resolution? Compare eqY/eqX + distinct-row count
// across zooms for the SAME product, all requests at 256x256.
const WMS = 'https://data.geopf.fr/wms-r/wms';
const FMT = 'image/x-bil;bits=32';
const S = 256;
const LAYERS = {
  lidarHD: 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G',
  correlMNS: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS',
  rgeAlti: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES',
};
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
    if (!r.ok) return { err: r.status };
    const b = await r.arrayBuffer();
    return { f: new Float32Array(b), bytes: b.byteLength };
  }
  return { err: 'rate' };
}
function eqY(f, n) { let e = 0, t = 0; for (let y = 1; y < n; y++) for (let x = 0; x < n; x++) { t++; if (f[y * n + x] === f[(y - 1) * n + x]) e++; } return 100 * e / t; }
function eqX(f, n) { let e = 0, t = 0; for (let y = 0; y < n; y++) for (let x = 1; x < n; x++) { t++; if (f[y * n + x] === f[y * n + x - 1]) e++; } return 100 * e / t; }
function distinctRows(f, n) { const s = new Set(); for (let y = 0; y < n; y++) { let h = 0; for (let x = 0; x < n; x++) h = (h * 31 + Math.round(f[y * n + x] * 100)) | 0; s.add(h); } return s.size; }
function mpp(z, lat) { return (40075016.686 * Math.cos(lat * Math.PI / 180)) / (256 * (1 << z)); }

const SITE = { lng: 6.05, lat: 45.05 };
console.log(`site ${SITE.lat}N ${SITE.lng}E`);
for (const [name, layer] of Object.entries(LAYERS)) {
  console.log(`\n--- ${name} ---`);
  for (const z of [14, 15, 16, 17]) {
    const t = tile(SITE.lng, SITE.lat, z);
    const r = await get(url(t, layer, S, S));
    if (!r || r.err || r.bytes !== S * S * 4) { console.log(`  z${z}: ${r && r.err} bytes=${r && r.bytes}`); await sleep(1300); continue; }
    const f = r.f;
    let mn = Infinity, mx = -Infinity;
    for (const v of f) { if (v > -500 && v < 9000) { if (v < mn) mn = v; if (v > mx) mx = v; } }
    console.log(`  z${z} (${mpp(z, SITE.lat).toFixed(2)} m/px): eqY=${eqY(f, S).toFixed(1)}% eqX=${eqX(f, S).toFixed(1)}% distinctRows=${distinctRows(f, S)}/256 elev ${mn.toFixed(0)}..${mx.toFixed(0)} m`);
    await sleep(1300);
  }
}
