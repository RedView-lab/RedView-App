import type { Map as MapboxMap } from 'mapbox-gl';
import { unifiedDEMSource } from '../../../lib/sources';

/**
 * Tells the DEM service worker which terrain tiles the map still waits on.
 *
 * Chromium never propagates a page-side fetch abort to the service worker
 * (FetchEvent.request.signal stays silent), so when Mapbox drops a DEM tile
 * that left the view the SW cannot know its LiDAR work became useless. It
 * used to guess — every camera gesture aborted all the IGN work — and killed
 * the work of the tiles still on screen: rotating or pitching the camera
 * turned them into 30 m relief, cached that way. The page posts instead the
 * tiles its terrain source has in flight, throttled while the camera moves;
 * the SW drops the work of the other ones only (DEM_WANTED_TILES in
 * public/sw-dem/runtime/lifecycle.js). Only requests tagged `rv-src=map`
 * (buildDemTilesTemplate) are judged by these snapshots.
 */

const SYNC_INTERVAL_MS = 250;
// Mapbox drops tiles from the cover in the render that follows the camera
// change, not in the `moveend` handler itself.
const MOVE_END_DELAY_MS = 120;
const PENDING_TILE_STATES: ReadonlySet<string> = new Set(['loading', 'reloading', 'expired']);

interface DemTileLike {
  state?: string;
  tileID?: { canonical?: { z: number; x: number; y: number } };
}

interface StyleWithSourceCaches {
  getOwnSourceCache?: (id: string) => { _tiles?: Record<string, DemTileLike | undefined> } | undefined;
}

function readPendingDemTileKeys(map: MapboxMap): string[] | null {
  const style = (map as unknown as { style?: StyleWithSourceCaches }).style;
  const tiles = style?.getOwnSourceCache?.(unifiedDEMSource.id)?._tiles;
  if (!tiles) return null;
  const keys = new Set<string>();
  for (const tile of Object.values(tiles)) {
    const canonical = tile?.tileID?.canonical;
    if (!canonical || !tile?.state || !PENDING_TILE_STATES.has(tile.state)) continue;
    keys.add(`${canonical.z}/${canonical.x}/${canonical.y}`);
  }
  return [...keys];
}

export function installDemWantedTilesSync(map: MapboxMap): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPostAt = 0;

  const post = (): void => {
    timer = null;
    const controller = navigator.serviceWorker?.controller;
    if (!controller) return;
    let keys: string[] | null = null;
    try { keys = readPendingDemTileKeys(map); } catch { keys = null; }
    // No terrain source (fast 30 m mode, style swap): nothing to judge.
    if (!keys) return;
    lastPostAt = Date.now();
    try {
      controller.postMessage({ type: 'DEM_WANTED_TILES', keys, sentAt: lastPostAt });
    } catch { /* SW gone away */ }
  };

  const schedule = (delayMs: number): void => {
    if (timer != null) return;
    timer = setTimeout(post, delayMs);
  };

  const onMove = (): void => {
    schedule(Math.max(0, SYNC_INTERVAL_MS - (Date.now() - lastPostAt)));
  };

  const onMoveEnd = (): void => {
    if (timer != null) clearTimeout(timer);
    timer = null;
    schedule(MOVE_END_DELAY_MS);
  };

  map.on('move', onMove);
  map.on('moveend', onMoveEnd);

  return () => {
    map.off('move', onMove);
    map.off('moveend', onMoveEnd);
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
}
