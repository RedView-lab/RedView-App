import type { Map as MapboxMap } from 'mapbox-gl';

/**
 * Altitude overlay tiles read straight from the DEM tiles the 3D terrain has
 * already decoded — no second download, no Service Worker round trip.
 *
 * The overlay used to be a plain raster source on the terrain's own tile URLs.
 * Same bytes, fetched twice: its requests queued behind the terrain's (and the
 * satellite / VHR tiles) in Mapbox's shared image queue and on the same
 * connections, so after a camera move the colours landed 1–2 s after the
 * relief. A custom source is called directly by the tile pipeline: each tile
 * is the terrain DEM tile of the same z/x/y (TERRAIN_ALIGNED_RASTER_TILE_SIZE
 * makes the two pyramids identical), re-encoded to Terrain-RGB in memory
 * (~1 ms) and coloured on the GPU by the layer's raster-color.
 *
 * While the terrain still loads a tile, `loadTile` waits for it — Mapbox shows
 * the parent altitude tile meanwhile, exactly like the parent mesh of the
 * relief. A tile the terrain never asks for (different culling at the horizon)
 * is cropped from the closest loaded ancestor DEM, or fetched as a last resort
 * (terrain off, style rebuild). When the terrain replaces a DEM tile (HD
 * upgrade, cache bust), the altitude tile built from the old one is reloaded.
 *
 * Reads Mapbox internals (source cache `_tiles`, `tile.dem`), all guarded:
 * anything missing falls back to the network path.
 */

/** Mapbox Terrain-RGB: elevation = -10000 + (R·65536 + G·256 + B) · 0.1. */
export const ALTITUDE_DEM_ENCODING = 'mapbox' as const;

/** How long a tile the terrain is not loading may wait before the fallbacks. */
const UNREQUESTED_TILE_GRACE_MS = 400;
/** Upper bound on waiting for a terrain tile that is loading. */
const LOADING_TILE_MAX_WAIT_MS = 30_000;
const REFRESH_DEBOUNCE_MS = 120;

export interface DemDataLike {
  dim: number;
  stride: number;
  floatView: Float32Array;
}

interface TileLike {
  tileID: { key: number; canonical: { z: number; x: number; y: number } };
  dem?: DemDataLike | null;
  state?: string;
  hasData(): boolean;
}

interface SourceCacheLike {
  _tiles?: Record<string, TileLike>;
  _reloadTile?: (id: number, state: string) => void;
}

interface StyleLike {
  getOwnSourceCache?: (id: string) => SourceCacheLike | undefined;
}

export interface AltitudeFallbackTiles {
  /** `{z}/{x}/{y}` template answered with a DEM PNG. */
  url: string;
  encoding: 'mapbox' | 'terrarium';
}

function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

function isDemData(value: unknown): value is DemDataLike {
  const dem = value as DemDataLike | null | undefined;
  return Boolean(dem && dem.floatView instanceof Float32Array && dem.dim > 0 && dem.stride >= dem.dim);
}

/** Terrain-RGB image of `dem`, or of the `(qx, qy)` cell of a `2^dz` split of it. */
export function encodeDem(dem: DemDataLike, dz = 0, qx = 0, qy = 0): ImageData {
  const size = dem.dim;
  const image = new ImageData(size, size);
  const out = image.data;
  const scale = 1 / (1 << dz);
  const ox = qx * size * scale;
  const oy = qy * size * scale;
  const { floatView, stride } = dem;
  for (let py = 0; py < size; py += 1) {
    // Sample positions in the DEM grid (pixel centres); the 1 px border holds
    // the neighbours, so bilinear reads may step one cell outside.
    const sy = dz === 0 ? py : oy + (py + 0.5) * scale - 0.5;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let px = 0; px < size; px += 1) {
      let h: number;
      if (dz === 0) {
        h = floatView[(py + 1) * stride + px + 1];
      } else {
        const sx = ox + (px + 0.5) * scale - 0.5;
        const x0 = Math.floor(sx);
        const fx = sx - x0;
        const r0 = (Math.max(-1, Math.min(size, y0)) + 1) * stride;
        const r1 = (Math.max(-1, Math.min(size, y0 + 1)) + 1) * stride;
        const c0 = Math.max(-1, Math.min(size, x0)) + 1;
        const c1 = Math.max(-1, Math.min(size, x0 + 1)) + 1;
        const top = floatView[r0 + c0] + (floatView[r0 + c1] - floatView[r0 + c0]) * fx;
        const bottom = floatView[r1 + c0] + (floatView[r1 + c1] - floatView[r1 + c0]) * fx;
        h = top + (bottom - top) * fy;
      }
      let v = Math.round((h + 10000) * 10);
      if (!(v > 0)) v = 0;
      else if (v > 0xffffff) v = 0xffffff;
      const o = (py * size + px) * 4;
      out[o] = (v >> 16) & 0xff;
      out[o + 1] = (v >> 8) & 0xff;
      out[o + 2] = v & 0xff;
      out[o + 3] = 255;
    }
  }
  return image;
}

