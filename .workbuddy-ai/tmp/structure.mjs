// Structural analysis of the DEM rasters: runs, parity, plateau edges.
const IGN_WMS_BASE = 'https://data.geopf.fr/wms-r/wms';
const FMT = 'image/x-bil;bits=32';
const S = 256;
const LAYERS = {
  lidarHD: 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G',
  correlMNS: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS',
};
function mercatorTileBounds(z, x, y) {
  const n = Math.PI - (2 * Math.PI * y) / (1 << z);
  const s = Math.PI - (2 * Math.PI * (y + 1)) / (1 << z);
  return {
    west: (x / (1 << z)) * 360 - 180, east: ((x + 1) / (1 << z)) * 360 - 180,
    north: (Math.atan(Math.sinh(n)) * 180) / Math.PI, south: (Math.atan(Math.sinh(s)) * 180) / Math.PI,
  };
}
function lonLatToTile(lng, lat, z) {
  const n = 1 << z; const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { z, x, y };
}
function url(z, x, y, layer, w = S, h = S) {
  const b = mercatorTileBounds(z, x, y);
  return `${IGN_WMS_BASE}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent(layer)}&STYLES=&FORMAT=${encodeURIComponent(FMT)}&CRS=EPSG:4326&BBOX=${[b.south, b.west, b.north, b.east].join(',')}&WIDTH=${w}&HEIGHT=${h}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(u, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(u, { headers: { 'User-Agent': 'redview-probe' } });
    if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
    if (!r.ok) { console.log('HTTP', r.status); return null; }
    const b = await r.arrayBuffer();
    return { buf: b, len: b.byteLength };
  }
  return null;
}

const t = lonLatToTile(6.05, 45.05, 14);
for (const [name, layer] of Object.entries(LAYERS)) {
  console.log(`\n########## ${name}  z14 ${t.x}/${t.y} ##########`);
  const r = await get(url(t.z, t.x, t.y, layer));
  if (!r || r.len !== S * S * 4) { console.log('bad', r && r.len); continue; }
  const f = new Float32Array(r.buf);

  // 1) adjacent-equal (plateau) ratio
  let eqX = 0, eqY = 0, tot = 0;
  for (let y = 1; y < S; y++) for (let x = 1; x < S; x++) {
    const i = y * S + x; tot++;
    if (f[i] === f[i - 1]) eqX++;
    if (f[i] === f[i - S]) eqY++;
  }
  console.log(`plateau ratio  eqX=${(100 * eqX / tot).toFixed(1)}%  eqY=${(100 * eqY / tot).toFixed(1)}%`);

  // 2) row-parity / comb detection on the SLOPE magnitude (Y gradient)
  const dY = new Float32Array(S * S), dX = new Float32Array(S * S);
  for (let y = 1; y < S - 1; y++) for (let x = 1; x < S - 1; x++) {
    const i = y * S + x;
    dY[i] = (f[i + S] - f[i - S]) / 2;
    dX[i] = (f[i + 1] - f[i - 1]) / 2;
  }
  let sumY = 0, sumX = 0, n = 0;
  for (let y = 1; y < S - 1; y++) for (let x = 1; x < S - 1; x++) { const i = y * S + x; sumY += Math.abs(dY[i]); sumX += Math.abs(dX[i]); n++; }
  console.log(`mean|dY|=${(sumY / n).toFixed(3)} m/px  mean|dX|=${(sumX / n).toFixed(3)} m/px`);

  // 3) ASCII preview of slope in a 48x24 window (deg)
  const b = mercatorTileBounds(t.z, t.x, t.y);
  const cX = ((b.east - b.west) * Math.PI * 6378137 * Math.cos(((b.north + b.south) / 2) * Math.PI / 180) / 180) / S;
  const cY = ((b.north - b.south) * Math.PI * 6378137 / 180) / S;
  const ramp = ' .:-=+*#%@';
  console.log(`cellSize ${cX.toFixed(2)} x ${cY.toFixed(2)} m`);
  for (let yy = 0; yy < 24; yy++) {
    let line = '';
    for (let xx = 0; xx < 64; xx++) {
      const y = 64 + yy * 4, x = 64 + xx * 2;
      const i = y * S + x;
      const gx = dX[i] / cX, gy = dY[i] / cY;
      const deg = Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
      line += ramp[Math.min(9, Math.floor(deg / 9))];
    }
    console.log(line);
  }
  await sleep(1500);
}
