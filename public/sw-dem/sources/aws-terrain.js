// ---------------------------------------------------------------------------
// AWS Open Data — Terrarium DEM tile fetcher (drop-in for fetchMapboxTile)
//
// Endpoint: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
//
// Why: the previous commercial raster-DEM fallback was billed against the
// Raster Tiles API SKU. The AWS Open Data Terrain Tiles dataset
// (legacy Mapzen, hosted free by AWS) covers the entire globe at ~30 m
// resolution and is free / unlimited. We swap it in everywhere the SW used
// to call Mapbox for global DEM, drastically cutting the Raster Tiles bill
// without any visible quality regression at the zoom levels concerned
// (z ≤ 14 globally, z ≤ ~11 over France/Switzerland where IGN/swissALTI
// take over for the high-resolution path).
//
// Encoding conversion:
//   Terrarium  : height = (R*256 + G + B/256) − 32768
//   Terrain-RGB: height = -10000 + (R*65536 + G*256 + B) * 0.1
// We decode terrarium → Float32 → re-encode as Terrain-RGB so the rest of
// the SW pipeline (composite, slope, altitude, overzoom) stays unchanged.
// ---------------------------------------------------------------------------

// Native max zoom of AWS Terrarium tiles. Beyond this, requests 404.
// Matches Mapbox terrain-DEM v1 (z14 native), so the existing clamp logic
// in callers keeps working unchanged.
const AWS_TERRAIN_MAXZOOM = 14;

// Public, unauthenticated endpoint. No CORS issues — bucket has
// Access-Control-Allow-Origin: * configured.
const AWS_TERRAIN_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

// Network fetch concurrency limiter — prevents socket starvation when 400+ tiles burst
const AWS_FETCH_MAX_CONCURRENT = 32;
let _awsFetchActive = 0;
const _awsFetchQueue = [];

function acquireAwsFetchSlot() {
  if (_awsFetchActive < AWS_FETCH_MAX_CONCURRENT) {
    _awsFetchActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _awsFetchQueue.push(resolve));
}

function releaseAwsFetchSlot() {
  _awsFetchActive = Math.max(0, _awsFetchActive - 1);
  if (_awsFetchQueue.length > 0 && _awsFetchActive < AWS_FETCH_MAX_CONCURRENT) {
    _awsFetchActive++;
    _awsFetchQueue.shift()();
  }
}

async function fetchAWSTerrainTile(z, x, y) {
  // Clamp to native max zoom — above z14 AWS returns 404. Mapbox GL's GPU
  // handles overzooming from the parent tile.
  const fetchZ = Math.min(z, AWS_TERRAIN_MAXZOOM);
  const fetchX = fetchZ < z ? x >> (z - fetchZ) : x;
  const fetchY = fetchZ < z ? y >> (z - fetchZ) : y;
  const clamped = fetchZ < z;

  const url = `${AWS_TERRAIN_BASE}/${fetchZ}/${fetchX}/${fetchY}.png`;
  await acquireAwsFetchSlot();
  try {
    const t0 = performance.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(6000), priority: 'high' });
    const dt = (performance.now() - t0).toFixed(0);

    if (!res.ok) {
      if (DEBUG) {
        console.warn(
          `[sw-dem][aws] %c FAIL %c ${z}/${x}/${y}${clamped ? ` (clamped→${fetchZ}/${fetchX}/${fetchY})` : ''} — HTTP ${res.status}, ${dt}ms`,
          'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '',
        );
      }
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    releaseAwsFetchSlot();

    // ── Multi-Core Worker Pool Fast-Path (2026-08-29) ──────────────────────
    // Offloads decoding, Terrarium → Terrain-RGB conversion and Sub-filter
    // PNG encoding to the worker pool across all CPU cores.
    if (typeof computeAwsTerrariumViaPool === 'function') {
      try {
        const poolBlob = await computeAwsTerrariumViaPool(
          arrayBuffer.slice(0), z, x, y, fetchZ, fetchX, fetchY, clamped,
        );
        if (poolBlob) return poolBlob;
      } catch { /* fall through to in-process */ }
    }

    // ── In-Process Fallback ────────────────────────────────────────────────
    const blob = new Blob([arrayBuffer], { type: 'image/png' });
    const img = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });

    let elevations;
    try {
      const width = img.width;
      const height = img.height;
      const ctx = typeof getSharedOffscreenCtx === 'function'
        ? getSharedOffscreenCtx(width, height)
        : new OffscreenCanvas(width, height).getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, width, height).data;

      const srcSize = width;
      if (srcSize === DEM_TILE_SIZE && height === DEM_TILE_SIZE) {
        elevations = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
        for (let i = 0; i < elevations.length; i++) {
          const idx = i * 4;
          const r = pixels[idx];
          const g = pixels[idx + 1];
          const b = pixels[idx + 2];
          elevations[i] = (r * 256 + g + b / 256) - 32768;
        }
      } else {
        elevations = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
        const scale = srcSize / DEM_TILE_SIZE;
        for (let py = 0; py < DEM_TILE_SIZE; py++) {
          const sy = Math.min((py * scale) | 0, srcSize - 1);
          for (let px = 0; px < DEM_TILE_SIZE; px++) {
            const sx = Math.min((px * scale) | 0, srcSize - 1);
            const idx = (sy * srcSize + sx) * 4;
            const r = pixels[idx];
            const g = pixels[idx + 1];
            const b = pixels[idx + 2];
            elevations[py * DEM_TILE_SIZE + px] = (r * 256 + g + b / 256) - 32768;
          }
        }
      }
    } finally {
      img.close();
    }

    if (clamped && typeof overzoomDemElevations === 'function') {
      const upsampled = overzoomDemElevations(elevations, fetchZ, fetchX, fetchY, z, x, y);
      return encodeTerrainRGBPng(upsampled || elevations);
    }
    return encodeTerrainRGBPng(elevations);
  } catch (err) {
    releaseAwsFetchSlot();
    if (DEBUG) {
      console.warn(
        `[sw-dem][aws] %c ERROR %c ${z}/${x}/${y} — ${err.message || err}`,
        'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '',
      );
    }
    return null;
  }
}
