import type { ItineraryForbiddenZone } from '../../../types';

function formatCoordinate(value: number): string {
  return value.toFixed(6);
}

export function formatForbiddenZonePolygons(
  zones: ItineraryForbiddenZone[] | undefined,
): string | undefined {
  if (!zones || zones.length === 0) return undefined;

  const encoded = zones
    .filter((zone) => zone.points.length >= 3)
    .map((zone) =>
      zone.points
        .map((point) => `${formatCoordinate(point.lon)},${formatCoordinate(point.lat)}`)
        .join(','),
    )
    .filter((value) => value.length > 0);

  return encoded.length > 0 ? encoded.join('|') : undefined;
}