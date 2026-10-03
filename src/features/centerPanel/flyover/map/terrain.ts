import type { Map as MapboxMap } from 'mapbox-gl';
import type { GroundSampler } from '../engine/cameraPose';
import { latFromMercatorY, lngFromMercatorX } from '../engine/geo';

/** Exagération du relief rendu ; 0 sans terrain (carte plate : tout est au niveau 0). */
export function readTerrainExaggeration(map: MapboxMap): number {
  try {
    const terrain = map.getTerrain();
    if (!terrain) return 0;
    const exaggeration = (terrain as { exaggeration?: unknown }).exaggeration;
    return typeof exaggeration === 'number' && Number.isFinite(exaggeration) ? exaggeration : 1;
  } catch {
    return 0;
  }
}

/**
 * Altitude du relief tel qu'il est rendu (exagéré) en un point Mercator.
 * Mapbox retombe sur une tuile DEM parente chargée quand la plus fine manque
 * (sol sous la caméra, hors champ) ; `null` sans terrain ni tuile.
 */
export function createGroundSampler(map: MapboxMap, terrainEnabled: boolean): GroundSampler {
  if (!terrainEnabled) return () => null;
  return (x, y) => {
    try {
      const elevation = map.queryTerrainElevation([lngFromMercatorX(x), latFromMercatorY(y)]);
      return typeof elevation === 'number' && Number.isFinite(elevation) ? elevation : null;
    } catch {
      return null;
    }
  };
}
