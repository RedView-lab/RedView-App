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
const WORKER_DEM_LRU_MAX = 32;
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
      ownElev, neighbours, msg.z, msg.x, msg.y, resFactor,
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

