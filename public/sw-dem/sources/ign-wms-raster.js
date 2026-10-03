// ---------------------------------------------------------------------------
// IGN WMS elevation rasters — request geometry (metre-square), supersampling,
// GetMap fetch, de-duplication of nearest-neighbour rows and resampling to
// DEM_TILE_SIZE².
// ---------------------------------------------------------------------------

// ── WMS anti-aliasing: 2× supersample + box average ───────────────────
// The geopf WMS resamples its pyramid nearest-neighbour. Asked for exactly
// the output grid, the samples alias against the 0.5 m LiDAR grid and Horn
// turns that into regular row/column bands ("hachures") on the slope
// overlay. Fetching 2× and box-averaging 2×2 is a proper area sample.
// Measured on 5 French sites at z14-16 (row/col band energy of the slope
// field, and mean |error| against a 4× reference):
//   1×: bands 0.46-1.62, error 0.63-7.54°
//   2×: bands 0.20-0.78, error 0.26-3.03°   (4× reference: 0.15-0.73)
// 3× is worse than 2× (non-integer box partition); 2× in one axis only
// leaves the bands of the other axis. Costs 4× the payload (≈1.5 MB per
// tile, BIL32 is not compressed by geopf), hence only from z13 where the
// overlay shows the LiDAR detail.
function ignWmsSupersampleFactor(mercZ) {
  return mercZ >= 13 ? 2 : 1;
}

// The 0.40 m MNS stays at 1×: it is the 3D basemap mesh, requested for the
// whole viewport on every load. At 2× (≈1.5 MB per tile) a 36-tile z14
// viewport took 13-15 s and a 64-tile z15 one up to 19 s against geopf
// (≈3.4 MB/s, measured 2026-10-01), past IGN_FETCH_TIMEOUT_MS: the aborted
// builds cascaded into MNT/RGE ALTI fallbacks and surface recoveries, and the
// map never finished loading. 1×: 4 s for the same viewports.
function mnsWmsSupersampleFactor() {
  return 1;
}

// One GetMap raster, metre-square geometry (see mnsWmsRequestSize), raw
// srcWidth × srcHeight floats. null on any HTTP / size failure.
async function fetchWmsElevationRaster(layer, mercZ, mercX, mercY, supersample, init) {
  const { width, height } = mnsWmsRequestSize(mercZ, mercX, mercY, supersample);
  const url = buildMnsWmsTileURL(mercZ, mercX, mercY, layer, width, height);
  const res = await fetchIgnWithRetry(url, init);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength !== width * height * 4) return null;
  return new Float32Array(buf);
}

function isValidWmsElevation(v) {
  return !Number.isNaN(v) && v >= MIN_VALID_ELEVATION_M && v <= MAX_VALID_ELEVATION_M;
}

// ── WMS request geometry: metre-square, never degree-square ───────────
//
// The IGN WMS resamples every product into the CRS/bbox it is asked for. The
// products are stored on a METRE-square grid, which in EPSG:4326 is
// 1/cos(lat) WIDER than tall. Asking for a degree-square raster
// (WIDTH === HEIGHT) therefore forces the server to stretch the rows with a
// nearest-neighbour kernel, which duplicates 1 - cos(lat) of them. Measured
// against data.geopf.fr, the duplication ratio matches 1 - cos(lat) to within
// 0.3 %:
//   lat 42.8° -> predicted 26.6 %, measured 26.27 %
//   lat 45.1° -> predicted 29.4 %, measured 29.41 %
//   lat 48.3° -> predicted 33.5 %, measured 33.33 %
//
// Duplicated rows are catastrophic for the slope overlay. Horn's kernel reads
// ∂z/∂y across two adjacent rows, so the gradient alternates between 0 and
// ~2× the true value on successive rows; the raster-colour ramp then paints
// the terrain as horizontal dashes (the "peigne" artefact) instead of a smooth
// slope field.
//
// Fix: ask for a raster that is metre-square — 1/cos(lat) MORE columns than
// rows — while keeping DEM_TILE_SIZE rows so no vertical detail is lost. On the
// LiDAR-HD MNS layer this drops duplicated rows from 29.4 % to 0.00 % and the
// even/odd row-gradient comb from 0.018 to 0.000 (verified at 42.8 / 45.1 /
// 48.3°N). The surplus columns are box-averaged back to DEM_TILE_SIZE by
// `mnsWmsResampleToTile`.
//
// Note: EPSG:3857 is NOT a fix (measured 22.4 % duplicated rows and a comb of
// 0.67 — the Mercator reprojection is worse), and the LiDAR-HD layer is not
// published in EPSG:2154 at all (constant tile).
function mnsWmsRequestSize(mercZ, mercX, mercY, supersample = 1) {
  const bounds = mercatorTileBounds(mercZ, mercX, mercY);
  const midLat = (bounds.north + bounds.south) / 2;
  const cosLat = Math.max(0.35, Math.min(1, Math.cos((midLat * Math.PI) / 180)));
  const height = DEM_TILE_SIZE * supersample;
  const width = Math.max(height, Math.round(height / cosLat));
  return { width, height };
}

