// ---------------------------------------------------------------------------
// Slope computation from DEM elevations
// Uses Horn's method (3×3 neighborhood) for robust gradient estimation.
// Encodes slope angle (degrees) in Terrain-RGB format for raster-color usage.
// ---------------------------------------------------------------------------

/**
 * Compute ground-level cell sizes (meters) for a Mercator tile.
 * Returns {cellSizeX, cellSizeY} — average ground distance per pixel.
 */
function computeCellSize(z, x, y, tileSize) {
  const bounds = mercatorTileBounds(z, x, y);
  const midLat = (bounds.north + bounds.south) / 2;
  const latRad = (midLat * Math.PI) / 180;

  // Longitude span → meters at this latitude
  const metersX = ((bounds.east - bounds.west) * Math.PI * 6378137 * Math.cos(latRad)) / 180;
  // Latitude span → meters (roughly constant)
  const metersY = ((bounds.north - bounds.south) * Math.PI * 6378137) / 180;

  const cellSizeX = metersX / tileSize;
  const cellSizeY = metersY / tileSize;

  console.log(
    `[slope][cellSize] z=${z} ${x}/${y} | bounds: N=${bounds.north.toFixed(4)} S=${bounds.south.toFixed(4)} E=${bounds.east.toFixed(4)} W=${bounds.west.toFixed(4)} | midLat=${midLat.toFixed(4)}° | metersX=${metersX.toFixed(1)} metersY=${metersY.toFixed(1)} | cellSizeX=${cellSizeX.toFixed(3)}m cellSizeY=${cellSizeY.toFixed(3)}m`
  );
  if (cellSizeX > 100 || cellSizeY > 100) {
    console.warn(`[slope][cellSize] %c LARGE CELL %c cellSize > 100m — gradients will be tiny → slopes near 0°`, 'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '');
  }

  return { cellSizeX, cellSizeY };
}

/**
 * Compute slope angles (degrees) from an elevation Float32Array.
 * Horn's method — weights the 3×3 neighborhood:
 *
 *   a  b  c
 *   d  e  f
 *   g  h  i
 *
 *   dz/dx = ((c + 2f + i) - (a + 2d + g)) / (8 * cellSizeX)
 *   dz/dy = ((g + 2h + i) - (a + 2b + c)) / (8 * cellSizeY)
 *   slope = atan(sqrt(dz_dx² + dz_dy²)) in degrees
 *
 * Edges replicate the nearest border pixel.
 */
function computeSlopes(elevations, tileSize, cellSizeX, cellSizeY) {
  const slopes = new Float32Array(tileSize * tileSize);
  const inv8x = 1 / (8 * cellSizeX);
  const inv8y = 1 / (8 * cellSizeY);
  const RAD2DEG = 180 / Math.PI;

  for (let row = 0; row < tileSize; row++) {
    for (let col = 0; col < tileSize; col++) {
      // Clamp indices for edge replication
      const r0 = Math.max(row - 1, 0);
      const r2 = Math.min(row + 1, tileSize - 1);
      const c0 = Math.max(col - 1, 0);
      const c2 = Math.min(col + 1, tileSize - 1);

      const a = elevations[r0 * tileSize + c0];
      const b = elevations[r0 * tileSize + col];
      const c = elevations[r0 * tileSize + c2];
      const d = elevations[row * tileSize + c0];
      // e = center, not needed
      const f = elevations[row * tileSize + c2];
      const g = elevations[r2 * tileSize + c0];
      const h = elevations[r2 * tileSize + col];
      const i = elevations[r2 * tileSize + c2];

      const dzDx = ((c + 2 * f + i) - (a + 2 * d + g)) * inv8x;
      const dzDy = ((g + 2 * h + i) - (a + 2 * b + c)) * inv8y;

      const slopeDeg = Math.atan(Math.sqrt(dzDx * dzDx + dzDy * dzDy)) * RAD2DEG;
      slopes[row * tileSize + col] = slopeDeg;
    }
  }

  // ── DEBUG: slope stats ──
  let minS = Infinity, maxS = -Infinity, sumS = 0;
  let minE = Infinity, maxE = -Infinity, sumE = 0;
  const n = tileSize * tileSize;
  for (let k = 0; k < n; k++) {
    const s = slopes[k], e = elevations[k];
    if (s < minS) minS = s; if (s > maxS) maxS = s; sumS += s;
    if (e < minE) minE = e; if (e > maxE) maxE = e; sumE += e;
  }
  const meanS = sumS / n, meanE = sumE / n;
  // Histogram: count per slope band
  const bins = [0,0,0,0,0,0]; // 0-7, 7-15, 15-25, 25-35, 35-45, 45+
  for (let k = 0; k < n; k++) {
    const s = slopes[k];
    if (s < 7) bins[0]++;
    else if (s < 15) bins[1]++;
    else if (s < 25) bins[2]++;
    else if (s < 35) bins[3]++;
    else if (s < 45) bins[4]++;
    else bins[5]++;
  }
  const pct = bins.map(b => (b / n * 100).toFixed(1) + '%');
  console.log(
    `[slope][compute] %c SLOPES %c elev: [${minE.toFixed(1)}, ${maxE.toFixed(1)}] mean=${meanE.toFixed(1)} range=${(maxE-minE).toFixed(1)}m | slope: [${minS.toFixed(2)}°, ${maxS.toFixed(2)}°] mean=${meanS.toFixed(2)}° | inv8x=${inv8x.toFixed(6)} inv8y=${inv8y.toFixed(6)}`,
    'background:#9C27B0;color:#fff;padding:2px 4px;border-radius:2px', ''
  );
  console.log(
    `[slope][compute] histogram: 0-7°=${pct[0]} 7-15°=${pct[1]} 15-25°=${pct[2]} 25-35°=${pct[3]} 35-45°=${pct[4]} 45+°=${pct[5]}`
  );
  if (maxS < 7 && maxE - minE > 50) {
    console.warn(`[slope][compute] %c BUG? %c Elevation range > 50m but max slope < 7° — cell size may be too large or inv8 too small`, 'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '');
  }

  return slopes;
}

// ── Slope color ramp ──────────────────────────────────────────────────
// Must match src/features/slope/lib/slope-config.ts SLOPE_CATEGORIES.
const SLOPE_COLOR_STOPS = [
  { deg:  0, r: 0x2D, g: 0xBF, b: 0x5E }, // #2DBF5E — flat
  { deg:  7, r: 0xFF, g: 0xD8, b: 0x4D }, // #FFD84D — moderate
  { deg: 15, r: 0xFF, g: 0xA0, b: 0x33 }, // #FFA033 — steep
  { deg: 25, r: 0xFF, g: 0x57, b: 0x33 }, // #FF5733 — very steep
  { deg: 35, r: 0xE5, g: 0x26, b: 0x1F }, // #E5261F — extreme
  { deg: 45, r: 0x8B, g: 0x00, b: 0x00 }, // #8B0000 — cliff
];

function slopeToColorGradient(deg) {
  const stops = SLOPE_COLOR_STOPS;
  if (deg <= stops[0].deg) return stops[0];
  if (deg >= stops[stops.length - 1].deg) return stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (deg >= stops[i].deg && deg < stops[i + 1].deg) {
      const t = (deg - stops[i].deg) / (stops[i + 1].deg - stops[i].deg);
      return {
        r: Math.round(stops[i].r + t * (stops[i + 1].r - stops[i].r)),
        g: Math.round(stops[i].g + t * (stops[i + 1].g - stops[i].g)),
        b: Math.round(stops[i].b + t * (stops[i + 1].b - stops[i].b)),
      };
    }
  }
  return stops[stops.length - 1];
}

function slopeToColorStep(deg) {
  const stops = SLOPE_COLOR_STOPS;
  for (let i = stops.length - 1; i >= 0; i--) {
    if (deg >= stops[i].deg) return stops[i];
  }
  return stops[0];
}

/**
 * Encode slope degrees as a pre-colored RGBA PNG.
 * Colors are baked in so the raster layer needs no raster-color-mix decode.
 *
 * Alpha channel: 255 for valid data, 0 for NODATA pixels.
 */
async function encodeSlopePng(slopes, elevations, colorMode) {
  const size = DEM_TILE_SIZE;
  const rgba = new Uint8Array(size * size * 4);
  let noDataCount = 0;
  const colorFn = colorMode === 'step' ? slopeToColorStep : slopeToColorGradient;

  for (let j = 0; j < slopes.length; j++) {
    const elev = elevations[j];
    const isNoData = elev <= DEM_NODATA_THRESHOLD;
    if (isNoData) noDataCount++;

    const idx = j * 4;
    if (isNoData) {
      rgba[idx] = rgba[idx + 1] = rgba[idx + 2] = 0;
      rgba[idx + 3] = 0;
    } else {
      const c = colorFn(slopes[j]);
      rgba[idx]     = c.r;
      rgba[idx + 1] = c.g;
      rgba[idx + 2] = c.b;
      rgba[idx + 3] = 255;
    }
  }

  // ── DEBUG: encode verification ──
  const mid = Math.floor(size / 2) * size + Math.floor(size / 2);
  const samples = [];
  for (let s = 0; s < 3; s++) {
    const pi = mid + s * 53;
    const si = pi * 4;
    samples.push(`slope=${slopes[pi]?.toFixed(2)}° → RGBA(${rgba[si]},${rgba[si+1]},${rgba[si+2]},${rgba[si+3]}) mode=${colorMode}`);
  }
  console.log(
    `[slope][encode] noData=${noDataCount}/${size*size} (${(noDataCount/(size*size)*100).toFixed(1)}%) | ${samples.join(' | ')}`
  );

  return buildRawPng(size, size, rgba);
}

/**
 * Full pipeline: DEM blob → slope PNG blob.
 * Returns null if decoding fails.
 * @param {string} colorMode — 'gradient' or 'step'
 */
async function buildSlopeTile(demBlob, z, x, y, colorMode) {
  const t0 = performance.now();
  console.log(`[slope][build] ━━━ START ${z}/${x}/${y} mode=${colorMode} ━━━`);
  const elevations = await decodeTerrainRGBBlob(demBlob);
  const t1 = performance.now();
  const { cellSizeX, cellSizeY } = computeCellSize(z, x, y, DEM_TILE_SIZE);
  const slopes = computeSlopes(elevations, DEM_TILE_SIZE, cellSizeX, cellSizeY);
  const t2 = performance.now();
  const blob = await encodeSlopePng(slopes, elevations, colorMode);
  const t3 = performance.now();
  console.log(
    `[slope][build] ━━━ DONE ${z}/${x}/${y} ━━━ decode=${(t1-t0).toFixed(0)}ms compute=${(t2-t1).toFixed(0)}ms encode=${(t3-t2).toFixed(0)}ms total=${(t3-t0).toFixed(0)}ms`
  );
  return blob;
}