async function fetchFallbackTile(
  fallback: AltitudeFallbackTiles,
  z: number,
  x: number,
  y: number,
  signal: AbortSignal,
): Promise<ImageBitmap | ImageData | null> {
  const url = fallback.url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  const response = await fetch(url, { signal });
  if (response.status !== 200) return null;
  const bitmap = await createImageBitmap(await response.blob());
  if (fallback.encoding === ALTITUDE_DEM_ENCODING) return bitmap;
  // Terrarium → Terrain-RGB, so the layer keeps a single decode expression.
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const h = px[i] * 256 + px[i + 1] + px[i + 2] / 256 - 32768;
    let v = Math.round((h + 10000) * 10);
    if (!(v > 0)) v = 0;
    else if (v > 0xffffff) v = 0xffffff;
    px[i] = (v >> 16) & 0xff;
    px[i + 1] = (v >> 8) & 0xff;
    px[i + 2] = v & 0xff;
    px[i + 3] = 255;
  }
  return image;
}

export interface AltitudeDemSourceOptions {
  id: string;
  tileSize: number;
  minzoom: number;
  maxzoom: number;
  fallback: AltitudeFallbackTiles;
}

export class AltitudeDemSource {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly dataType = 'raster' as const;
  readonly tileSize: number;
  readonly minzoom: number;
  readonly maxzoom: number;
  /** Injected by Mapbox on addSource: reloads every tile of the source. */
  update?: () => void;

