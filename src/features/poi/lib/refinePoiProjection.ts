/**
 * Projection plane locale de la trace pour les POI (distance latérale,
 * progression le long de la trace).
 *
 * Métrique : équirectangulaire LOCALE par segment (kx = cos(lat moyenne du
 * segment) × 111 320 m/°) — comme le serveur POI. Une échelle de longitude
 * unique (latitude moyenne de la trace) faussait la distance latérale de
 * ±7-9 % aux extrémités d'un itinéraire nord–sud de 1 000 km (POI gardés ou
 * rejetés à tort autour de X) et la progression de plusieurs km.
 *
 * Les coordonnées globales x/y ne servent plus qu'à l'élagage spatial : leur
 * échelle de longitude est celle du |lat| max de la trace (cos minimal), si
 * bien qu'un écart en x/y est toujours <= à l'écart réel — l'élagage reste
 * conservatif.
 */
import type { GpxRoute, PoiFeature } from '../types';
import type { OpenStatus } from './refinePoiOpeningHours';

const METERS_PER_DEG_LAT = 110_540;
const METERS_PER_DEG_LON = 111_320;
const PROXIMITY_FULL_FALLOFF_M = 500;

const RICH_TAG_KEYS = [
  'phone', 'website', 'opening_hours', 'wheelchair',
  'cuisine', 'operator', 'email', 'addr:street',
];

export interface ProjectedRoutePoint {
  x: number;
  y: number;
  progressM: number;
  lat?: number;
  lon?: number;
}

export interface ProjectedRouteMetadata {
  refLat: number;
  lonScale: number;
  latScale: number;
  _chunks?: RouteChunk[];
}

export interface ProjectedPoi {
  feature: PoiFeature;
  progressM: number;
  lateralDistanceM: number;
  etaSec: number | null;
  baseScore: number;
  score: number;
  openStatus: OpenStatus;
  clusterId: number;
}

/** Mètres par degré de longitude à la latitude `latDeg`. */
function lonMetersAt(latDeg: number): number {
  return Math.cos((latDeg * Math.PI) / 180) * METERS_PER_DEG_LON;
}

/**
 * Projection d'un point sur le segment [a, b] dans la métrique locale du
 * segment (kx = cos(lat moyenne de a et b)). `cross` > 0 ⇒ point à gauche du
 * sens de marche (x = est, y = nord).
 */
export function projectOntoSegmentLocal(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  lat: number,
  lon: number,
): { t: number; distanceM: number; segmentLengthM: number; cross: number } {
  const kx = lonMetersAt((a.lat + b.lat) / 2);
  const ky = METERS_PER_DEG_LAT;
  const abx = (b.lon - a.lon) * kx;
  const aby = (b.lat - a.lat) * ky;
  const apx = (lon - a.lon) * kx;
  const apy = (lat - a.lat) * ky;
  const segLenSq = abx * abx + aby * aby;
  const t = segLenSq > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / segLenSq)) : 0;
  const dx = apx - t * abx;
  const dy = apy - t * aby;
  return {
    t,
    distanceM: Math.sqrt(dx * dx + dy * dy),
    segmentLengthM: Math.sqrt(segLenSq),
    cross: abx * apy - aby * apx,
  };
}

/** Latitude / longitude d'un point projeté (repli sur x/y pour les anciens objets). */
export function projectedLatLon(
  p: ProjectedRoutePoint,
  meta: Partial<ProjectedRouteMetadata>,
): { lat: number; lon: number } {
  const latScale = meta.latScale ?? METERS_PER_DEG_LAT;
  const lat = p.lat ?? p.y / latScale;
  const lonScale = meta.lonScale ?? lonMetersAt(lat);
  return { lat, lon: p.lon ?? p.x / lonScale };
}

