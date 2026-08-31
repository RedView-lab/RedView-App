// ---------------------------------------------------------------------------
// Slope build WORKER — one instance per logical core (managed by the SW via
// runtime/slope-pool.js). Receives RAW DEM BLOBS (own + up to 4 cardinal
// neighbours), decodes them, runs the Horn + sqrt-gamma encode pipeline
// OFF the SW thread, and returns a transferable PNG ArrayBuffer.
//
// Why a dedicated Worker (not a SharedWorker / SharedArrayBuffer):
//   * Dedicated Workers can be spawned FROM a Service Worker.
//   * No COOP/COEP headers needed — we use transferable ArrayBuffers
//     (zero copy) instead of SAB, so vercel.json's header set stays as-is.
//   * Each worker has its own JS heap + JIT — V8 can SIMD-optimise the
//     inner Horn loop independently of the SW's compile unit.
//
// Message protocol:
//   in : { id, z, x, y, resFactor,
//          ownDem: ArrayBuffer,            // raw Terrain-RGB PNG bytes
//          neighbours: {
//            north?: ArrayBuffer,
//            east?:  ArrayBuffer,
//            south?: ArrayBuffer,
//            west?:  ArrayBuffer } }
//   out: { id, ok: true, png: ArrayBuffer, missingDirections: string[] }
//        | { id, ok: false, error: string }
//
// All DEM buffers are TRANSFERRED (zero copy) — the SW loses ownership on
// post. The worker decodes them via decodeTerrainRGBBlob (the same path
// the SW used), so the heavy createImageBitmap + getImageData + Float32
// loop runs OFF the SW thread. This was the biggest residual bottleneck:
// on a 90-tile viewport the SW was doing ~450 decodes (90 own + 4
// neighbours each) of 8-20 ms = 3-9 s of CPU that blocked the basemap
// pipeline. Moving it into the workers means the SW only pays the
// CacheStorage match (5-25 ms) per tile + the transfer.
//
// Each worker keeps a small LRU of decoded elevations keyed by tile coord
// so a neighbour blob decoded by worker N for tile A is reused when tile B
// (adjacent) sends the same blob.
// ---------------------------------------------------------------------------

// Match the SW's epoch-busting convention so cache purges on epoch bump
// also flush the worker's submodule cache. The epoch arrives as a query
// param on the worker's own URL (set by slope-pool.js > slopePoolWorkerURL).
const _workerEpoch =
  new URL(self.location.href).searchParams.get('rv-map-cache-epoch') || 'base';
const _withEpoch = (p) => `${p}?rv-map-cache-epoch=${encodeURIComponent(_workerEpoch)}`;

importScripts(
  _withEpoch('../../sw-dem/core/config.js'),
  _withEpoch('../../sw-dem/core/geo.js'),
  _withEpoch('../../sw-dem/core/interpolation.js'),
  _withEpoch('../../sw-dem/core/terrain-rgb.js'),
  _withEpoch('../../sw-dem/processing/altitude.js'),
  _withEpoch('../../sw-dem/workers/slope-math.js'),
);

// ── Worker-local decoded-DEM LRU ──────────────────────────────────────
// A worker processes tiles round-robin from the SW, so adjacent tiles
// (which share neighbour DEMs) often land on DIFFERENT workers. A
// per-worker LRU therefore has limited cross-tile hit rate, BUT it still
// catches the common case where the SAME blob is decoded twice within one
// worker's queue (e.g. when the SW re-sends a neighbour that was evicted
// from the SW-side LRU but is still in flight here). Small budget —
// workers have tighter memory than the SW.
const WORKER_DEM_LRU_MAX = 128;
const _workerDemLru = new Map(); // key "z/x/y" → Float32Array

function workerDemGet(key) {
  if (!_workerDemLru.has(key)) return null;
  const v = _workerDemLru.get(key);
  _workerDemLru.delete(key);
  _workerDemLru.set(key, v);
  return v;
}
function workerDemPut(key, elev) {
  if (!elev) return elev;
  if (_workerDemLru.has(key)) _workerDemLru.delete(key);
  _workerDemLru.set(key, elev);
  while (_workerDemLru.size > WORKER_DEM_LRU_MAX) {
    const k = _workerDemLru.keys().next().value;
    if (k === undefined) break;
    _workerDemLru.delete(k);
  }
  return elev;
}

