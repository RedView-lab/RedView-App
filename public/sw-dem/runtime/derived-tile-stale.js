// ---------------------------------------------------------------------------
// Provisional derived tiles (slope, altitude) → page-side source reload
//
// Mapbox treats any 200 image as final: an overlay tile answered while its
// DEM was not there yet (stand-in, parent fallback, transparent placeholder)
// stays on screen until the tile leaves the viewport. The SW cannot push a
// tile, so it tells the page, which reloads that overlay's source once the
// map settles (listeners.ts); complete tiles come straight back from the hot
// tier, the stale ones are rebuilt.
//
// Two triggers per tracker:
//   - waitOnDem(): the tile is rebuilt when the DEM tiles it lacks become
//     final — the terrain reaching them, the prefetch ring, a background
//     upgrade. finalize() / the upgrade scheduler call
//     notifyDerivedDemTileReady(). Never capped: each DEM tile lands once.
//   - noteStale(): a blind retry (nothing specific to wait for), capped per
//     tile so a tile that cannot improve does not keep the reload loop alive.
// ---------------------------------------------------------------------------

const DERIVED_STALE_NOTIFY_DEBOUNCE_MS = 700;
const DERIVED_STALE_NOTIFY_MAX_WAIT_MS = 3000;
const DERIVED_STALE_MAX_RETRIES = 3;
const DERIVED_STALE_RETRY_MAX_KEYS = 4096;
const DERIVED_DEM_WAITERS_MAX = 4096;

const DERIVED_TILE_STALE_TRACKERS = [];

function derivedDemWaitKey(demProfile, z, x, y) {
  return `${demProfile || 'default'}:${z}/${x}/${y}`;
}

// `messageType` is the postMessage type the page listens to
// (SLOPE_TILES_STALE, ALTITUDE_TILES_STALE).
function createDerivedTileStaleTracker(messageType) {
  const retries = new Map(); // tile key → reloads already asked
  const demWaiters = new Map(); // DEM wait key → Set<tile key>
  let timer = null;
  let firstAt = 0;
  let count = 0;

  function flush() {
    timer = null;
    firstAt = 0;
    const n = count;
    count = 0;
    if (n === 0) return;
    try {
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => client.postMessage({ type: messageType, count: n }));
      }).catch(() => {});
    } catch { /* ignore */ }
  }

  function noteStale(tileKey, { capped = true } = {}) {
    if (capped) {
      const n = retries.get(tileKey) || 0;
      if (n >= DERIVED_STALE_MAX_RETRIES) return;
      retries.delete(tileKey);
      retries.set(tileKey, n + 1);
      if (retries.size > DERIVED_STALE_RETRY_MAX_KEYS) {
        retries.delete(retries.keys().next().value);
      }
    }
    count++;
    const now = Date.now();
    if (!firstAt) firstAt = now;
    if (timer) clearTimeout(timer);
    const wait = Math.min(
      DERIVED_STALE_NOTIFY_DEBOUNCE_MS,
      Math.max(0, firstAt + DERIVED_STALE_NOTIFY_MAX_WAIT_MS - now),
    );
    timer = setTimeout(flush, wait);
  }

  function noteFinal(tileKey) {
    retries.delete(tileKey);
  }

  function waitOnDem(tileKey, demProfile, z, tiles) {
    for (const [tx, ty] of tiles) {
      const key = derivedDemWaitKey(demProfile, z, tx, ty);
      let waiting = demWaiters.get(key);
      if (!waiting) {
        if (demWaiters.size >= DERIVED_DEM_WAITERS_MAX) {
          demWaiters.delete(demWaiters.keys().next().value);
        }
        waiting = new Set();
        demWaiters.set(key, waiting);
      }
      waiting.add(tileKey);
    }
  }

  function demTileReady(z, x, y, demProfile) {
    if (demWaiters.size === 0) return;
    const key = derivedDemWaitKey(demProfile, z, x, y);
    const waiting = demWaiters.get(key);
    if (!waiting) return;
    demWaiters.delete(key);
    for (const tileKey of waiting) noteStale(tileKey, { capped: false });
  }

  const tracker = { noteStale, noteFinal, waitOnDem, demTileReady };
  DERIVED_TILE_STALE_TRACKERS.push(tracker);
  return tracker;
}

// Called for every DEM tile committed as final (finalize, background upgrade).
function notifyDerivedDemTileReady(z, x, y, demProfile) {
  for (const tracker of DERIVED_TILE_STALE_TRACKERS) {
    tracker.demTileReady(z, x, y, demProfile);
  }
}
