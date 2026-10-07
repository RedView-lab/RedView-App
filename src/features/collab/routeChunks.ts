/**
 * Découpage d'un tracé (tableau de points) en segments adressés par leur
 * contenu, pour le document collaboratif.
 *
 * Les coupures dépendent du contenu des points (découpage « content-defined »,
 * comme rsync / restic) : après une édition locale, les coupures en aval
 * retombent sur les mêmes points qu'avant, donc seuls les segments touchant la
 * zone modifiée changent. Chaque segment est identifié par un hachage de son
 * JSON : deux éditeurs qui découpent le même tracé obtiennent les mêmes ids
 * (pas de doublon), et un même id désigne toujours le même contenu.
 *
 * Le JSON d'un segment est exactement celui des points : relire un tracé
 * redonne les mêmes valeurs (flottants compris).
 */

/** Taille minimale, moyenne visée et maximale d'un segment (en points). */
export const ROUTE_CHUNK_MIN_POINTS = 64;
const ROUTE_CHUNK_AVG_POINTS = 256;
export const ROUTE_CHUNK_MAX_POINTS = 1024;

export interface RouteChunk {
  id: string;
  /** JSON du segment (tableau de points). */
  json: string;
}

interface RoutePointLike {
  lat?: unknown;
  lon?: unknown;
}

/** Hachage 53 bits (cyrb53) d'une chaîne. */
function hash53(value: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Id d'un segment : 106 bits de hachage de son JSON. */
export function routeChunkId(json: string): string {
  return `c${hash53(json, 11).toString(36)}${hash53(json, 29).toString(36)}`;
}

function quantize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1e6) | 0 : 0;
}

/** Hachage d'un point (position arrondie au micro-degré) qui décide des coupures. */
function pointHash(point: RoutePointLike): number {
  let h = Math.imul(quantize(point.lat), 0x9e3779b1) ^ Math.imul(quantize(point.lon), 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Bornes (indices de fin exclus) des segments d'un tableau de points. */
export function routeChunkBounds(points: readonly RoutePointLike[]): number[] {
  const ends: number[] = [];
  let start = 0;
  for (let i = 0; i < points.length; i += 1) {
    const length = i - start + 1;
    if (length < ROUTE_CHUNK_MIN_POINTS) continue;
    if (length >= ROUTE_CHUNK_MAX_POINTS || pointHash(points[i]) % ROUTE_CHUNK_AVG_POINTS === 0) {
      ends.push(i + 1);
      start = i + 1;
    }
  }
  if (start < points.length) ends.push(points.length);
  return ends;
}

/**
 * Segments d'un tableau de points. Mémorisé par tableau : un tracé déjà
 * découpé (même référence) n'est pas redécoupé.
 */
const chunkCache = new WeakMap<readonly unknown[], RouteChunk[]>();

export function chunkRoutePoints(points: readonly RoutePointLike[]): RouteChunk[] {
  const cached = chunkCache.get(points);
  if (cached) return cached;
  const chunks: RouteChunk[] = [];
  let start = 0;
  for (const end of routeChunkBounds(points)) {
    const json = JSON.stringify(points.slice(start, end));
    chunks.push({ id: routeChunkId(json), json });
    start = end;
  }
  chunkCache.set(points, chunks);
  return chunks;
}

/**
 * Points d'un tracé à partir de ses ids de segments. Null si un segment
 * manque (jamais le cas dans un document cohérent : un en-tête arrive
 * toujours avec ses segments).
 */
export function joinRouteChunks<T>(
  ids: readonly string[],
  readChunk: (id: string) => readonly T[] | null,
): T[] | null {
  const out: T[] = [];
  for (const id of ids) {
    const chunk = readChunk(id);
    if (!chunk) return null;
    for (const point of chunk) out.push(point);
  }
  return out;
}
