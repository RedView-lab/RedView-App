export interface RouteSignaturePoint {
  lat: number;
  lon: number;
  distanceM?: number | null;
  elevationM?: number | null;
  gradientPct?: number | null;
  surface?: string | null;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const routeSignatureCache = new WeakMap<readonly RouteSignaturePoint[], string>();
const routeGeometrySignatureCache = new WeakMap<readonly RouteSignaturePoint[], string>();

function createFnvHasher() {
  let hash = FNV_OFFSET;
  return {
    mix(value: number) {
      hash ^= value & 0xff;
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
      hash ^= (value >>> 8) & 0xff;
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
      hash ^= (value >>> 16) & 0xff;
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
      hash ^= (value >>> 24) & 0xff;
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    },
    digest: () => hash.toString(36),
  };
}

export function buildRouteContentSignature(
  points: readonly RouteSignaturePoint[] | null | undefined,
): string {
  if (!points || points.length === 0) return 'empty';

  const cached = routeSignatureCache.get(points);
  if (cached) return cached;

  const { mix, digest } = createFnvHasher();
  mix(points.length);
  for (const point of points) {
    mix(quantize(point.lon, 1e6));
    mix(quantize(point.lat, 1e6));
    mix(quantizeOptional(point.distanceM, 10));
    mix(quantizeOptional(point.elevationM, 10));
    mix(quantizeOptional(point.gradientPct, 100));
    mix(hashString(point.surface ?? 'unknown'));
  }

  const signature = `${points.length}:${digest()}`;
  routeSignatureCache.set(points, signature);
  return signature;
}

/**
 * Empreinte du seul tracé (lat/lon) : insensible à l'enrichissement
 * altitude / pente / surface, qui ne déplace pas la trace.
 */
export function buildRouteGeometrySignature(
  points: readonly RouteSignaturePoint[] | null | undefined,
): string {
  if (!points || points.length === 0) return 'empty';

  const cached = routeGeometrySignatureCache.get(points);
  if (cached) return cached;

  const { mix, digest } = createFnvHasher();
  mix(points.length);
  for (const point of points) {
    mix(quantize(point.lon, 1e6));
    mix(quantize(point.lat, 1e6));
  }

  const signature = `${points.length}:${digest()}`;
  routeGeometrySignatureCache.set(points, signature);
  return signature;
}

function quantize(value: number, scale: number): number {
  return Math.round(value * scale) | 0;
}

function quantizeOptional(value: number | null | undefined, scale: number): number {
  return Number.isFinite(value) ? quantize(value as number, scale) : 0x7fffffff;
}

function hashString(value: string): number {
  let hash = FNV_OFFSET;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash;
}