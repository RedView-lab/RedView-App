import type { Map as MapboxMap } from 'mapbox-gl';
import {
  lngLatToTile,
  screenToLngLat,
  PREFETCH_MIN_ZOOM,
  PREFETCH_MAX_ZOOM,
  PREFETCH_MAX_PER_CYCLE,
  PREFETCH_THROTTLE_MS,
  PREFETCH_POST_IDLE_DELAY_MS,
  PITCH_FOREGROUND_THRESHOLD_DEG,
  TELEPORT_TILE_DELTA,
  PREDICTIVE_LEAD_TILES,
  type PriorityHintInit,
} from './prefetch/prefetchGeometry';
import {
  buildPrefetchUrls,
  demPrefetchUrl,
  getSlopeSourceMaxZoom,
  slopePrefetchUrl,
} from './prefetch/prefetchUrls';
import type {
  ViewportPrefetchOptions,
  PrewarmDestinationOptions,
  ViewportPrefetchHandle,
} from './prefetch/types';
import { getActiveDem3dQuality } from './dem3dQualityBus';
import { getActiveDemProfilePreference } from './demProfileBus';
import { terrainDemTileZoom, unifiedDEMSource } from './sources';

export * from './prefetch/types';

let currentHandle: ViewportPrefetchHandle | null = null;

/**
 * Speculative tiles only make sense when the Service Worker answers them.
 * On an uncontrolled page (force-reload, SW not claimed yet, AWS fallback
 * terrain) every `/dem-tiles?pf=1` would reach the server instead — burning
 * the tile rate-limit bucket (429) for tiles nobody displays.
 */
function isServiceWorkerControlled(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker?.controller);
}

/**
 * DEM query of the tiles the 3D terrain reads, or null when it does not read
 * `/dem-tiles` at all: the 30 m mode streams AWS Terrarium straight to the
 * GPU, so warming `/dem-tiles` there built 0.40 m IGN tiles nobody displays.
 */
function terrainDemPrefetchQuery(): string | null {
  if (getActiveDem3dQuality() === 'fast-30m') return null;
  return getActiveDemProfilePreference() === 'terrain' ? 'rv-dem-profile=terrain' : '';
}

/** Zoom of the terrain's DEM tiles (what the terrain and the slope overlay read). */
function terrainDemPrefetchZoom(zoom: number): number {
  return Math.max(unifiedDEMSource.minzoom, Math.min(unifiedDEMSource.maxzoom, terrainDemTileZoom(zoom)));
}

interface TileBox { xMin: number; yMin: number; xMax: number; yMax: number }

/** Tiles one step beyond the box edge in the direction of travel. */
function leadTiles(box: TileBox, z: number, velocity: { dx: number; dy: number }): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const cap = (1 << z) - 1;
  const dominantX = Math.abs(velocity.dx) >= Math.abs(velocity.dy);
  const stepX = dominantX ? Math.sign(velocity.dx) : 0;
  const stepY = dominantX ? 0 : Math.sign(velocity.dy);
  if (stepX === 0 && stepY === 0) return out;
  for (let i = 1; i <= PREDICTIVE_LEAD_TILES; i++) {
    const lx0 = stepX > 0 ? box.xMax + i : (stepX < 0 ? box.xMin - i : box.xMin);
    const lx1 = stepX !== 0 ? lx0 : box.xMax;
    const ly0 = stepY > 0 ? box.yMax + i : (stepY < 0 ? box.yMin - i : box.yMin);
    const ly1 = stepY !== 0 ? ly0 : box.yMax;
    for (let lx = Math.max(0, Math.min(cap, lx0)); lx <= Math.max(0, Math.min(cap, lx1)); lx++) {
      for (let ly = Math.max(0, Math.min(cap, ly0)); ly <= Math.max(0, Math.min(cap, ly1)); ly++) {
        out.push([lx, ly]);
      }
    }
  }
  return out;
}