function buildMnsWmsTileURL(mercZ, mercX, mercY, layer, width, height) {
  const bounds = mercatorTileBounds(mercZ, mercX, mercY);
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east].join(',');
  return (
    `${IGN_WMS_BASE}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0` +
    `&LAYERS=${encodeURIComponent(layer)}&STYLES=` +
    `&FORMAT=${encodeURIComponent(IGN_DEM_FORMAT)}` +
    `&CRS=EPSG:4326&BBOX=${bbox}` +
    `&WIDTH=${width}&HEIGHT=${height}`
  );
}

// ── Undo nearest-neighbour row duplication ────────────────────────────
// A row that is bit-identical to the row above carries no extra information:
// it is the residue of the server upsampling the rows of its own coarser grid.
// Replace every run of identical rows by a linear ramp between the two distinct
// rows that bracket it, so Horn's ∂z/∂y sees a continuous gradient instead of a
// 0 / 2× alternation.
//
// Safe on genuinely flat terrain: on a lake or a plateau the bracketing rows
// hold the same elevation, so the interpolation is a no-op.
function decombDuplicateRows(f, width, height) {
  if (width <= 0 || height <= 2) return 0;
  let repaired = 0;
  // Two passes: the first cleans the long runs, the second catches runs that
  // only became adjacent once the first pass broke a longer run apart.
  for (let pass = 0; pass < 2; pass++) {
    let run = 0;
    for (let y = 1; y <= height; y++) {
      let duplicate = false;
      if (y < height) {
        duplicate = true;
        const a = (y - 1) * width;
        const b = y * width;
        for (let x = 0; x < width; x++) {
          if (f[a + x] !== f[b + x]) { duplicate = false; break; }
        }
      }
      if (duplicate) { run++; continue; }
      if (run > 0) {
        const topRow = y - run - 1;
        const bottomRow = y < height ? y : -1;
        if (topRow >= 0 && bottomRow >= 0) {
          const topOff = topRow * width;
          const bottomOff = bottomRow * width;
          for (let k = 1; k <= run; k++) {
            const t = k / (run + 1);
            const off = (topRow + k) * width;
            for (let x = 0; x < width; x++) {
              const a = f[topOff + x];
              f[off + x] = a + (f[bottomOff + x] - a) * t;
            }
          }
          repaired += run;
        }
      }
      run = 0;
    }
  }
  return repaired;
}

// Resample a WMS raster of arbitrary geometry down to DEM_TILE_SIZE².
// NaN/NODATA-aware box average, so sentinel pixels never poison a cell.
function mnsWmsResampleToTile(raw, srcWidth, srcHeight) {
  if (srcWidth === DEM_TILE_SIZE && srcHeight === DEM_TILE_SIZE) {
    decombDuplicateRows(raw, DEM_TILE_SIZE, DEM_TILE_SIZE);
    return raw;
  }
  const out = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
  const sx = srcWidth / DEM_TILE_SIZE;
  const sy = srcHeight / DEM_TILE_SIZE;
  // Column spans depend on x only — compute them once, not once per pixel.
  const colStart = new Int32Array(DEM_TILE_SIZE);
  const colEnd = new Int32Array(DEM_TILE_SIZE);
  for (let x = 0; x < DEM_TILE_SIZE; x++) {
    const x0 = Math.floor(x * sx);
    colStart[x] = x0;
    colEnd[x] = Math.min(srcWidth, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
  }
  for (let y = 0; y < DEM_TILE_SIZE; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(srcHeight, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
    const outRow = y * DEM_TILE_SIZE;
    for (let x = 0; x < DEM_TILE_SIZE; x++) {
      const x0 = colStart[x];
      const x1 = colEnd[x];
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * srcWidth;
        for (let xx = x0; xx < x1; xx++) {
          const v = raw[row + xx];
          if (!Number.isNaN(v) && v >= MIN_VALID_ELEVATION_M && v <= MAX_VALID_ELEVATION_M) {
            sum += v;
            n++;
          }
        }
      }
      out[outRow + x] = n > 0 ? sum / n : NaN;
    }
  }
  decombDuplicateRows(out, DEM_TILE_SIZE, DEM_TILE_SIZE);
  return out;
}