export function projectRoutePoints(points: GpxRoute['points']): ProjectedRoutePoint[] {
  if (points.length === 0) return [];
  let sumLat = 0;
  let maxAbsLat = 0;
  for (let i = 0; i < points.length; i++) {
    sumLat += points[i]!.lat;
    maxAbsLat = Math.max(maxAbsLat, Math.abs(points[i]!.lat));
  }
  const refLat = sumLat / points.length;
  // Échelle de l'élagage spatial uniquement (cos minimal ⇒ écarts x/y <= écarts
  // réels) ; distances et progression utilisent la métrique locale du segment.
  const lonScale = Math.max(0.01 * METERS_PER_DEG_LON, lonMetersAt(Math.min(90, maxAbsLat)));
  const latScale = METERS_PER_DEG_LAT;

  const result: ProjectedRoutePoint[] = new Array(points.length);
  let totalProgress = 0;

  result[0] = {
    x: points[0]!.lon * lonScale,
    y: points[0]!.lat * latScale,
    progressM: 0,
    lat: points[0]!.lat,
    lon: points[0]!.lon,
  };

  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const prev = points[i - 1]!;
    const dx = (p.lon - prev.lon) * lonMetersAt((p.lat + prev.lat) / 2);
    const dy = (p.lat - prev.lat) * latScale;
    totalProgress += Math.sqrt(dx * dx + dy * dy);
    result[i] = { x: p.lon * lonScale, y: p.lat * latScale, progressM: totalProgress, lat: p.lat, lon: p.lon };
  }

  const meta = result as unknown as ProjectedRouteMetadata;
  meta.refLat = refLat;
  meta.lonScale = lonScale;
  meta.latScale = latScale;

  return result;
}

export interface RouteChunk {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  start: number;
  end: number;
}

const CHUNK_SIZE = 128;

export function getRouteChunks(route: readonly ProjectedRoutePoint[]): RouteChunk[] {
  const cached = (route as { _chunks?: RouteChunk[] })._chunks;
  if (cached) return cached;

  const chunks: RouteChunk[] = [];
  const n = route.length;
  for (let start = 0; start < n - 1; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE, n - 1);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = start; i <= end; i++) {
      const p = route[i]!;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    chunks.push({ minX, maxX, minY, maxY, start, end });
  }
  try {
    (route as { _chunks?: RouteChunk[] })._chunks = chunks;
  } catch {}
  return chunks;
}

