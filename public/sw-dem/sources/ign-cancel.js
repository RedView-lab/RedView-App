// ---------------------------------------------------------------------------
// IGN cancellation — gesture-start aborts of speculative fetches, per-purpose
// flush/abort, and DEM tiles the map still waits on (DEM_WANTED_TILES).
// ---------------------------------------------------------------------------

// Abort the in-flight speculative IGN fetches on a gesture start. Basemap
// fetches (no purpose) keep running for the same reason flushIGNQueue()
// keeps their queue entries; analysis-zone requests are user-initiated.
function cancelInFlightIGN() {
  if (ignActiveControllers.size === 0) return 0;
  let n = 0;
  for (const c of Array.from(ignActiveControllers)) {
    if (!c._purpose || c._purpose === PURPOSE_SLOPE_ZONE) continue;
    try { c.abort(USER_CANCEL_REASON); n++; } catch { /* ignore */ }
    ignActiveControllers.delete(c);
  }
  if (DEBUG) console.warn(`[sw-dem][queue] aborted ${n} in-flight IGN fetches on viewport change`);
  return n;
}

// ── DEM tiles the map is still waiting on ─────────────────────────────
// Chromium does not propagate a page-side fetch abort to the service worker
// (FetchEvent.request.signal never fires — checked on Edge 154), so the SW
// cannot see Mapbox dropping a DEM tile that left the view. The page posts
// instead the tiles its DEM source still has in flight (DEM_WANTED_TILES,
// `features/map3d/hooks/useMap/controller/demWantedTiles.ts`): work tagged
// with a map tile outside that list is stale and gets dropped, everything
// else runs to completion whatever the camera does.
//
// `sentAt` (Date.now() on the page, same clock as the SW) guards the race
// with requests issued after the snapshot: only work requested before it
// can be judged by it.
let mapWantedDemTiles = null; // { keys: Set<'z/x/y'>, sentAt }

function isMapDemTileWanted(mapTile) {
  if (!mapTile || !mapWantedDemTiles) return true;
  if (mapTile.requestedAt >= mapWantedDemTiles.sentAt) return true;
  return mapWantedDemTiles.keys.has(mapTile.key);
}

// Records the snapshot and drops the stale basemap work it reveals: queued
// entries resolve PRUNED_SENTINEL, in-flight fetches abort with
// USER_CANCEL_REASON (no negative caching). Returns the tile keys dropped.
function pruneUnwantedMapDemWork(keys, sentAt) {
  if (mapWantedDemTiles && sentAt <= mapWantedDemTiles.sentAt) return [];
  mapWantedDemTiles = { keys, sentAt };
  const dropped = new Set();
  const queues = [ignForegroundQueue, ignSlopeVisibleQueue, ignBackgroundQueue];
  for (const queue of queues) {
    for (let i = queue.length - 1; i >= 0; i--) {
      const entry = queue[i];
      if (!entry.mapTile || isMapDemTileWanted(entry.mapTile)) continue;
      queue.splice(i, 1);
      entry.resolve(PRUNED_SENTINEL);
      dropped.add(entry.mapTile.key);
    }
  }
  for (const c of Array.from(ignActiveControllers)) {
    if (!c._mapTile || isMapDemTileWanted(c._mapTile)) continue;
    try { c.abort(USER_CANCEL_REASON); } catch { /* ignore */ }
    ignActiveControllers.delete(c);
    dropped.add(c._mapTile.key);
  }
  if (dropped.size > 0) {
    ignPrunedTotal += dropped.size;
    drainIGN();
    if (DEBUG) console.warn(`[sw-dem][queue] dropped work of ${dropped.size} DEM tiles the map no longer waits on`);
  }
  return Array.from(dropped);
}

// Drain queued (not-yet-running) IGN entries that match a purpose tag.
// Returns the count of pruned entries. Safe to call concurrently with
// drainIGN — pruned items resolve with PRUNED_SENTINEL so their callers
// see a normal `null` return.
function flushIGNQueueByPurpose(purpose) {
  if (!purpose || totalIGNQueueLength() === 0) return 0;
  // Route to the queue that owns this purpose tag now that slope-visible
  // lives in its own queue separate from basemap (May 20 tri-tier rewrite).
  let targetQueue;
  if (isIGNBackgroundPurpose(purpose)) targetQueue = ignBackgroundQueue;
  else if (isIGNSlopeVisiblePurpose(purpose)) targetQueue = ignSlopeVisibleQueue;
  else targetQueue = ignForegroundQueue;
  if (targetQueue.length === 0) return 0;
  let pruned = 0;
  for (let i = targetQueue.length - 1; i >= 0; i--) {
    if (targetQueue[i].purpose === purpose) {
      const stale = targetQueue.splice(i, 1)[0];
      stale.resolve(PRUNED_SENTINEL);
      pruned++;
    }
  }
  if (pruned > 0) ignPrunedTotal += pruned;
  return pruned;
}

// Abort only IGN HTTP fetches tagged with `purpose`. Used by
// CANCEL_SLOPE_WORK to free terrain-WMS concurrency slots immediately
// when the user disables 1 m slope, instead of waiting up to
// IGN_FETCH_TIMEOUT_MS for each in-flight slot to drain naturally
// (visible as a multi-second stall on subsequent satellite/DEM tile
// loads). The basemap pipeline is unaffected because it uses the
// default DEM profile, which never sets a purpose tag.
function cancelInFlightIGNByPurpose(purpose) {
  const bucket = ignActiveControllersByPurpose.get(purpose);
  if (!bucket || bucket.size === 0) return 0;
  let n = 0;
  for (const c of bucket) {
    try { c.abort(USER_CANCEL_REASON); n++; } catch { /* ignore */ }
    ignActiveControllers.delete(c);
  }
  bucket.clear();
  if (DEBUG && n > 0) console.warn(`[sw-dem][cancel-slope] aborted ${n} in-flight IGN ${purpose} fetches`);
  return n;
}