  private map: MapboxMap | null = null;
  private readonly fallback: AltitudeFallbackTiles;
  /** Altitude tile key → DEM data it was built from (null: network fallback). */
  private readonly served = new Map<string, DemDataLike | null>();
  /** Terrain tile key → callbacks waiting for it. */
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly staleKeys = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AltitudeDemSourceOptions) {
    this.id = options.id;
    this.tileSize = options.tileSize;
    this.minzoom = options.minzoom;
    this.maxzoom = options.maxzoom;
    this.fallback = options.fallback;
  }

  onAdd(map: MapboxMap): void {
    this.map = map;
    map.on('sourcedata', this.onSourceData);
    map.on('terrain', this.onTerrainChange);
  }

  onRemove(map: MapboxMap): void {
    map.off('sourcedata', this.onSourceData);
    map.off('terrain', this.onTerrainChange);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.map = null;
    for (const callbacks of this.waiters.values()) for (const wake of callbacks) wake();
    this.waiters.clear();
    this.served.clear();
    this.staleKeys.clear();
  }

  unloadTile({ z, x, y }: { z: number; x: number; y: number }): void {
    this.served.delete(tileKey(z, x, y));
  }

  async loadTile(
    { z, x, y }: { z: number; x: number; y: number },
    { signal }: { signal: AbortSignal },
  ): Promise<ImageData | ImageBitmap | null> {
    const key = tileKey(z, x, y);
    const startedAt = performance.now();
    for (;;) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const terrain = this.terrainSourceCache();
      const exact = terrain ? this.lookupTile(terrain, z, x, y) : null;
      if (exact?.dem) {
        this.served.set(key, exact.dem);
        return encodeDem(exact.dem);
      }
      const elapsed = performance.now() - startedAt;
      const terrainLoadingIt = Boolean(exact?.loading) && elapsed < LOADING_TILE_MAX_WAIT_MS;
      if (terrain && (terrainLoadingIt || elapsed < UNREQUESTED_TILE_GRACE_MS)) {
        await this.waitForTerrainTile(key, signal, terrainLoadingIt ? LOADING_TILE_MAX_WAIT_MS : UNREQUESTED_TILE_GRACE_MS);
        continue;
      }
      // The terrain does not hold this tile: what it renders there is an
      // ancestor DEM, so crop the same one.
      const ancestor = terrain ? this.findAncestor(terrain, z, x, y) : null;
      if (ancestor) {
        this.served.set(key, ancestor.dem);
        this.staleKeys.add(key);
        return encodeDem(ancestor.dem, ancestor.dz, ancestor.qx, ancestor.qy);
      }
      this.served.set(key, null);
      return fetchFallbackTile(this.fallback, z, x, y, signal);
    }
  }

  private terrainSourceCache(): SourceCacheLike | null {
    const map = this.map;
    const id = map?.getTerrain()?.source;
    if (!map || !id) return null;
    try {
      const style = (map as unknown as { style?: StyleLike }).style;
      const cache = style?.getOwnSourceCache?.(id);
      return cache?._tiles ? cache : null;
    } catch {
      return null;
    }
  }

  /** The terrain's DEM for z/x/y, or whether it is still loading it. */
  private lookupTile(
    cache: SourceCacheLike,
    z: number,
    x: number,
    y: number,
  ): { dem: DemDataLike | null; loading: boolean } | null {
    let loading = false;
    for (const id in cache._tiles) {
      const tile = cache._tiles[id];
      const c = tile.tileID.canonical;
      if (c.z !== z || c.x !== x || c.y !== y) continue;
      if (tile.hasData() && isDemData(tile.dem)) return { dem: tile.dem, loading: false };
      if (tile.state === 'loading' || tile.state === 'reloading') loading = true;
    }
    return loading ? { dem: null, loading } : null;
  }

  private findAncestor(
    cache: SourceCacheLike,
    z: number,
    x: number,
    y: number,
  ): { dem: DemDataLike; dz: number; qx: number; qy: number } | null {
    for (let dz = 1; dz <= Math.min(z, 6); dz += 1) {
      const px = x >> dz;
      const py = y >> dz;
      const dem = this.lookupTile(cache, z - dz, px, py)?.dem;
      if (dem) return { dem, dz, qx: x - (px << dz), qy: y - (py << dz) };
    }
    return null;
  }

  private waitForTerrainTile(key: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let callbacks = this.waiters.get(key);
      if (!callbacks) {
        callbacks = new Set();
        this.waiters.set(key, callbacks);
      }
      const set = callbacks;
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        set.delete(done);
        if (set.size === 0 && this.waiters.get(key) === set) this.waiters.delete(key);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      signal.addEventListener('abort', done, { once: true });
      set.add(done);
    });
  }

  private readonly onSourceData = (event: { sourceId?: string; tile?: TileLike }): void => {
    const map = this.map;
    const tile = event.tile;
    if (!map || !tile || event.sourceId !== map.getTerrain()?.source) return;
    const { z, x, y } = tile.tileID.canonical;
    const key = tileKey(z, x, y);
    const callbacks = this.waiters.get(key);
    if (callbacks) for (const wake of [...callbacks]) wake();
    if (!tile.hasData() || !isDemData(tile.dem)) return;
    // A DEM tile replaced the one an altitude tile was built from (HD upgrade,
    // cache bust), or a cropped / fetched stand-in can now be exact.
    if (this.served.has(key) && this.served.get(key) !== tile.dem) this.staleKeys.add(key);
    for (const servedKey of this.staleKeys) {
      if (servedKey !== key && !this.isDescendant(servedKey, z, x, y)) continue;
      this.scheduleRefresh();
      return;
    }
  };

  private readonly onTerrainChange = (): void => {
    for (const key of this.served.keys()) this.staleKeys.add(key);
    this.scheduleRefresh();
  };

  private isDescendant(key: string, z: number, x: number, y: number): boolean {
    const [cz, cx, cy] = key.split('/').map(Number);
    if (cz <= z) return false;
    const dz = cz - z;
    return (cx >> dz) === x && (cy >> dz) === y;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshStaleTiles();
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Rebuilds only the stale tiles (per-tile reload), else the whole source. */
  private refreshStaleTiles(): void {
    const map = this.map;
    if (!map || this.staleKeys.size === 0) return;
    const stale = new Set(this.staleKeys);
    this.staleKeys.clear();
    try {
      const style = (map as unknown as { style?: StyleLike }).style;
      const cache = style?.getOwnSourceCache?.(this.id);
      if (cache?._tiles && typeof cache._reloadTile === 'function') {
        for (const id in cache._tiles) {
          const { z, x, y } = cache._tiles[id].tileID.canonical;
          if (stale.has(tileKey(z, x, y))) cache._reloadTile(Number(id), 'reloading');
        }
        map.triggerRepaint();
        return;
      }
    } catch {
      /* fall through to the public reload */
    }
    this.update?.();
  }
}
