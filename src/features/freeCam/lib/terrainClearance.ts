import type { Map as MapboxMap } from 'mapbox-gl';
import { FREECAM_MIN_GROUND_CLEARANCE_M } from './config';

/**
 * Élévation du terrain rendu en un point. `queryTerrainElevation` renvoie par
 * défaut l'élévation exagérée, soit exactement la surface affichée que la
 * caméra ne doit pas traverser. `null` si pas de terrain ou tuile DEM absente.
 */
export function queryRenderedGroundM(map: MapboxMap, lng: number, lat: number): number | null {
  if (!map.getTerrain()) return null;
  try {
    const elevation = map.queryTerrainElevation([lng, lat]);
    return typeof elevation === 'number' && Number.isFinite(elevation) ? elevation : null;
  } catch {
    return null;
  }
}

/**
 * Sol le plus haut entre la position courante et le point d'anticipation,
 * pour ne pas s'enfoncer dans une pente en avançant vers elle.
 */
export function sampleGroundM(
  map: MapboxMap,
  current: [number, number],
  lookahead: [number, number],
): number | null {
  const here = queryRenderedGroundM(map, current[0], current[1]);
  const ahead = queryRenderedGroundM(map, lookahead[0], lookahead[1]);
  if (here == null) return ahead;
  if (ahead == null) return here;
  return Math.max(here, ahead);
}

export function clampAboveGround(altitudeM: number, groundM: number | null): number {
  if (groundM == null) return Math.max(altitudeM, FREECAM_MIN_GROUND_CLEARANCE_M);
  return Math.max(altitudeM, groundM + FREECAM_MIN_GROUND_CLEARANCE_M);
}