async function workerDecodeDem(buf, z, x, y) {
  const key = `${z}/${x}/${y}`;
  const cached = workerDemGet(key);
  if (cached) return cached;
  // Wrap the transferred ArrayBuffer in a Blob for decodeTerrainRGBBlob.
  // (decodeTerrainRGBBlob is memoised by Blob identity via WeakMap, but we
  // also keep our own coord-keyed LRU for cross-job reuse.)
  const blob = new Blob([buf], { type: 'image/png' });
  const elev = await decodeTerrainRGBBlob(blob);
  return workerDemPut(key, elev);
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  const id = msg.id;

  // ── Altitude build branch (2026-06-29 altitude-decode-in-worker) ──────────
  // Altitude only needs its OWN DEM decoded (no seam-padding neighbours like
  // slope), then the altitude RGBA encode + PNG wrap. Reuses the same worker
  // + per-worker DEM LRU as slope, so when both overlays are active on the
  // same tile the second one hits the decoded-elevation cache (cross-overlay
  // hit). Returns a TRANSFERABLE PNG ArrayBuffer — zero copy back to the SW.
  if (msg.kind === 'altitude') {
    try {
      if (!msg.ownDem || !msg.ownDem.byteLength) {
        self.postMessage({ id, ok: false, error: 'missing-own-dem' });
        return;
      }
      const elevations = await workerDecodeDem(msg.ownDem, msg.z, msg.x, msg.y);
      if (!elevations) {
        self.postMessage({ id, ok: false, error: 'own-dem-decode-failed' });
        return;
      }

      const size = DEM_TILE_SIZE;
      const rgba = buildAltitudeRgba(elevations);
      // Analysis-zone mask — rasterizeRingMask/applyRingMaskToRgba come from
      // slope-math.js (importScripts above), keeping pool and in-process
      // outputs byte-identical.
      if (msg.zoneRing) {
        const zoneMask = rasterizeRingMask(msg.zoneRing, msg.z, msg.x, msg.y, size);
        if (zoneMask) applyRingMaskToRgba(rgba, zoneMask);
      }
      const pngBlob = (typeof buildRawPngSlope === 'function')
        ? await buildRawPngSlope(size, size, rgba)
        : await buildRawPng(size, size, rgba);
      const pngBuf = await pngBlob.arrayBuffer();

      // Transfer the PNG buffer back — zero copy.
      self.postMessage({ id, ok: true, png: pngBuf }, [pngBuf]);
    } catch (err) {
      self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
    }
    return;
  }

  // ── AWS Terrarium → Terrain-RGB multi-core branch (2026-08-29) ─────────
  // Decodes raw Terrarium PNG, converts to Terrain-RGB RGBA in a tight typed
  // array loop, and encodes PNG with fast Sub-filter off the main SW thread.
  if (msg.kind === 'aws-terrarium') {
    try {
      if (!msg.terrariumBuf || !msg.terrariumBuf.byteLength) {
        self.postMessage({ id, ok: false, error: 'missing-terrarium-buf' });
        return;
      }
      const blob = new Blob([msg.terrariumBuf], { type: 'image/png' });
      const img = await createImageBitmap(blob, {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      const width = img.width;
      const height = img.height;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      img.close();
      const imgData = ctx.getImageData(0, 0, width, height);
      const srcPixels = imgData.data;
      const len = width * height;

      let outRgba;
      if (msg.clamped && typeof overzoomDemElevations === 'function') {
        const elevations = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          const idx = i * 4;
          elevations[i] = (srcPixels[idx] * 256 + srcPixels[idx + 1] + srcPixels[idx + 2] / 256) - 32768;
        }
        const upsampled = overzoomDemElevations(elevations, msg.fetchZ, msg.fetchX, msg.fetchY, msg.z, msg.x, msg.y);
        const targetElev = upsampled || elevations;
        outRgba = new Uint8Array(DEM_TILE_SIZE * DEM_TILE_SIZE * 4);
        for (let i = 0; i < targetElev.length; i++) {
          const height = sanitizeElevation(targetElev[i]);
          const val = Math.max(0, Math.min(16777215, Math.round((height + 10000) * 10)));
          const idx = i * 4;
          outRgba[idx]     = (val >> 16) & 0xff;
          outRgba[idx + 1] = (val >>  8) & 0xff;
          outRgba[idx + 2] =  val        & 0xff;
          outRgba[idx + 3] = 255;
        }
      } else {
        outRgba = new Uint8Array(len * 4);
        for (let i = 0; i < len; i++) {
          const idx = i * 4;
          const r = srcPixels[idx];
          const g = srcPixels[idx + 1];
          const b = srcPixels[idx + 2];
          // Terrarium: H = R*256 + G + B/256 - 32768
          // Terrain-RGB: val = (H + 10000) * 10 = (R*256 + G + B*0.00390625 - 22768) * 10
          const raw = (r * 256 + g + b * 0.00390625 - 22768) * 10;
          const val = raw > 0 ? (raw > 16777215 ? 16777215 : (raw + 0.5) | 0) : 0;
          outRgba[idx]     = (val >> 16) & 0xff;
          outRgba[idx + 1] = (val >>  8) & 0xff;
          outRgba[idx + 2] =  val        & 0xff;
          outRgba[idx + 3] = 255;
        }
      }

      const pngBlob = (typeof buildRawPngSlope === 'function')
        ? await buildRawPngSlope(width, height, outRgba)
        : await buildRawPng(width, height, outRgba);
      const pngBuf = await pngBlob.arrayBuffer();

      self.postMessage({ id, ok: true, png: pngBuf }, [pngBuf]);
    } catch (err) {
      self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
    }
    return;
  }

  try {
    // Decode the own DEM blob in-worker.
    if (!msg.ownDem || !msg.ownDem.byteLength) {
      self.postMessage({ id, ok: false, error: 'missing-own-dem' });
      return;
    }
    const ownElev = await workerDecodeDem(msg.ownDem, msg.z, msg.x, msg.y);
    if (!ownElev) {
      self.postMessage({ id, ok: false, error: 'own-dem-decode-failed' });
      return;
    }

    // Decode each neighbour DEM blob in-worker (where present).
    const neighbours = {};
    const missingDirections = [];
    if (msg.neighbours) {
      const dirs = [
        ['north', msg.z, msg.x, msg.y - 1],
        ['east',  msg.z, msg.x + 1, msg.y],
        ['south', msg.z, msg.x, msg.y + 1],
        ['west',  msg.z, msg.x - 1, msg.y],
      ];
      // Decode in parallel — they're independent and each does its own
      // createImageBitmap which is itself async/I/O bound.
      await Promise.all(dirs.map(async ([dir, nz, nx, ny]) => {
        const buf = msg.neighbours[dir];
        if (!buf || !buf.byteLength) { missingDirections.push(dir); return; }
        try {
          const elev = await workerDecodeDem(buf, nz, nx, ny);
          if (elev) neighbours[dir] = elev;
          else missingDirections.push(dir);
        } catch {
          missingDirections.push(dir);
        }
      }));
    }

    const resFactor = Number(msg.resFactor) > 1 ? Number(msg.resFactor) : 1;
    const result = await buildSlopeRgbaFromElevations(
      ownElev, neighbours, msg.z, msg.x, msg.y, resFactor, msg.zoneRing || null,
    );

    // Merge any worker-side missing directions into the result.
    for (const d of missingDirections) {
      if (!result.missingDirections.includes(d)) result.missingDirections.push(d);
    }

    // Transfer the PNG buffer back — zero copy.
    self.postMessage(
      { id, ok: true, png: result.pngArrayBuffer, missingDirections: result.missingDirections },
      [result.pngArrayBuffer],
    );
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};

