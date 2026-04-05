// ---------------------------------------------------------------------------
// Service Worker — Client-side DEM + Ortho tile processor
// Intercepts /dem-tiles/{z}/{x}/{y} → Terrain-RGB PNGs (IGN MNS + Mapbox)
// Intercepts /ortho-tiles/{z}/{x}/{y} → IGN orthophotos clipped to France border
// ---------------------------------------------------------------------------

const CACHE_NAME = 'dem-tiles-v5';

// Config — DEM
const IGN_WMTS_BASE = 'https://data.geopf.fr/wmts';
const IGN_DEM_LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS';
const IGN_DEM_TILEMATRIXSET = 'WGS84G_4_17';
const IGN_DEM_FORMAT = 'image/x-bil;bits=32';

const FRANCE_BOUNDS = [-5.5, 41.0, 10.0, 51.5];
const DEM_TILE_SIZE = 512;
const IGN_SRC_TILE_SIZE = 256;
const DEM_NODATA_THRESHOLD = -10000;
const IGN_DEM_MINZOOM = 4;
const IGN_DEM_MAXZOOM = 17;

// Config — Orthophoto (proxied for France-border clipping)
const IGN_ORTHO_LAYER = 'HR.ORTHOIMAGERY.ORTHOPHOTOS';
const IGN_ORTHO_TILEMATRIXSET = 'PM_6_19';
const ORTHO_TILE_SIZE = 256;
const ORTHO_CACHE_NAME = 'ortho-tiles-v1';

// In-memory BIL tile cache (survives across fetches within same SW lifetime)
const ignTileCache = new Map();
const IGN_CACHE_MAX = 3000;

// Mapbox token (received from main thread via postMessage)
let mapboxToken = '';

// France border polygon (loaded lazily from /france-border.json)
let francePoly = null;
let francePolyBBoxes = null;
let francePolyLoading = null;

// ---------------------------------------------------------------------------
// SW Lifecycle
// ---------------------------------------------------------------------------

const STATIC_CACHE_NAME = 'dem-static-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(STATIC_CACHE_NAME)
      .then(cache => cache.add('/france-border.json'))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    // Purge old caches from previous SW versions
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k === 'dem-tiles-v1' || k === 'dem-tiles-v2' || k === 'dem-tiles-v3' || k === 'dem-tiles-v4' || k === 'dem-negative-v1')
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SET_MAPBOX_TOKEN') {
    mapboxToken = e.data.token;
  }
});

// ---------------------------------------------------------------------------
// Fetch intercept
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  const demMatch = url.pathname.match(/^\/dem-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (demMatch) {
    event.respondWith(handleDemRequest(event.request,
      parseInt(demMatch[1], 10), parseInt(demMatch[2], 10), parseInt(demMatch[3], 10)));
    return;
  }

  const orthoMatch = url.pathname.match(/^\/ortho-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (orthoMatch) {
    event.respondWith(handleOrthoRequest(
      parseInt(orthoMatch[1], 10), parseInt(orthoMatch[2], 10), parseInt(orthoMatch[3], 10)));
    return;
  }
});

const NEGATIVE_CACHE_NAME = 'dem-negative-v1';
const NEGATIVE_TTL = 3600; // 1 hour in seconds

