import type { Map as MapboxMap, ProjectionSpecification } from 'mapbox-gl';

export function getWindProjectionName(map: MapboxMap): string | null {
  try {
    return map.getProjection()?.name ?? null;
  } catch {
    return null;
  }
}

export function isWindProjectionSupported(map: MapboxMap): boolean {
  return getWindProjectionName(map) === 'mercator';
}

export function ensureWindProjection(map: MapboxMap): ProjectionSpecification | null {
  const current = map.getProjection();
  if (current?.name === 'mercator') return null;
  map.setProjection('mercator');
  return current ?? null;
}

export function restoreWindProjection(
  map: MapboxMap,
  projection: ProjectionSpecification | null,
): void {
  if (!projection) return;
  const current = map.getProjection();
  if (current?.name === projection.name) return;
  map.setProjection(projection);
}
