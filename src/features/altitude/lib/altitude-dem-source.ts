import type { Map as MapboxMap } from 'mapbox-gl';

/**
 * Tuiles de la surcouche d'altitude lues directement dans les tuiles DEM que le
 * terrain 3D a déjà décodées — pas de second téléchargement, pas d'aller-retour
 * par le Service Worker.
 *
 * La surcouche était une simple source raster sur les URL de tuiles du terrain.
 * Mêmes octets, récupérés deux fois : ses requêtes attendaient derrière celles
 * du terrain (et des tuiles satellite / VHR) dans la file d'images partagée de
 * Mapbox et sur les mêmes connexions, si bien qu'après un mouvement de caméra
 * les couleurs arrivaient 1 à 2 s après le relief. Une source personnalisée est
 * appelée directement par le pipeline de tuiles : chaque tuile est la tuile DEM
 * du terrain de même z/x/y (TERRAIN_ALIGNED_RASTER_TILE_SIZE rend les deux
 * pyramides identiques), réencodée en Terrain-RGB en mémoire (~1 ms) et colorée
 * sur le GPU par le raster-color de la couche.
 *
 * Tant que le terrain charge encore une tuile, `loadTile` l'attend — Mapbox
 * affiche entre-temps la tuile d'altitude parente, exactement comme le maillage
 * parent du relief. Une tuile que le terrain ne demande jamais (élimination
 * différente à l'horizon) est découpée dans le DEM ancêtre chargé le plus
 * proche, ou récupérée en dernier recours (terrain désactivé, reconstruction du
 * style). Quand le terrain remplace une tuile DEM (passage en HD, invalidation
 * du cache), la tuile d'altitude construite sur l'ancienne est rechargée.
 *
 * Lit des internes de Mapbox (`_tiles` du cache de source, `tile.dem`), tous
 * protégés : tout ce qui manque se replie sur le chemin réseau.
 */

/** Terrain-RGB de Mapbox : altitude = -10000 + (R·65536 + G·256 + B) · 0.1. */
const ALTITUDE_DEM_ENCODING = 'mapbox' as const;

/** Durée pendant laquelle une tuile que le terrain ne charge pas peut attendre avant les replis. */
const UNREQUESTED_TILE_GRACE_MS = 400;
/** Attente maximale d'une tuile de terrain en cours de chargement. */
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
  /** Gabarit `{z}/{x}/{y}` qui répond par un PNG DEM. */
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

/** Image Terrain-RGB de `dem`, ou de sa cellule `(qx, qy)` dans un découpage en `2^dz`. */
export function encodeDem(dem: DemDataLike, dz = 0, qx = 0, qy = 0): ImageData {
  const size = dem.dim;
  const image = new ImageData(size, size);
  const out = image.data;
  const scale = 1 / (1 << dz);
  const ox = qx * size * scale;
  const oy = qy * size * scale;
  const { floatView, stride } = dem;
  for (let py = 0; py < size; py += 1) {
    // Positions d'échantillonnage dans la grille DEM (centres des pixels) ; la
    // bordure de 1 px contient les voisines, donc une lecture bilinéaire peut
    // déborder d'une cellule.
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
  // Terrarium → Terrain-RGB, pour que la couche garde une seule expression de décodage.
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
  /** Injecté par Mapbox à l'addSource : recharge toutes les tuiles de la source. */
  update?: () => void;

  private map: MapboxMap | null = null;
  private readonly fallback: AltitudeFallbackTiles;
  /** Clé de tuile d'altitude → données DEM dont elle a été construite (null : repli réseau). */
  private readonly served = new Map<string, DemDataLike | null>();
  /** Clé de tuile du terrain → callbacks qui l'attendent. */
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

  /**
   * Même source pour une autre carte (rendu vidéo hors écran) : mêmes options,
   * aucun état partagé — chaque carte lit les tuiles de son propre relief.
   */
  cloneForMap(): AltitudeDemSource {
    return new AltitudeDemSource({
      id: this.id,
      tileSize: this.tileSize,
      minzoom: this.minzoom,
      maxzoom: this.maxzoom,
      fallback: this.fallback,
    });
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
      // Le terrain n'a pas cette tuile : ce qu'il y affiche est un DEM ancêtre,
      // on découpe donc le même.
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

  /** Le DEM du terrain pour z/x/y, ou le fait qu'il est encore en chargement. */
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
    // Une tuile DEM a remplacé celle dont une tuile d'altitude a été construite
    // (passage en HD, invalidation du cache), ou un substitut découpé / récupéré
    // peut maintenant être exact.
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

  /** Reconstruit seulement les tuiles périmées (rechargement par tuile), sinon toute la source. */
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
      /* on passe au rechargement public */
    }
    this.update?.();
  }
}