async function handleDemRequest(request, z, x, y) {
  // Check Cache API first (positive cache)
  const cache = await caches.open(CACHE_NAME);
  const cacheKey = new Request(`/dem-tiles/${z}/${x}/${y}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Check negative cache (tiles known to have no data)
  const negCache = await caches.open(NEGATIVE_CACHE_NAME);
  const negCached = await negCache.match(cacheKey);
  if (negCached) {
    const age = negCached.headers.get('x-cached-at');
    if (age && (Date.now() - parseInt(age, 10)) < NEGATIVE_TTL * 1000) {
      return new Response(null, { status: 204 });
    }
    // Expired — delete and retry
    negCache.delete(cacheKey);
  }

  try {
    let pngBlob;

    if (tileOverlapsFrance(z, x, y) && z >= IGN_DEM_MINZOOM) {
      const ignResult = await buildIGNTile(z, x, y);

      if (ignResult) {
        if (ignResult.blob) {
          // Fully covered by IGN — use directly
          pngBlob = ignResult.blob;
        } else {
          // Partial IGN coverage — composite with Mapbox (includes blend zone)
          pngBlob = await compositeIGNMapbox(ignResult.elevations, ignResult.coverage, z, x, y);
        }
      }
    }

    // No IGN result (or tile outside France bounds) — pure Mapbox fallback
    if (!pngBlob && mapboxToken) {
      pngBlob = await fetchMapboxTile(z, x, y);
    }

    if (!pngBlob) {
      // Cache negative result to avoid repeated requests
      negCache.put(cacheKey, new Response(null, {
        status: 204,
        headers: { 'x-cached-at': String(Date.now()) },
      }));
      return new Response(null, { status: 204 });
    }

    const response = new Response(pngBlob, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=604800',
      },
    });

    // Cache the successful response (clone because body can only be consumed once)
    cache.put(cacheKey, response.clone());
    return response;
  } catch (err) {
    console.error('[sw-dem] Error processing tile', z, x, y, err);
    return new Response(null, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Coordinate conversions
// ---------------------------------------------------------------------------

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

function lngLatToWGS84GTile(lng, lat, z) {
  const matrixWidth = 1 << (z + 1);
  const matrixHeight = 1 << z;
  return {
    col: Math.max(0, Math.min(Math.floor(((lng + 180) / 360) * matrixWidth), matrixWidth - 1)),
    row: Math.max(0, Math.min(Math.floor(((90 - lat) / 180) * matrixHeight), matrixHeight - 1)),
  };
}

function mercatorYToLat(yFrac) {
  const mercY = Math.PI * (1 - 2 * yFrac);
  return (Math.atan(Math.sinh(mercY)) * 180) / Math.PI;
}

function tileOverlapsFrance(z, x, y) {
  const b = mercatorTileBounds(z, x, y);
  const [w, s, e, n] = FRANCE_BOUNDS;
  return !(b.east < w || b.west > e || b.south > n || b.north < s);
}

// ---------------------------------------------------------------------------
// BIL decoder & elevation sanitizer
// ---------------------------------------------------------------------------

function decodeBIL32(buffer) {
  const expectedBytes = IGN_SRC_TILE_SIZE * IGN_SRC_TILE_SIZE * 4;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(`Invalid BIL size: expected ${expectedBytes}, got ${buffer.byteLength}`);
  }
  return new Float32Array(buffer);
}

function sanitizeElevation(value) {
  if (Number.isNaN(value) || value < DEM_NODATA_THRESHOLD) return 0;
  return value;
}

// Check if the raw elevation at nearest pixel is actually valid data
// (not NODATA). Used to build accurate coverage masks — a WGS84G tile
// can contain valid French data in one part and NODATA in another.
function hasValidRawElevation(data, fx, fy) {
  const ix = Math.max(0, Math.min(Math.round(fx), IGN_SRC_TILE_SIZE - 1));
  const iy = Math.max(0, Math.min(Math.round(fy), IGN_SRC_TILE_SIZE - 1));
  const val = data[iy * IGN_SRC_TILE_SIZE + ix];
  return !Number.isNaN(val) && val >= DEM_NODATA_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Bicubic interpolation (Catmull-Rom)
// ---------------------------------------------------------------------------

function cubicHermite(A, B, C, D, t) {
  const a = -A / 2 + (3 * B) / 2 - (3 * C) / 2 + D / 2;
  const b = A - (5 * B) / 2 + 2 * C - D / 2;
  const c = -A / 2 + C / 2;
  return a * t * t * t + b * t * t + c * t + B;
}

function sampleAt(data, x, y) {
  const cx = Math.max(0, Math.min(x, IGN_SRC_TILE_SIZE - 1));
  const cy = Math.max(0, Math.min(y, IGN_SRC_TILE_SIZE - 1));
  return sanitizeElevation(data[cy * IGN_SRC_TILE_SIZE + cx]);
}

function bicubicSample(data, fx, fy) {
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const dx = fx - ix;
  const dy = fy - iy;

  const rows = [];
  for (let j = -1; j <= 2; j++) {
    const c0 = sampleAt(data, ix - 1, iy + j);
    const c1 = sampleAt(data, ix, iy + j);
    const c2 = sampleAt(data, ix + 1, iy + j);
    const c3 = sampleAt(data, ix + 2, iy + j);
    rows.push(cubicHermite(c0, c1, c2, c3, dx));
  }

  return cubicHermite(rows[0], rows[1], rows[2], rows[3], dy);
}

// ---------------------------------------------------------------------------
// LRU eviction for in-memory cache
// ---------------------------------------------------------------------------

function evict(cache, max) {
  if (cache.size <= max) return;
  const iter = cache.keys();
  const toDelete = cache.size - Math.floor(max * 0.75);
  for (let i = 0; i < toDelete; i++) {
    const k = iter.next().value;
    if (k !== undefined) cache.delete(k);
  }
}

// ---------------------------------------------------------------------------
// IGN tile fetching (with in-memory cache + concurrency limiter)
// ---------------------------------------------------------------------------

let activeIGN = 0;
const IGN_CONCURRENCY = 4;
const ignQueue = [];

function scheduleIGN(fn) {
  return new Promise((resolve, reject) => {
    ignQueue.push({ fn, resolve, reject });
    drainIGN();
  });
}

function drainIGN() {
  while (activeIGN < IGN_CONCURRENCY && ignQueue.length > 0) {
    const { fn, resolve, reject } = ignQueue.shift();
    activeIGN++;
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        activeIGN--;
        drainIGN();
      });
  }
}

function buildDEMTileURL(z, col, row) {
  return (
    `${IGN_WMTS_BASE}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${IGN_DEM_LAYER}&STYLE=normal` +
    `&FORMAT=${encodeURIComponent(IGN_DEM_FORMAT)}` +
    `&TILEMATRIXSET=${IGN_DEM_TILEMATRIXSET}` +
    `&TILEMATRIX=${z}&TILEROW=${row}&TILECOL=${col}`
  );
}

async function getIGNTile(z, col, row) {
  const key = `${z}/${col}/${row}`;
  if (ignTileCache.has(key)) return ignTileCache.get(key);

  return scheduleIGN(async () => {
    // Re-check after waiting in queue
    if (ignTileCache.has(key)) return ignTileCache.get(key);

    const url = buildDEMTileURL(z, col, row);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        ignTileCache.set(key, null);
        return null;
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength !== IGN_SRC_TILE_SIZE * IGN_SRC_TILE_SIZE * 4) {
        ignTileCache.set(key, null);
        return null;
      }
      const data = decodeBIL32(buf);
      evict(ignTileCache, IGN_CACHE_MAX);
      ignTileCache.set(key, data);
      return data;
    } catch {
      ignTileCache.set(key, null);
      return null;
    }
  });
}

// ---------------------------------------------------------------------------
// Build IGN Terrain-RGB tile (Mercator ← WGS84G resampling + OffscreenCanvas PNG)
// Returns { blob, elevations, coverage } where coverage is a Uint8Array mask
// (1 = IGN data, 0 = no data). Returns null if no IGN coverage at all.
// ---------------------------------------------------------------------------

async function buildIGNTile(mercZ, mercX, mercY) {
  const demZ = Math.max(IGN_DEM_MINZOOM, Math.min(mercZ, IGN_DEM_MAXZOOM));
  const bounds = mercatorTileBounds(mercZ, mercX, mercY);
  const tl = lngLatToWGS84GTile(bounds.west, bounds.north, demZ);
  const br = lngLatToWGS84GTile(bounds.east, bounds.south, demZ);

  // Fetch all needed IGN tiles
  const tileMap = new Map();
  const fetches = [];
  for (let row = tl.row; row <= br.row; row++) {
    for (let col = tl.col; col <= br.col; col++) {
      fetches.push(
        getIGNTile(demZ, col, row).then((d) => {
          tileMap.set(`${col}/${row}`, d);
        }),
      );
    }
  }
  await Promise.all(fetches);

  const totalPixels = DEM_TILE_SIZE * DEM_TILE_SIZE;
  const elevations = new Float32Array(totalPixels);
  const coverage = new Uint8Array(totalPixels); // 1 = has IGN data
  const n = 1 << mercZ;
  const matrixWidth = 1 << (demZ + 1);
  const matrixHeight = 1 << demZ;
  let coveredCount = 0;

  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    const yFrac = (mercY + (py + 0.5) / DEM_TILE_SIZE) / n;
    const lat = mercatorYToLat(yFrac);

    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const xFrac = (mercX + (px + 0.5) / DEM_TILE_SIZE) / n;
      const lng = xFrac * 360 - 180;

      const col = Math.max(0, Math.min(Math.floor(((lng + 180) / 360) * matrixWidth), matrixWidth - 1));
      const row = Math.max(0, Math.min(Math.floor(((90 - lat) / 180) * matrixHeight), matrixHeight - 1));

      const tileData = tileMap.get(`${col}/${row}`);
      if (tileData) {
        const fx = (((lng + 180) / 360) * matrixWidth - col) * IGN_SRC_TILE_SIZE;
        const fy = (((90 - lat) / 180) * matrixHeight - row) * IGN_SRC_TILE_SIZE;
        // Only mark as covered if the raw BIL value at this pixel is valid,
        // not NODATA — a single WGS84G tile can have data for France and
        // NODATA for Italy/Spain/etc.
        if (hasValidRawElevation(tileData, fx, fy)) {
          elevations[py * DEM_TILE_SIZE + px] = bicubicSample(tileData, fx, fy);
          coverage[py * DEM_TILE_SIZE + px] = 1;
          coveredCount++;
        }
      }
    }
  }

  // No IGN coverage at all → return null so caller falls back to Mapbox
  if (coveredCount === 0) return null;

  // Fully covered → encode directly, no compositing needed
  if (coveredCount === totalPixels) {
    return { blob: await encodeTerrainRGBPng(elevations), elevations, coverage };
  }

  // --- Border pixel dilation (2 passes) ---
  // Fill uncovered pixels adjacent to valid IGN data by propagating
  // nearest valid elevation. This prevents bicubic sampling artifacts
  // at NODATA boundaries inside WGS84G tiles and provides smoother
  // transition data for the blend zone.
  for (let pass = 0; pass < 2; pass++) {
    const newElevations = new Float32Array(elevations);
    const newCoverage = new Uint8Array(coverage);
    for (let py = 0; py < DEM_TILE_SIZE; py++) {
      for (let px = 0; px < DEM_TILE_SIZE; px++) {
        const idx = py * DEM_TILE_SIZE + px;
        if (coverage[idx]) continue; // already covered
        // Check 4-connected neighbors for valid data
        let sum = 0, count = 0;
        if (py > 0 && coverage[idx - DEM_TILE_SIZE]) { sum += elevations[idx - DEM_TILE_SIZE]; count++; }
        if (py < DEM_TILE_SIZE - 1 && coverage[idx + DEM_TILE_SIZE]) { sum += elevations[idx + DEM_TILE_SIZE]; count++; }
        if (px > 0 && coverage[idx - 1]) { sum += elevations[idx - 1]; count++; }
        if (px < DEM_TILE_SIZE - 1 && coverage[idx + 1]) { sum += elevations[idx + 1]; count++; }
        if (count > 0) {
          newElevations[idx] = sum / count;
          newCoverage[idx] = 1;
          coveredCount++;
        }
      }
    }
    elevations.set(newElevations);
    coverage.set(newCoverage);
  }

  // Re-check: dilation might have filled everything
  if (coveredCount >= totalPixels) {
    return { blob: await encodeTerrainRGBPng(elevations), elevations, coverage };
  }

  // Partial coverage → return data for compositing with Mapbox
  return { blob: null, elevations, coverage };
}

// ---------------------------------------------------------------------------
// Terrain-RGB PNG encoding via OffscreenCanvas
// ---------------------------------------------------------------------------

async function encodeTerrainRGBPng(elevations) {
  const size = DEM_TILE_SIZE;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(size, size);
  const pixels = imageData.data;

  for (let i = 0; i < elevations.length; i++) {
    const height = sanitizeElevation(elevations[i]);
    const val = Math.round((height + 10000) / 0.1);
    const idx = i * 4;
    pixels[idx] = (val >> 16) & 0xff;
    pixels[idx + 1] = (val >> 8) & 0xff;
    pixels[idx + 2] = val & 0xff;
    pixels[idx + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

// ---------------------------------------------------------------------------
// Terrain-RGB PNG decoding — reads a Mapbox Terrain-RGB blob back to elevations
// ---------------------------------------------------------------------------

async function decodeTerrainRGBBlob(blob) {
  const img = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  const pixels = imageData.data;
  const elevations = new Float32Array(img.width * img.height);

  for (let i = 0; i < elevations.length; i++) {
    const idx = i * 4;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    elevations[i] = -10000 + (r * 65536 + g * 256 + b) * 0.1;
  }
  return elevations;
}

// ---------------------------------------------------------------------------
// Composite IGN + Mapbox elevations with blend zone at boundary
// ---------------------------------------------------------------------------

async function compositeIGNMapbox(ignElevations, coverage, z, x, y) {
  // Fetch Mapbox tile for the uncovered pixels
  const mapboxBlob = await fetchMapboxTile(z, x, y);
  if (!mapboxBlob) {
    // No Mapbox data available — just encode IGN as-is (uncovered pixels = 0)
    return encodeTerrainRGBPng(ignElevations);
  }

  // Decode Mapbox tile
  const mbElevations = await decodeTerrainRGBBlob(mapboxBlob);

  const totalPixels = DEM_TILE_SIZE * DEM_TILE_SIZE;

  // Adaptive blend radius: wider at low zoom (each pixel covers more ground)
  // z5 → ~160px, z10 → ~96px, z14 → ~72px, z16 → ~64px
  const BLEND_RADIUS = Math.max(64, Math.round(160 / Math.pow(1.1, Math.max(0, z - 5))));

  // Smoothstep for artifact-free blending (no linear seam)
  function smoothstep(t) {
    const c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c);
  }

  // Resample Mapbox elevations helper
  const mbSize = Math.round(Math.sqrt(mbElevations.length));
  const scale = mbSize / DEM_TILE_SIZE;

  function sampleMB(px, py) {
    if (scale === 1) return mbElevations[py * DEM_TILE_SIZE + px];
    const mx = Math.min((px * scale) | 0, mbSize - 1);
    const my = Math.min((py * scale) | 0, mbSize - 1);
    return mbElevations[my * mbSize + mx];
  }

  // --- Distance transform (Chamfer 2-pass) ---
  const distToBorder = new Float32Array(totalPixels);
  const INF = DEM_TILE_SIZE * 2;
  distToBorder.fill(INF);

  // Mark border pixels (distance = 0)
  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const idx = py * DEM_TILE_SIZE + px;
      const c = coverage[idx];
      if (
        (py > 0 && coverage[idx - DEM_TILE_SIZE] !== c) ||
        (py < DEM_TILE_SIZE - 1 && coverage[idx + DEM_TILE_SIZE] !== c) ||
        (px > 0 && coverage[idx - 1] !== c) ||
        (px < DEM_TILE_SIZE - 1 && coverage[idx + 1] !== c)
      ) {
        distToBorder[idx] = 0;
      }
    }
  }

  // Forward pass
  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const idx = py * DEM_TILE_SIZE + px;
      if (py > 0) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx - DEM_TILE_SIZE] + 1);
      if (px > 0) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx - 1] + 1);
      if (py > 0 && px > 0) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx - DEM_TILE_SIZE - 1] + 1.414);
      if (py > 0 && px < DEM_TILE_SIZE - 1) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx - DEM_TILE_SIZE + 1] + 1.414);
    }
  }

  // Backward pass
  for (let py = DEM_TILE_SIZE - 1; py >= 0; py--) {
    for (let px = DEM_TILE_SIZE - 1; px >= 0; px--) {
      const idx = py * DEM_TILE_SIZE + px;
      if (py < DEM_TILE_SIZE - 1) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx + DEM_TILE_SIZE] + 1);
      if (px < DEM_TILE_SIZE - 1) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx + 1] + 1);
      if (py < DEM_TILE_SIZE - 1 && px < DEM_TILE_SIZE - 1) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx + DEM_TILE_SIZE + 1] + 1.414);
      if (py < DEM_TILE_SIZE - 1 && px > 0) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx + DEM_TILE_SIZE - 1] + 1.414);
    }
  }

  // --- Collect per-pixel border offset samples (IGN − Mapbox) ---
  // Instead of a single average, store spatially-located samples so we can
  // interpolate a locally-varying offset across the blend zone.
  const borderSamples = []; // { px, py, offset }
  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const idx = py * DEM_TILE_SIZE + px;
      if (distToBorder[idx] < 3 && coverage[idx]) {
        const mb = sampleMB(px, py);
        if (mb > -9000) {
          borderSamples.push({ px, py, offset: ignElevations[idx] - mb });
        }
      }
    }
  }

  // Compute median offset as fallback (robust against outliers)
  let medianOffset = 0;
  if (borderSamples.length > 0) {
    const sorted = borderSamples.map(s => s.offset).sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    medianOffset = sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Subsample border samples for performance (keep ~every 4th sample, cap at 2000)
  let samplesForIDW = borderSamples;
  if (samplesForIDW.length > 2000) {
    const step = Math.ceil(samplesForIDW.length / 2000);
    samplesForIDW = samplesForIDW.filter((_, i) => i % step === 0);
  }

  // Inverse-distance-weighted offset at a given pixel
  function idwOffset(px, py) {
    if (samplesForIDW.length === 0) return 0;
    if (samplesForIDW.length < 4) return medianOffset;

    let wSum = 0, vSum = 0;
    const searchR = BLEND_RADIUS * 2;
    const searchR2 = searchR * searchR;
    for (let i = 0; i < samplesForIDW.length; i++) {
      const s = samplesForIDW[i];
      const dx = px - s.px;
      const dy = py - s.py;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1) return s.offset;
      if (d2 > searchR2) continue;
      const w = 1 / d2; // inverse-distance-squared weighting
      wSum += w;
      vSum += w * s.offset;
    }
    return wSum > 0 ? vSum / wSum : medianOffset;
  }

  // --- Composite with spatially-varying offset-corrected blending ---
  const result = new Float32Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    const py = (i / DEM_TILE_SIZE) | 0;
    const px = i % DEM_TILE_SIZE;
    const mb = sampleMB(px, py);
    const dist = distToBorder[i];

    if (dist >= BLEND_RADIUS) {
      // Far from border — use source directly
      result[i] = coverage[i] ? ignElevations[i] : mb;
    } else {
      // In blend zone — smoothstep interpolation with offset correction
      const t = smoothstep(dist / BLEND_RADIUS); // 0 at border, 1 at full radius
      const localOffset = idwOffset(px, py);

      if (coverage[i]) {
        // IGN pixel in blend zone: fade from offset-corrected Mapbox at border → pure IGN inside
        const mbCorrected = mb + localOffset;
        result[i] = ignElevations[i] * t + mbCorrected * (1 - t);
      } else {
        // Mapbox pixel in blend zone: fade from offset-corrected Mapbox at border → raw Mapbox outside
        // CRITICAL FIX: never reference ignElevations[i] here (it's 0 = uninitialized)
        const mbCorrected = mb + localOffset * (1 - t);
        result[i] = mbCorrected;
      }
    }
  }

  return encodeTerrainRGBPng(result);
}

// ---------------------------------------------------------------------------
// Mapbox DEM passthrough (non-France)
// ---------------------------------------------------------------------------

async function fetchMapboxTile(z, x, y) {
  if (!mapboxToken) return null;
  // Request 512x512 tiles (@2x) to match our tileSize: 512 DEM source
  const url = `https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/${z}/${x}/${y}@2x.pngraw?access_token=${mapboxToken}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const blob = await res.blob();
    // Verify the tile is actually 512x512; if not, resample it
    const img = await createImageBitmap(blob);
    if (img.width === DEM_TILE_SIZE && img.height === DEM_TILE_SIZE) {
      return blob;
    }
    // Resample to DEM_TILE_SIZE x DEM_TILE_SIZE
    const canvas = new OffscreenCanvas(DEM_TILE_SIZE, DEM_TILE_SIZE);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE);
    return canvas.convertToBlob({ type: 'image/png' });
  } catch {
    return null;
  }
}