export function projectPoiOntoRoute(
  poi: PoiFeature,
  route: readonly ProjectedRoutePoint[],
  etaSecByPoint?: readonly number[],
): { progressM: number; lateralDistanceM: number; etaSec: number | null } {
  if (route.length === 0) {
    return { progressM: 0, lateralDistanceM: 0, etaSec: null };
  }

  // x/y globaux (élagage) : même échelle que la trace. Les distances sont
  // calculées dans la métrique locale de chaque segment.
  const meta = route as unknown as Partial<ProjectedRouteMetadata>;
  const lonScale = meta.lonScale ?? (
    route[0]?.lat != null
      ? lonMetersAt(route[0].lat)
      : lonMetersAt(poi.lat)
  );
  const latScale = meta.latScale ?? METERS_PER_DEG_LAT;

  const px = poi.lon * lonScale;
  const py = poi.lat * latScale;

  const vertexDistanceM = (p: ProjectedRoutePoint): number => {
    const ll = projectedLatLon(p, meta);
    const dx = (poi.lon - ll.lon) * lonMetersAt((poi.lat + ll.lat) / 2);
    const dy = (poi.lat - ll.lat) * METERS_PER_DEG_LAT;
    return Math.sqrt(dx * dx + dy * dy);
  };

  if (route.length === 1) {
    const p = route[0]!;
    return {
      progressM: p.progressM,
      lateralDistanceM: vertexDistanceM(p),
      etaSec: etaSecByPoint?.[0] ?? null,
    };
  }

  // 1. Échantillonnage grossier : borne supérieure rapide (élagage seulement ;
  //    le résultat vient toujours d'un segment).
  let bound = Infinity;
  const stride = Math.max(1, Math.floor(route.length / 64));
  for (let i = 0; i < route.length; i += stride) {
    const d = vertexDistanceM(route[i]!);
    if (d < bound) bound = d;
  }

  let bestDist = Infinity;
  let bestProgressM = 0;
  let bestSegmentIndex = 0;
  let bestSegmentT = 0;

  // Marge d'élagage : la borne vient d'une métrique légèrement différente
  // (latitude moyenne POI/sommet) de celle des segments.
  let pruneDist = bound * 1.01 + 1;

  // 2. Élagage spatial hiérarchique par paquets (chunks de 128 points).
  //    Les écarts x/y (cos minimal de la trace) sont <= aux écarts réels :
  //    un paquet hors de la boîte élargie ne peut contenir mieux.
  const chunks = getRouteChunks(route);
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]!;

    // Élimination du paquet entier de 128 segments en un seul test AABB
    if (
      px < chunk.minX - pruneDist ||
      px > chunk.maxX + pruneDist ||
      py < chunk.minY - pruneDist ||
      py > chunk.maxY + pruneDist
    ) {
      continue;
    }

    // Parcours fin des segments uniquement dans les paquets candidats
    for (let i = chunk.start; i < chunk.end; i++) {
      const a = route[i]!;
      const b = route[i + 1]!;

      const minX = (a.x < b.x ? a.x : b.x) - pruneDist;
      if (px < minX) continue;
      const maxX = (a.x > b.x ? a.x : b.x) + pruneDist;
      if (px > maxX) continue;
      const minY = (a.y < b.y ? a.y : b.y) - pruneDist;
      if (py < minY) continue;
      const maxY = (a.y > b.y ? a.y : b.y) + pruneDist;
      if (py > maxY) continue;

      const seg = projectOntoSegmentLocal(
        projectedLatLon(a, meta),
        projectedLatLon(b, meta),
        poi.lat,
        poi.lon,
      );

      if (seg.distanceM < bestDist) {
        bestDist = seg.distanceM;
        pruneDist = bestDist * 1.01 + 1;
        // Progression : longueur cumulée (métrique locale) jusqu'à a, puis
        // fraction du segment — cohérente avec projectRoutePoints.
        bestProgressM = a.progressM + seg.t * (b.progressM - a.progressM);
        bestSegmentIndex = i;
        bestSegmentT = seg.t;
      }
    }
  }

  // Filet de sécurité (ne devrait pas arriver) : parcours complet.
  if (!Number.isFinite(bestDist)) {
    for (let i = 0; i < route.length - 1; i++) {
      const a = route[i]!;
      const b = route[i + 1]!;
      const seg = projectOntoSegmentLocal(projectedLatLon(a, meta), projectedLatLon(b, meta), poi.lat, poi.lon);
      if (seg.distanceM < bestDist) {
        bestDist = seg.distanceM;
        bestProgressM = a.progressM + seg.t * (b.progressM - a.progressM);
        bestSegmentIndex = i;
        bestSegmentT = seg.t;
      }
    }
  }

  let etaSec: number | null = null;
  if (etaSecByPoint && etaSecByPoint.length === route.length) {
    const etaA = etaSecByPoint[bestSegmentIndex];
    const etaB = etaSecByPoint[bestSegmentIndex + 1];
    if (etaA != null && etaB != null) {
      etaSec = etaA + bestSegmentT * (etaB - etaA);
    }
  }

  return {
    progressM: bestProgressM,
    lateralDistanceM: bestDist,
    etaSec,
  };
}


export function scorePoiFeature(poi: PoiFeature, lateralDistanceM: number): number {
  const proximity = Math.max(0, 1 - lateralDistanceM / PROXIMITY_FULL_FALLOFF_M);
  let metadataBonus = 0;
  if (poi.name && poi.name.trim().length > 0) {
    metadataBonus += 0.25;
  }
  if (poi.tags) {
    for (const key of RICH_TAG_KEYS) {
      if (poi.tags[key]) metadataBonus += 0.05;
    }
  }
  return proximity * 0.7 + metadataBonus;
}
