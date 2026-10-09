import type { Map as MapboxMap } from 'mapbox-gl';

/**
 * Pourquoi la carte n'a pas atteint l'inactivité avant le plafond
 * MAP_LOADING_MAX_MS (12 s) : catégories des sources encore en chargement à ce
 * moment, envoyées avec `editor_ready` (3 ouvertures sur 16 finissaient à
 * 11,9 s, la pastille de chargement affichée tout ce temps). Des catégories
 * fermées, jamais l'identifiant d'une source (il peut contenir celui d'un
 * itinéraire).
 */
export type PendingSourceCategory =
  | 'dem' | 'satellite' | 'basemap' | 'poi' | 'weather' | 'route' | 'slope'
  | 'altitude' | 'lidar' | 'sunlight' | 'other';

const RULES: ReadonlyArray<[RegExp, PendingSourceCategory]> = [
  [/dem/i, 'dem'],
  [/ortho|satellite/i, 'satellite'],
  [/poi/i, 'poi'],
  [/weather|wind|radar/i, 'weather'],
  [/brouter|route|itinerar/i, 'route'],
  [/slope|contour/i, 'slope'],
  [/altitude/i, 'altitude'],
  [/lidar/i, 'lidar'],
  [/sunlight|shadow/i, 'sunlight'],
  [/composite|mapbox|basemap|streets/i, 'basemap'],
];

export function pendingSourceCategory(sourceId: string): PendingSourceCategory {
  return RULES.find(([pattern]) => pattern.test(sourceId))?.[1] ?? 'other';
}

/** « dem+poi » (triées, sans doublon), « none » si tout est chargé. */
export function summarizePendingSources(sourceIds: readonly string[]): string {
  const categories = [...new Set(sourceIds.map(pendingSourceCategory))].sort();
  return categories.length > 0 ? categories.join('+') : 'none';
}

/** Sources du style pas encore chargées (API publique de Mapbox). */
export function pendingSourceIds(map: Pick<MapboxMap, 'getStyle' | 'isSourceLoaded'>): string[] {
  try {
    const sources = map.getStyle()?.sources ?? {};
    return Object.keys(sources).filter((id) => {
      try {
        return !map.isSourceLoaded(id);
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