// ===========================================================================
// ORTHOPHOTO TILES — IGN ortho clipped to France border polygon
// ===========================================================================

// ---------------------------------------------------------------------------
// France polygon loading
// ---------------------------------------------------------------------------

async function ensureFrancePoly() {
  if (francePoly) return true;
  if (francePolyLoading) return francePolyLoading;
  francePolyLoading = (async () => {
    // Try static cache first (precached on install), then network
    let response;
    const staticCache = await caches.open(STATIC_CACHE_NAME);
    response = await staticCache.match('/france-border.json');
    if (!response) {
      response = await fetch('/france-border.json');
      if (response.ok) staticCache.put('/france-border.json', response.clone());
    }
    return response.json();
  })()
    .then(geo => {
      francePoly = geo.coordinates; // MultiPolygon coords
      francePolyBBoxes = francePoly.map(polygon => {
        let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
        for (const ring of polygon) {
          for (const [lng, lat] of ring) {
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
          }
        }
        return [minLng, minLat, maxLng, maxLat];
      });
      return true;
    })
    .catch(err => {
      console.error('[sw-dem] Failed to load France polygon:', err);
      francePoly = null;
      francePolyLoading = null;
      return false;
    });
  return francePolyLoading;
}

// ---------------------------------------------------------------------------
// Point-in-polygon (ray-casting)
// ---------------------------------------------------------------------------

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInFrance(lng, lat) {
  for (let p = 0; p < francePoly.length; p++) {
    const [bw, bs, be, bn] = francePolyBBoxes[p];
    if (lng < bw || lng > be || lat < bs || lat > bn) continue;
    const polygon = francePoly[p];
    if (pointInRing(lng, lat, polygon[0])) {
      let inHole = false;
      for (let h = 1; h < polygon.length; h++) {
        if (pointInRing(lng, lat, polygon[h])) { inHole = true; break; }
      }
      if (!inHole) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tile classification (inside / border / outside France polygon)
// ---------------------------------------------------------------------------

function classifyOrthoTile(z, x, y) {
  const b = mercatorTileBounds(z, x, y);

  // Sample a 3x3 grid inside the tile
  let insideCount = 0;
  const N = 3;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const lng = b.west + (b.east - b.west) * (i + 0.5) / N;
      const lat = b.south + (b.north - b.south) * (j + 0.5) / N;
      if (pointInFrance(lng, lat)) insideCount++;
    }
  }
  const total = N * N;

  if (insideCount > 0 && insideCount < total) return 'border';

  // All same — check if any polygon vertex falls inside tile bounds
  if (hasPolyVertexInTile(b)) return 'border';

  return insideCount === total ? 'inside' : 'outside';
}

function hasPolyVertexInTile(b) {
  for (let p = 0; p < francePoly.length; p++) {
    const [bw, bs, be, bn] = francePolyBBoxes[p];
    if (be < b.west || bw > b.east || bn < b.south || bs > b.north) continue;
    for (const ring of francePoly[p]) {
      for (const [lng, lat] of ring) {
        if (lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Canvas masking — clip IGN tile to France border
// ---------------------------------------------------------------------------

function lngToTilePx(lng, z, tileX, size) {
  const n = 1 << z;
  return (((lng + 180) / 360) * n - tileX) * size;
}

function latToTilePy(lat, z, tileY, size) {
  const n = 1 << z;
  const latRad = lat * Math.PI / 180;
  const mercY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return (mercY - tileY) * size;
}

async function maskOrthoTile(imgBlob, z, tileX, tileY) {
  const img = await createImageBitmap(imgBlob);
  const canvas = new OffscreenCanvas(ORTHO_TILE_SIZE, ORTHO_TILE_SIZE);
  const ctx = canvas.getContext('2d');
  const b = mercatorTileBounds(z, tileX, tileY);

  // Build clip path from France polygon parts that overlap this tile
  ctx.beginPath();
  for (let p = 0; p < francePoly.length; p++) {
    const [bw, bs, be, bn] = francePolyBBoxes[p];
    // Skip polygon parts whose bbox doesn't overlap tile (with 1° margin)
    if (be < b.west - 1 || bw > b.east + 1 || bn < b.south - 1 || bs > b.north + 1) continue;

    for (const ring of francePoly[p]) {
      let first = true;
      for (const [lng, lat] of ring) {
        const px = lngToTilePx(lng, z, tileX, ORTHO_TILE_SIZE);
        const py = latToTilePy(lat, z, tileY, ORTHO_TILE_SIZE);
        if (first) { ctx.moveTo(px, py); first = false; }
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
  }
  ctx.clip();

  // Draw IGN tile — only pixels inside France polygon remain visible
  ctx.drawImage(img, 0, 0, ORTHO_TILE_SIZE, ORTHO_TILE_SIZE);
  return canvas.convertToBlob({ type: 'image/png' });
}

// ---------------------------------------------------------------------------
// Ortho tile URL builder
// ---------------------------------------------------------------------------

function buildOrthoTileURL(z, x, y) {
  return (
    `${IGN_WMTS_BASE}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${IGN_ORTHO_LAYER}&STYLE=normal&FORMAT=image%2Fjpeg` +
    `&TILEMATRIXSET=${IGN_ORTHO_TILEMATRIXSET}` +
    `&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`
  );
}

// Lazily-created 1×1 transparent PNG
let _transparentBlob = null;
async function getTransparentBlob() {
  if (!_transparentBlob) {
    const c = new OffscreenCanvas(1, 1);
    c.getContext('2d');
    _transparentBlob = await c.convertToBlob({ type: 'image/png' });
  }
  return _transparentBlob;
}

async function transparentResponse() {
  const blob = await getTransparentBlob();
  return new Response(blob, {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });
}

// ---------------------------------------------------------------------------
// Ortho request handler
// ---------------------------------------------------------------------------

async function handleOrthoRequest(z, x, y) {
  // Check cache first
  const cache = await caches.open(ORTHO_CACHE_NAME);
  const cacheKey = new Request(`/ortho-tiles/${z}/${x}/${y}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const polyLoaded = await ensureFrancePoly();

    if (!polyLoaded) {
      // Fallback: fetch IGN tile without masking (polygon unavailable)
      const url = buildOrthoTileURL(z, x, y);
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return await transparentResponse();
      return new Response(await res.blob(), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' },
      });
    }

    // Quick rectangular bounds check
    if (!tileOverlapsFrance(z, x, y)) {
      return await transparentResponse();
    }

    const classification = classifyOrthoTile(z, x, y);

    if (classification === 'outside') {
      return await transparentResponse();
    }

    // Fetch IGN ortho tile
    const url = buildOrthoTileURL(z, x, y);
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return await transparentResponse();

    let response;
    if (classification === 'inside') {
      // Fully inside France — pass through JPEG as-is
      response = new Response(await res.blob(), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' },
      });
    } else {
      // Border tile — mask with France polygon
      const imgBlob = await res.blob();
      const maskedPng = await maskOrthoTile(imgBlob, z, x, y);
      response = new Response(maskedPng, {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' },
      });
    }

    cache.put(cacheKey, response.clone());
    return response;
  } catch (err) {
    console.error('[sw-dem] Ortho error', z, x, y, err);
    return await transparentResponse();
  }
}
