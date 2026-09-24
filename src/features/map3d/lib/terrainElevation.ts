import type { Map as MapboxMap } from 'mapbox-gl';

/**
 * True terrain elevation sampling — the single source of truth.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Mapbox GL JS v3 applies the active terrain exaggeration to
 * `map.queryTerrainElevation()` **by default**. The implementation is:
 *
 *   queryTerrainElevation(lngLat, options) {
 *     const elevation = this.transform.elevation;
 *     return elevation
 *       ? elevation.getAtPoint(..., Object.assign({}, { exaggerated: true }, options))
 *       : null;
 *   }
 *
 * RedView binds terrain with `exaggeration: 1.5` (TerrainManager, and the
 * fallback setTerrain calls in heartbeat.ts / FpsDiagnosticsMonitor.tsx), so a
 * bare `queryTerrainElevation([lng, lat])` returns **DEM height × 1.5**.
 *
 * Symptoms when this is forgotten:
 *   - Corsica's Monte Cintu (real DEM 2706 m) reads as 4059 m in the
 *     right-click context menu; typical ~2000 m terrain reads as ~3000 m —
 *     i.e. above the island's real highest peak.
 *   - The inflated value is forwarded as Open-Meteo's `elevation` parameter,
 *     corrupting the lapse-rate downscaling of the local weather/wind rows.
 *   - POI drafts, free-cam altitude, sun-ray anchors and particle altitudes
 *     are all offset vertically from the surface they are meant to hug.
 *
 * Absolute altitudes must therefore ALWAYS be sampled with
 * `{ exaggerated: false }`. Ratios (slopes) are immune — the factor cancels
 * in the difference — and may keep using the plain call.
 *
 * Use {@link queryTrueTerrainElevation} for every absolute reading.
 */

/** Options object accepted by Mapbox's `queryTerrainElevation`. */
type QueryTerrainElevationFn = (
  lngLat: [number, number],
  options?: { exaggerated?: boolean },
) => number | null | undefined;

function resolveQueryFn(map: MapboxMap | null | undefined): QueryTerrainElevationFn | null {
  if (!map) return null;
  const fn = (map as unknown as { queryTerrainElevation?: QueryTerrainElevationFn })
    .queryTerrainElevation;
  return typeof fn === 'function' ? fn : null;
}

/**
 * Sample the real (un-exaggerated) terrain elevation in meters.
 *
 * @returns the elevation in meters, or `null` when terrain is unavailable
 *          (DEM tile not loaded yet, globe zoom below source minzoom, terrain
 *          detached) or the value is not finite.
 */
export function queryTrueTerrainElevation(
  map: MapboxMap | null | undefined,
  lng: number,
  lat: number,
): number | null {
  const query = resolveQueryFn(map);
  if (!query) return null;
  try {
    const value = query.call(map, [lng, lat], { exaggerated: false });
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    // Terrain can throw while the style graph or DEM tiles are in transition.
    return null;
  }
}

/**
 * Like {@link queryTrueTerrainElevation} but falls back to a default instead of
 * `null` — convenient for altitude offsets and physics where a missing sample
 * should degrade to sea level rather than propagate null.
 */
export function queryTrueTerrainElevationOrDefault(
  map: MapboxMap | null | undefined,
  lng: number,
  lat: number,
  fallback = 0,
): number {
  return queryTrueTerrainElevation(map, lng, lat) ?? fallback;
}
