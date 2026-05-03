export interface RouteSignaturePoint {
  lat: number;
  lon: number;
  distanceM?: number | null;
  elevationM?: number | null;
  gradientPct?: number | null;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function buildRouteContentSignature(
  points: readonly RouteSignaturePoint[] | null | undefined,
): string {
  if (!points || points.length === 0) return 'empty';

  let hash = FNV_OFFSET;
  const mix = (value: number) => {
    hash ^= value & 0xff;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
    hash ^= (value >>> 8) & 0xff;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
    hash ^= (value >>> 16) & 0xff;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
    hash ^= (value >>> 24) & 0xff;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  };

  mix(points.length);
  for (const point of points) {
    mix(quantize(point.lon, 1e6));
    mix(quantize(point.lat, 1e6));
    mix(quantizeOptional(point.distanceM, 10));
    mix(quantizeOptional(point.elevationM, 10));
    mix(quantizeOptional(point.gradientPct, 100));
  }

  return `${points.length}:${hash.toString(36)}`;
}

function quantize(value: number, scale: number): number {
  return Math.round(value * scale) | 0;
}

function quantizeOptional(value: number | null | undefined, scale: number): number {
  return Number.isFinite(value) ? quantize(value as number, scale) : 0x7fffffff;
}