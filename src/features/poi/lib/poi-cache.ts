import type { PoiCategory, PoiFeature } from '../types';
import { POI_CATEGORIES } from '../types';

// ── Configuration ─────────────────────────────────────────────────────

/** Tile zoom level for cache partitioning (~10 km per tile at z12) */
const TILE_ZOOM = 12;

/** Cache TTL in milliseconds (24 hours) */
const CACHE_TTL = 24 * 60 * 60 * 1000;

/** localStorage key prefix */
const LS_PREFIX = 'poi_cache_';

/** Max lon/lat span before we skip fetching (°, ~100 km) */
export const MAX_FETCH_SPAN = 1.0;

// ── Tile math ─────────────────────────────────────────────────────────

export interface TileKey {
  x: number;
  y: number;
  z: number;
}

export function tileKeyToString(t: TileKey): string {
  return `${t.z}/${t.x}/${t.y}`;
}

export function lngLatToTile(lng: number, lat: number): TileKey {
  const z = TILE_ZOOM;
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)), z };
}

export function tileToBbox(t: TileKey): [south: number, west: number, north: number, east: number] {
  const n = 2 ** t.z;
  const west = (t.x / n) * 360 - 180;
  const east = ((t.x + 1) / n) * 360 - 180;

  const northRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * t.y) / n)));
  const southRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (t.y + 1)) / n)));
  const north = (northRad * 180) / Math.PI;
  const south = (southRad * 180) / Math.PI;

  return [south, west, north, east];
}

/** Return all tile keys covering a geographic bounding box */
export function getTilesForBounds(
  south: number,
  west: number,
  north: number,
  east: number,
): TileKey[] {
  const sw = lngLatToTile(west, south);
  const ne = lngLatToTile(east, north);

  // ne.y can be < sw.y because y increases downward in slippy tiles
  const minX = Math.min(sw.x, ne.x);
  const maxX = Math.max(sw.x, ne.x);
  const minY = Math.min(sw.y, ne.y);
  const maxY = Math.max(sw.y, ne.y);

  const tiles: TileKey[] = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      tiles.push({ x, y, z: TILE_ZOOM });
    }
  }
  return tiles;
}

// ── Cache entry ───────────────────────────────────────────────────────

interface CacheEntry {
  ts: number; // timestamp millis
  features: PoiFeature[];
  /** Categories that were fetched for this tile */
  cats: PoiCategory[];
}

// ── In-memory cache ───────────────────────────────────────────────────

const memoryCache = new Map<string, CacheEntry>();

// Attempt to hydrate from localStorage at module load
function hydrateFromStorage(): void {
  try {
    const now = Date.now();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(LS_PREFIX)) continue;

      const raw = localStorage.getItem(key);
      if (!raw) continue;

      const entry: CacheEntry = JSON.parse(raw);
      if (now - entry.ts > CACHE_TTL) {
        localStorage.removeItem(key);
        continue;
      }

      const tileKey = key.slice(LS_PREFIX.length);
      memoryCache.set(tileKey, entry);
    }
  } catch {
    // localStorage might be unavailable or corrupted — silently ignore
  }
}

hydrateFromStorage();

// ── Public API ────────────────────────────────────────────────────────

/** Check if a tile is cached AND covers all requested categories */
export function isTileCached(tileKey: string, categories: PoiCategory[]): boolean {
  const entry = memoryCache.get(tileKey);
  if (!entry) return false;
  if (Date.now() - entry.ts > CACHE_TTL) {
    memoryCache.delete(tileKey);
    try { localStorage.removeItem(LS_PREFIX + tileKey); } catch { /* */ }
    return false;
  }
  // Check all requested categories were included in the cached fetch
  return categories.every((c) => entry.cats.includes(c));
}

/** Store features for a tile */
export function setCachedTile(tileKey: string, features: PoiFeature[], categories: PoiCategory[]): void {
  const entry: CacheEntry = { ts: Date.now(), features, cats: [...categories] };
  memoryCache.set(tileKey, entry);

  try {
    localStorage.setItem(LS_PREFIX + tileKey, JSON.stringify(entry));
  } catch {
    // quota exceeded — evict oldest entries
    evictOldest(5);
    try {
      localStorage.setItem(LS_PREFIX + tileKey, JSON.stringify(entry));
    } catch { /* give up */ }
  }
}

/** Get cached features for a tile, filtered by enabled categories */
export function getCachedFeatures(tileKey: string, categories: PoiCategory[]): PoiFeature[] {
  const entry = memoryCache.get(tileKey);
  if (!entry) return [];
  const catSet = new Set<PoiCategory>(categories);
  return entry.features.filter((f) => catSet.has(f.category));
}

/** Collect all cached features for given tiles, filtered by categories */
export function collectFeatures(tileKeys: string[], categories: PoiCategory[]): PoiFeature[] {
  const catSet = new Set<PoiCategory>(categories);
  const seen = new Set<number>();
  const result: PoiFeature[] = [];

  for (const key of tileKeys) {
    const entry = memoryCache.get(key);
    if (!entry) continue;
    for (const f of entry.features) {
      if (!catSet.has(f.category)) continue;
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      result.push(f);
    }
  }

  return result;
}

/** Invalidate all cache */
export function clearCache(): void {
  memoryCache.clear();
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(LS_PREFIX)) localStorage.removeItem(key);
    }
  } catch { /* */ }
}

/** Evict N oldest entries from localStorage to free space */
function evictOldest(count: number): void {
  const entries: { key: string; ts: number }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(LS_PREFIX)) continue;
    try {
      const raw = localStorage.getItem(key);
      if (raw) entries.push({ key, ts: JSON.parse(raw).ts ?? 0 });
    } catch { /* */ }
  }
  entries.sort((a, b) => a.ts - b.ts);
  for (let i = 0; i < Math.min(count, entries.length); i++) {
    localStorage.removeItem(entries[i].key);
  }
}

/** Get all category keys (used for "fetch all" mode) */
export function allCategories(): PoiCategory[] {
  return [...POI_CATEGORIES];
}
