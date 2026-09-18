// ---------------------------------------------------------------------------
// Diagnose IGN WMS row-duplication ("comb") in the DEM rasters that feed the
// slope / altitude overlays.
//
// Background: the IGN products are stored on a METRE-square grid, which in
// EPSG:4326 is 1/cos(lat) wider than tall. A degree-square GetMap request
// (WIDTH === HEIGHT) makes the server nearest-neighbour stretch the rows and
// duplicate ~(1 - cos(lat)) of them — 29.4 % at 45°N, 33.3 % at 48°N. Horn's
// ∂z/∂y then alternates between 0 and ~2× the true value on successive rows,
// which paints the terrain as horizontal dashes instead of a smooth slope
// field. `mnsWmsRequestSize()` in public/sw-dem/sources/ign-fetcher.js avoids
// this by asking for 1/cos(lat) more columns than rows.
//
// Usage:
//   node scripts/diagnose-wms-row-comb.mjs                 # default sample sites
//   node scripts/diagnose-wms-row-comb.mjs 6.05 45.05 14   # lng lat zoom
//
// Reported per layer:
//   eqY           % of rows bit-identical to the row above (0 is healthy)
//   distinctRows  distinct rows returned / rows requested
//   comb          even/odd alternation of |mean row-to-row delta|
//                 (0 = clean, > 0.3 = visible dashes in the slope overlay)
// ---------------------------------------------------------------------------

const WMS = 'https://data.geopf.fr/wms-r/wms';
const FORMAT = 'image/x-bil;bits=32';
const TILE = 256;

const LAYERS = {
  'lidarHD (primary)': 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G',
  'MNS correl (fallback)': 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS',
  'RGE ALTI (bare earth)': 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES',
};

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

function lngLatToTile(lng, lat, z) {
  const n = 1 << z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { z, x, y };
}

function buildUrl(t, layer, width, height) {
  const b = mercatorTileBounds(t.z, t.x, t.y);
  return (
    `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0` +
    `&LAYERS=${encodeURIComponent(layer)}&STYLES=` +
    `&FORMAT=${encodeURIComponent(FORMAT)}` +
    `&CRS=EPSG:4326&BBOX=${[b.south, b.west, b.north, b.east].join(',')}` +
    `&WIDTH=${width}&HEIGHT=${height}`
  );
}

// Mirror of mnsWmsRequestSize(): metre-square request geometry.
function fixedSize(t, supersample = 1) {
  const b = mercatorTileBounds(t.z, t.x, t.y);
  const midLat = (b.north + b.south) / 2;
  const cosLat = Math.max(0.35, Math.min(1, Math.cos((midLat * Math.PI) / 180)));
  const height = TILE * supersample;
  return { width: Math.max(height, Math.round(height / cosLat)), height };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRaster(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'redview-diagnostic' } });
    if (res.status === 429) { await sleep(1200 * (i + 1)); continue; }
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const buf = await res.arrayBuffer();
    return { data: new Float32Array(buf), bytes: buf.byteLength };
  }
  return { error: 'rate limited' };
}

function duplicateRowRatio(f, w, h) {
  let dup = 0;
  let total = 0;
  for (let y = 1; y < h; y++) {
    for (let x = 0; x < w; x++) {
      total++;
      if (f[y * w + x] === f[(y - 1) * w + x]) dup++;
    }
  }
  return (100 * dup) / total;
}

function distinctRowCount(f, w, h) {
  const seen = new Set();
  for (let y = 0; y < h; y++) {
    let hash = 0;
    for (let x = 0; x < w; x++) hash = (hash * 31 + Math.round(f[y * w + x] * 100)) | 0;
    seen.add(hash);
  }
  return seen.size;
}

function rowComb(f, w, h) {
  const deltas = [];
  for (let y = 0; y + 1 < h; y++) {
    let sum = 0;
    let n = 0;
    for (let x = 0; x < w; x++) {
      const d = Math.abs(f[(y + 1) * w + x] - f[y * w + x]);
      if (Number.isFinite(d)) { sum += d; n++; }
    }
    deltas.push(n ? sum / n : 0);
  }
  let even = 0, nEven = 0, odd = 0, nOdd = 0;
  deltas.forEach((v, i) => {
    if (i % 2 === 0) { even += v; nEven++; } else { odd += v; nOdd++; }
  });
  const a = even / (nEven || 1);
  const b = odd / (nOdd || 1);
  const mean = (a + b) / 2;
  return mean > 0 ? Math.abs(a - b) / mean : 0;
}

function report(label, f, w, h) {
  const eqY = duplicateRowRatio(f, w, h);
  const distinct = distinctRowCount(f, w, h);
  const comb = rowComb(f, w, h);
  const verdict = eqY < 1 && comb < 0.15 ? 'OK' : 'ARTEFACT';
  console.log(
    `    ${label.padEnd(10)} ${String(w).padStart(4)}x${String(h).padEnd(4)}` +
    `  eqY=${eqY.toFixed(2).padStart(6)}%` +
    `  distinctRows=${String(distinct).padStart(3)}/${h}` +
    `  comb=${comb.toFixed(3)}` +
    `  -> ${verdict}`,
  );
}

async function main() {
  const [lngArg, latArg, zArg] = process.argv.slice(2);
  const sites = lngArg && latArg
    ? [['custom', Number(lngArg), Number(latArg), Number(zArg) || 14]]
    : [
        ['Pyrénées', 0.15, 42.8, 14],
        ['Alpes', 6.05, 45.05, 14],
        ['Vosges', 7.05, 48.3, 14],
        ['Nord', 2.5, 50.6, 14],
      ];

  for (const [name, lng, lat, z] of sites) {
    const t = lngLatToTile(lng, lat, z);
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const { width: fw, height: fh } = fixedSize(t, 1);
    console.log(
      `\n${name} — z${z} tile ${t.x}/${t.y}  lat ${lat}N` +
      `  (predicted duplication at degree-square: ${(100 * (1 - cosLat)).toFixed(1)} %)`,
    );
    for (const [label, layer] of Object.entries(LAYERS)) {
      // Current (degree-square) request
      const cur = await fetchRaster(buildUrl(t, layer, TILE, TILE));
      if (cur.error) { console.log(`    ${label}: ${cur.error}`); await sleep(1200); continue; }
      if (cur.bytes === TILE * TILE * 4) report('current', cur.data, TILE, TILE);
      else console.log(`    ${label}: unexpected payload ${cur.bytes} bytes`);
      await sleep(1200);
      // Fixed (metre-square) request
      const fix = await fetchRaster(buildUrl(t, layer, fw, fh));
      if (fix.error) { console.log(`    ${label}: fixed request -> ${fix.error}`); await sleep(1200); continue; }
      if (fix.bytes === fw * fh * 4) report('metre-sq', fix.data, fw, fh);
      else console.log(`    ${label}: unexpected payload ${fix.bytes} bytes`);
      await sleep(1200);
    }
  }
  console.log(
    '\nLegend: eqY = rows bit-identical to the row above (0 = healthy).' +
    '\n        comb = even/odd alternation of the row gradient (>0.3 = dashes in the slope overlay).' +
    '\n\nExpected: lidarHD must be OK on the metre-square request. The MNS correl and' +
    '\nRGE ALTI rows stay ARTEFACT at every request geometry (fixed 2x Y upsampling' +
    '\nserver-side) — which is why they are deliberately not used as a WMS fallback;' +
    '\nbuildIGNTile falls through to the WMTS path instead.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
