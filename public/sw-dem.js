// ---------------------------------------------------------------------------
// Service Worker — Client-side DEM + Ortho tile processor
// Intercepts /dem-tiles/{z}/{x}/{y} → Terrain-RGB PNGs (IGN MNS + Mapbox)
// Intercepts /ortho-tiles/{z}/{x}/{y} → IGN orthophotos clipped to France border
// ---------------------------------------------------------------------------

const CACHE_NAME = 'dem-tiles-v1';

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

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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

async function handleDemRequest(request, z, x, y) {
  // Check Cache API first
  const cache = await caches.open(CACHE_NAME);
  const cacheKey = new Request(`/dem-tiles/${z}/${x}/${y}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    let pngBlob;

    if (tileOverlapsFrance(z, x, y) && z >= IGN_DEM_MINZOOM) {
      pngBlob = await buildIGNTile(z, x, y);
    }

    if (!pngBlob && mapboxToken) {
      pngBlob = await fetchMapboxTile(z, x, y);
    }

    if (!pngBlob) {
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

  // Resample elevations via bicubic interpolation into 512x512 grid
  const elevations = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
  const n = 1 << mercZ;
  const matrixWidth = 1 << (demZ + 1);
  const matrixHeight = 1 << demZ;

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
        elevations[py * DEM_TILE_SIZE + px] = bicubicSample(tileData, fx, fy);
      }
    }
  }

  // Encode to Terrain-RGB PNG via OffscreenCanvas
  return encodeTerrainRGBPng(elevations);
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
// Mapbox DEM passthrough (non-France)
// ---------------------------------------------------------------------------

async function fetchMapboxTile(z, x, y) {
  if (!mapboxToken) return null;
  const url = `https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/${z}/${x}/${y}.pngraw?access_token=${mapboxToken}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return await res.blob();
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
  francePolyLoading = fetch('/france-border.json')
    .then(r => r.json())
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
