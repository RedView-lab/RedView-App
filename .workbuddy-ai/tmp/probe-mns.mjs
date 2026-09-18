// Probe the IGN LiDAR-HD MNS WMS path used by the SW DEM pipeline.
// Reproduces buildMnsWmsTileURL() byte-for-byte and analyses the raster.

const IGN_WMS_BASE = 'https://data.geopf.fr/wms-r/wms';
const IGN_DEM_FORMAT = 'image/x-bil;bits=32';
const DEM_TILE_SIZE = 256;
const IGN_LIDAR_MNS_LAYER = 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';
const IGN_MNS_CORREL_LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS';
const MIN_VALID_ELEVATION_M = -500;
const MAX_VALID_ELEVATION_M = 9000;

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
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { z, x, y };
}

function buildMnsWmsTileURL(mercZ, mercX, mercY, layer = IGN_LIDAR_MNS_LAYER) {
  const bounds = mercatorTileBounds(mercZ, mercX, mercY);
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east].join(',');
  return (
    `${IGN_WMS_BASE}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0` +
    `&LAYERS=${encodeURIComponent(layer)}&STYLES=` +
    `&FORMAT=${encodeURIComponent(IGN_DEM_FORMAT)}` +
    `&CRS=EPSG:4326&BBOX=${bbox}` +
    `&WIDTH=${DEM_TILE_SIZE}&HEIGHT=${DEM_TILE_SIZE}`
  );
}

const targets = [
  { name: 'alpes-z15', ...lonLatToTile(6.05, 45.05, 15) },
  { name: 'alpes-z14', ...lonLatToTile(6.05, 45.05, 14) },
  { name: 'vercors-z14', ...lonLatToTile(5.45, 44.95, 14) },
];

for (const t of targets) {
  const b = mercatorTileBounds(t.z, t.x, t.y);
  const url = buildMnsWmsTileURL(t.z, t.x, t.y);
  console.log('\n=== ' + t.name + ` ${t.z}/${t.x}/${t.y} ===`);
  console.log('bounds', b);
  console.log('ground span X (m):', ((b.east - b.west) * 111320 * Math.cos((b.north + b.south) / 2 * Math.PI / 180)).toFixed(1));
  console.log('ground span Y (m):', ((b.north - b.south) * 110574).toFixed(1));
  console.log('=> m/px :', (((b.north - b.south) * 110574) / 256).toFixed(2));
  console.log('URL:', url);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'redview-probe' } });
    console.log('HTTP', res.status, res.headers.get('content-type'), res.headers.get('content-length'));
    if (!res.ok) {
      console.log('body:', (await res.text()).slice(0, 400));
      continue;
    }
    const buf = await res.arrayBuffer();
    console.log('byteLength', buf.byteLength, 'expected', DEM_TILE_SIZE * DEM_TILE_SIZE * 4);
    if (buf.byteLength !== DEM_TILE_SIZE * DEM_TILE_SIZE * 4) {
      console.log('!! SIZE MISMATCH — decodeBIL32 would throw');
      continue;
    }
    const f = new Float32Array(buf);
    let min = Infinity, max = -Infinity, sum = 0, valid = 0;
    for (const v of f) {
      if (Number.isNaN(v) || v < MIN_VALID_ELEVATION_M || v > MAX_VALID_ELEVATION_M) continue;
      valid++; sum += v;
      if (v < min) min = v; if (v > max) max = v;
    }
    console.log(`valid=${valid}/${f.length} min=${min.toFixed(1)} max=${max.toFixed(1)} mean=${(sum / valid).toFixed(1)}`);
    // row-to-row comb detection: mean |d/dy| between consecutive rows vs |d/dx| inside rows
    let dySum = 0, dxSum = 0, n = 0;
    for (let y = 1; y < 256; y++) {
      for (let x = 1; x < 256; x++) {
        const i = y * 256 + x;
        const v = f[i];
        if (!(v > MIN_VALID_ELEVATION_M && v < MAX_VALID_ELEVATION_M)) continue;
        const vN = f[i - 256], vW = f[i - 1];
        if (!(vN > MIN_VALID_ELEVATION_M && vN < MAX_VALID_ELEVATION_M)) continue;
        if (!(vW > MIN_VALID_ELEVATION_M && vW < MAX_VALID_ELEVATION_M)) continue;
        dySum += Math.abs(v - vN); dxSum += Math.abs(v - vW); n++;
      }
    }
    console.log(`mean|d/dy|=${(dySum / n).toFixed(3)} m  mean|d/dx|=${(dxSum / n).toFixed(3)} m  ratio=${(dySum / dxSum).toFixed(3)}  (n=${n})`);
    // Alternating-row (comb) signature: |d/dy| between even->odd rows vs odd->even
    let evenOdd = 0, oddEven = 0, ne = 0, no = 0;
    for (let y = 1; y < 256; y++) {
      let s = 0, c = 0;
      for (let x = 0; x < 256; x++) {
        const v = f[y * 256 + x], vN = f[(y - 1) * 256 + x];
        if (!(v > MIN_VALID_ELEVATION_M && v < MAX_VALID_ELEVATION_M)) continue;
        if (!(vN > MIN_VALID_ELEVATION_M && vN < MAX_VALID_ELEVATION_M)) continue;
        s += Math.abs(v - vN); c++;
      }
      if (!c) continue;
      if (y % 2 === 0) { evenOdd += s / c; ne++; } else { oddEven += s / c; no++; }
    }
    console.log(`row-diff mean  even->odd=${(evenOdd / ne).toFixed(3)}  odd->even=${(oddEven / no).toFixed(3)}`);
  } catch (e) {
    console.log('FETCH ERROR', e.message);
  }
}
