// ---------------------------------------------------------------------------
// Slope build WORKER — one instance per logical core (managed by the SW via
// runtime/slope-pool.js). Receives pre-decoded own + neighbour elevations,
// runs the pure Horn + sqrt-gamma encode pipeline OFF the SW thread, and
// returns a transferable PNG ArrayBuffer.
//
// Why a dedicated Worker (not a SharedWorker / SharedArrayBuffer):
//   * Dedicated Workers can be spawned FROM a Service Worker.
//   * No COOP/COEP headers needed — we use transferable ArrayBuffers
//     (zero-copy) instead of SAB, so vercel.json's header set stays as-is.
//   * Each worker has its own JS heap + JIT — V8 can SIMD-optimise the
//     inner Horn loop independently of the SW's compile unit.
//
// Message protocol:
//   in : { id, z, x, y, resFactor, ownElev: ArrayBuffer, neighbours: {
//            north?: ArrayBuffer, east?: ArrayBuffer,
//            south?: ArrayBuffer, west?: ArrayBuffer } }
//   out: { id, ok: true, png: ArrayBuffer, missingDirections: string[] }
//        | { id, ok: false, error: string }
//
// Elevation arrays are TRANSFERRED (postMessage with transfer list), so the
// SW no longer holds them after posting — the SW side MUST clone anything
// it still needs before transfer. The PNG arrayBuffer is likewise returned
// transferable (zero-copy back into the SW).
//
// Each worker is stateless between jobs: nothing is cached, no neighbour
// DEM LRU lives here. Caching stays in the SW so a single tile never
// computes twice and the memory budget is centralised.
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

// Reconstruct typed-array views over the transferred buffers. The buffers
// arrive detached on the SW side (good — zero copy), but the worker
// receives them as live ArrayBuffers and we just wrap them. NO copy.
function wrapFloat32(buf) {
  if (!buf || !buf.byteLength) return null;
  return new Float32Array(buf);
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  const id = msg.id;

  try {
    const ownElev = wrapFloat32(msg.ownElev);
    if (!ownElev) {
      self.postMessage({ id, ok: false, error: 'missing-own-elev' });
      return;
    }
    const neighbours = {};
    if (msg.neighbours) {
      neighbours.north = wrapFloat32(msg.neighbours.north);
      neighbours.east  = wrapFloat32(msg.neighbours.east);
      neighbours.south = wrapFloat32(msg.neighbours.south);
      neighbours.west  = wrapFloat32(msg.neighbours.west);
    }

    const resFactor = Number(msg.resFactor) > 1 ? Number(msg.resFactor) : 1;
    const result = await buildSlopeRgbaFromElevations(
      ownElev, neighbours, msg.z, msg.x, msg.y, resFactor,
    );

    // Transfer the PNG buffer back — zero copy.
    self.postMessage(
      { id, ok: true, png: result.pngArrayBuffer, missingDirections: result.missingDirections },
      [result.pngArrayBuffer],
    );
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