/** DEM and ortho share the per-cycle cap fairly. */
function interleave(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

export function getViewportPrefetch(): ViewportPrefetchHandle | null {
  return currentHandle;
}

/**
 * Installe le moteur de préchargement spéculatif de tuiles basé sur le viewport et les mouvements caméra.
 *
 * Chaque famille est préchargée au zoom où la carte la demande réellement :
 * le DEM du relief à floor(zoom − 1) (même pyramide que les pentes, voir
 * TERRAIN_ALIGNED_RASTER_TILE_SIZE), l'ortho 256 px autour de round(zoom).
 * L'anneau DEM autour du viewport est aussi ce qui complète les bords des
 * tuiles de pente (voisins manquants → reconstruites quand le DEM arrive).
 */
export function installViewportPrefetch(
  map: MapboxMap,
  opts: ViewportPrefetchOptions = {},
): ViewportPrefetchHandle {
  let lastSignature = '';
  let lastFiredAt = 0;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  let activeAbort: AbortController | null = null;
  let prewarmAbort: AbortController | null = null;
  let lastCentreTile: { x: number; y: number; z: number } | null = null;
  let lastVelocityTile: { dx: number; dy: number } | null = null;

  const dispatchBatch = (
    urls: readonly string[],
    priority: 'low' | 'high',
  ): AbortController | null => {
    if (urls.length === 0) return null;
    const controller = new AbortController();
    const init: PriorityHintInit = {
      priority,
      cache: 'force-cache',
      signal: controller.signal,
    };
    const cap = Math.min(urls.length, PREFETCH_MAX_PER_CYCLE);
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < cap; i++) {
      try {
        promises.push(fetch(urls[i], init).catch(() => undefined));
      } catch {
        /* fetch unavailable */
      }
    }
    void Promise.allSettled(promises);
    return controller;
  };

  const fire = (): void => {
    scheduled = null;
    if (disposed) return;
    if (!isServiceWorkerControlled()) return;
    if (typeof map.getStyle !== 'function' || !map.getStyle()) return;

    const zoom = map.getZoom();
    const z = Math.round(zoom);
    if (z < PREFETCH_MIN_ZOOM || z > PREFETCH_MAX_ZOOM) return;

    const bounds = map.getBounds();
    if (!bounds) return;

    const pitch = typeof map.getPitch === 'function' ? map.getPitch() : 0;
    const tilted = pitch >= PITCH_FOREGROUND_THRESHOLD_DEG;

    let anchor: { lng: number; lat: number } | null = null;
    if (tilted && typeof map.getCanvas === 'function') {
      const canvas = map.getCanvas();
      const w = canvas.clientWidth || canvas.width || 0;
      const h = canvas.clientHeight || canvas.height || 0;
      if (w > 0 && h > 0) {
        anchor = screenToLngLat(map, w * 0.5, h * 0.75);
      }
    }
    if (!anchor) {
      const c = map.getCenter();
      anchor = { lng: c.lng, lat: c.lat };
    }
    const groundAnchor = anchor;

    // Gestion spécifique des vues très couchées (pitch >= 55°)
    // En vue rasante/couchée, la boîte englobante de l'écran s'étend jusqu'à l'horizon
    // infini (xMax - xMin > 16), ce qui coupait brutalement le préchargement du sol.
    // On cadre ici un cône de qualité foreground centré sur le sol devant la caméra (±2 tuiles).
    const boxAt = (tz: number): TileBox => {
      if (pitch >= 55) {
        const ac = lngLatToTile(groundAnchor.lng, groundAnchor.lat, tz);
        const cap = (1 << tz) - 1;
        return {
          xMin: Math.max(0, ac.x - 2),
          xMax: Math.min(cap, ac.x + 2),
          yMin: Math.max(0, ac.y - 2),
          yMax: Math.min(cap, ac.y + 2),
        };
      }
      const sw = lngLatToTile(bounds.getWest(), bounds.getSouth(), tz);
      const ne = lngLatToTile(bounds.getEast(), bounds.getNorth(), tz);
      return {
        xMin: Math.min(sw.x, ne.x),
        xMax: Math.max(sw.x, ne.x),
        yMin: Math.min(sw.y, ne.y),
        yMax: Math.max(sw.y, ne.y),
      };
    };
    const box = boxAt(z);
    if (pitch < 55 && (box.xMax - box.xMin > 16 || box.yMax - box.yMin > 16)) return;

    const centreTile = lngLatToTile(anchor.lng, anchor.lat, z);
    let velocity: { dx: number; dy: number } | null = null;
    if (lastCentreTile) {
      const dxSigned = centreTile.x - lastCentreTile.x;
      const dySigned = centreTile.y - lastCentreTile.y;
      const dx = Math.abs(dxSigned);
      const dy = Math.abs(dySigned);
      const dz = Math.abs(z - lastCentreTile.z);
      if (dz >= 2 || dx + dy > TELEPORT_TILE_DELTA) {
        if (activeAbort) {
          activeAbort.abort();
          activeAbort = null;
        }
        lastVelocityTile = null;
      } else if (lastCentreTile.z === z && (dx + dy) >= 1) {
        velocity = { dx: dxSigned, dy: dySigned };
      }
    }
    if (!velocity && lastVelocityTile) velocity = lastVelocityTile;
    lastVelocityTile = velocity;
    lastCentreTile = { x: centreTile.x, y: centreTile.y, z };

    const demQuery = terrainDemPrefetchQuery();
    const sig = `${z}:${box.xMin},${box.yMin},${box.xMax},${box.yMax}:p${tilted ? 1 : 0}:a${anchor.lng.toFixed(3)},${anchor.lat.toFixed(3)}:d${demQuery ?? '-'}`;
    if (sig === lastSignature) return;
    lastSignature = sig;
    lastFiredAt = performance.now();

    const orthoOn = opts.isOrthoActive?.() ?? false;
    const orthoUrls = orthoOn
      ? buildPrefetchUrls(
          map, z, box.xMin, box.yMin, box.xMax, box.yMax, anchor, tilted,
          { demQuery: null, ortho: true, slope: false },
          /* includeRing */ true,
          /* includeChildren */ true,
          /* includeParent */ true,
        )
      : [];
    let demUrls: string[] = [];
    let demZ = 0;
    let demBox: TileBox | null = null;
    if (demQuery !== null) {
      demZ = terrainDemPrefetchZoom(zoom);
      demBox = boxAt(demZ);
      demUrls = buildPrefetchUrls(
        map, demZ, demBox.xMin, demBox.yMin, demBox.xMax, demBox.yMax, anchor, tilted,
        { demQuery, ortho: false, slope: false },
        /* includeRing */ true,
        /* includeChildren */ true,
        /* includeParent */ true,
      );
    }

    if (velocity) {
      if (demQuery !== null && demBox) {
        for (const [lx, ly] of leadTiles(demBox, demZ, velocity)) demUrls.push(demPrefetchUrl(demZ, lx, ly, demQuery));
      }
      if (orthoOn && z >= 11) {
        for (const [lx, ly] of leadTiles(box, z, velocity)) orthoUrls.push(`/ortho-tiles/${z}/${lx}/${ly}?pf=1`);
      }
    }

    const urls = interleave(demUrls, orthoUrls);
    if (urls.length === 0) return;

    if (activeAbort) activeAbort.abort();
    activeAbort = dispatchBatch(urls, 'low');
  };

  const schedule = (): void => {
    if (disposed) return;
    if (scheduled != null) return;
    const elapsed = performance.now() - lastFiredAt;
    const wait = elapsed >= PREFETCH_THROTTLE_MS
      ? PREFETCH_POST_IDLE_DELAY_MS
      : Math.max(PREFETCH_POST_IDLE_DELAY_MS, PREFETCH_THROTTLE_MS - elapsed);
    scheduled = setTimeout(fire, wait);
  };

  const prewarmDestination = (
    lng: number,
    lat: number,
    zoom: number,
    prewarmOpts: PrewarmDestinationOptions = {},
  ): void => {
    if (disposed) return;
    if (!isServiceWorkerControlled()) return;
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || !Number.isFinite(zoom)) return;

    const z = Math.max(PREFETCH_MIN_ZOOM, Math.min(PREFETCH_MAX_ZOOM, Math.round(zoom)));
    const radius = Math.max(0, Math.min(3, prewarmOpts.radius ?? 1));
    const orthoOn = prewarmOpts.withOrtho ?? (opts.isOrthoActive?.() ?? false);
    const slopeOn = opts.isSlopeActive?.() ?? false;
    const includeChildren = prewarmOpts.includeChildren ?? true;
    const demQuery = terrainDemPrefetchQuery();
    const demZ = terrainDemPrefetchZoom(zoom);
    const anchor = { lng, lat };

    const squareAround = (tz: number) => {
      const c = lngLatToTile(lng, lat, tz);
      const cap = (1 << tz) - 1;
      return {
        xMin: Math.max(0, c.x - radius),
        xMax: Math.min(cap, c.x + radius),
        yMin: Math.max(0, c.y - radius),
        yMax: Math.min(cap, c.y + radius),
      };
    };

    const urls: string[] = [];
    // Slope tiles are the terrain's DEM tiles (same pyramid), capped at the
    // slope source's native maxzoom.
    if (demQuery !== null || slopeOn) {
      const slopeZ = Math.min(demZ, getSlopeSourceMaxZoom(map));
      const demSquare = squareAround(demZ);
      for (let x = demSquare.xMin; x <= demSquare.xMax; x++) {
        for (let y = demSquare.yMin; y <= demSquare.yMax; y++) {
          if (demQuery !== null) urls.push(demPrefetchUrl(demZ, x, y, demQuery));
        }
      }
      if (slopeOn) {
        const slopeSquare = squareAround(slopeZ);
        for (let x = slopeSquare.xMin; x <= slopeSquare.xMax; x++) {
          for (let y = slopeSquare.yMin; y <= slopeSquare.yMax; y++) {
            urls.push(slopePrefetchUrl(map, slopeZ, x, y));
          }
        }
      }
      if (demQuery !== null) {
        urls.push(...buildPrefetchUrls(
          map, demZ, demSquare.xMin, demSquare.yMin, demSquare.xMax, demSquare.yMax, anchor,
          /* tilted */ false,
          { demQuery, ortho: false, slope: false },
          /* includeRing */ false,
          includeChildren,
          /* includeParent */ true,
        ));
      }
    }
    if (orthoOn && z >= 11) {
      const orthoSquare = squareAround(z);
      for (let x = orthoSquare.xMin; x <= orthoSquare.xMax; x++) {
        for (let y = orthoSquare.yMin; y <= orthoSquare.yMax; y++) {
          urls.push(`/ortho-tiles/${z}/${x}/${y}?pf=1`);
        }
      }
      urls.push(...buildPrefetchUrls(
        map, z, orthoSquare.xMin, orthoSquare.yMin, orthoSquare.xMax, orthoSquare.yMax, anchor,
        /* tilted */ false,
        { demQuery: null, ortho: true, slope: false },
        /* includeRing */ false,
        includeChildren,
        /* includeParent */ true,
      ));
    }

    if (urls.length === 0) return;

    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    lastSignature = '';
    lastFiredAt = 0;
    const c = lngLatToTile(lng, lat, z);
    lastCentreTile = { x: c.x, y: c.y, z };
    lastVelocityTile = null;

    prewarmAbort = dispatchBatch(urls, 'high');
  };

  let lastIdleAt = performance.now();
  let pendingMoveendFallback: ReturnType<typeof setTimeout> | null = null;
  const MOVEEND_FALLBACK_DELAY_MS = 1800;
  const IDLE_RECENCY_MS = 1500;

  const onIdle = (): void => {
    lastIdleAt = performance.now();
    if (pendingMoveendFallback != null) {
      clearTimeout(pendingMoveendFallback);
      pendingMoveendFallback = null;
    }
    schedule();
  };
  map.on('idle', onIdle);

  const onMoveEnd = (): void => {
    if (disposed) return;
    if (pendingMoveendFallback != null) clearTimeout(pendingMoveendFallback);
    pendingMoveendFallback = setTimeout(() => {
      pendingMoveendFallback = null;
      if (disposed) return;
      if (performance.now() - lastIdleAt < IDLE_RECENCY_MS) return;
      schedule();
    }, MOVEEND_FALLBACK_DELAY_MS);
  };
  map.on('moveend', onMoveEnd);

  const onStyleLoad = (): void => {
    if (disposed) return;
    if (scheduled != null) return;
    scheduled = setTimeout(fire, 80);
  };
  map.on('style.load', onStyleLoad);

  // A user gesture aborts speculative fetches and the speculative IGN /
  // ortho network work. The terrain tiles' own LiDAR work is NOT cancelled:
  // after a rotation or a pitch the map still needs nearly all of them, and
  // killing it left them on 30 m relief — the SW drops it per tile once the
  // map stops waiting on it (controller/demWantedTiles.ts). Slope and
  // altitude tiles are NOT cancelled either: they read the terrain's own DEM
  // tiles, and a cancelled request answered a transparent tile that Mapbox
  // kept as final (holes after every pan).
  const cancelOnUserGesture = (e: unknown): void => {
    const evt = e as { originalEvent?: unknown } | null | undefined;
    if (!evt || !evt.originalEvent) return;
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    if (prewarmAbort) {
      prewarmAbort.abort();
      prewarmAbort = null;
    }
    lastSignature = '';
    lastVelocityTile = null;
    if (scheduled != null) {
      clearTimeout(scheduled);
      scheduled = null;
    }
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
    if (sw && sw.controller) {
      try { sw.controller.postMessage({ type: 'CANCEL_STALE_DEM' }); }
      catch { /* SW gone away */ }
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  map.on('movestart', cancelOnUserGesture as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  map.on('zoomstart', cancelOnUserGesture as any);

  const handle: ViewportPrefetchHandle = {
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      if (scheduled != null) {
        clearTimeout(scheduled);
        scheduled = null;
      }
      if (pendingMoveendFallback != null) {
        clearTimeout(pendingMoveendFallback);
        pendingMoveendFallback = null;
      }
      if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
      }
      if (prewarmAbort) {
        prewarmAbort.abort();
        prewarmAbort = null;
      }
      map.off('idle', onIdle);
      map.off('moveend', onMoveEnd);
      map.off('style.load', onStyleLoad);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map.off('movestart', cancelOnUserGesture as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map.off('zoomstart', cancelOnUserGesture as any);
      if (currentHandle === handle) currentHandle = null;
    },
    trigger: schedule,
    prewarmDestination,
  };

  if (currentHandle) {
    try { currentHandle.dispose(); } catch { /* ignore */ }
  }
  currentHandle = handle;
  return handle;
}
