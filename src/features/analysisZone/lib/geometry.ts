/**
 * Aides géométriques de la zone d'analyse (polygone unique dessiné par
 * l'utilisateur qui concentre les widgets de terrain — pentes / altitude /
 * ensoleillement — sur une zone bornée plutôt que sur toute la vue).
 */

export interface AnalysisZonePoint {
  lat: number;
  lon: number;
}

export interface AnalysisZone {
  id: string;
  points: AnalysisZonePoint[];
  createdAt: string;
}

/** [ouest, sud, est, nord] en degrés. */
type BoundsTuple = [number, number, number, number];

const LNG_MIN = -180;
const LNG_MAX = 180;
const LAT_MIN = -85.05;
const LAT_MAX = 85.05;

export function isValidAnalysisZone(zone: AnalysisZone | null | undefined): zone is AnalysisZone {
  return Boolean(
    zone
    && Array.isArray(zone.points)
    && zone.points.length >= 3
    && zone.points.every(
      (point) => Number.isFinite(point.lat)
        && Number.isFinite(point.lon)
        && point.lat >= -90 && point.lat <= 90
        && point.lon >= -180 && point.lon <= 180,
    ),
  );
}

/** Anneau de paires [lng, lat], fermé (premier point répété à la fin). */
function analysisZoneRing(zone: AnalysisZone): [number, number][] {
  const ring = zone.points.map((point) => [point.lon, point.lat] as [number, number]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

export function analysisZoneBBox(zone: AnalysisZone): BoundsTuple {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const point of zone.points) {
    if (point.lon < west) west = point.lon;
    if (point.lon > east) east = point.lon;
    if (point.lat < south) south = point.lat;
    if (point.lat > north) north = point.lat;
  }
  return [
    Math.max(LNG_MIN, west),
    Math.max(LAT_MIN, south),
    Math.min(LNG_MAX, east),
    Math.min(LAT_MAX, north),
  ];
}

/**
 * `bounds` de la source raster Mapbox pour la zone. Les tuiles hors de ces
 * limites ne sont jamais demandées : c'est ce qui garde le nombre de tuiles de
 * pente / d'altitude proportionnel à la taille de la zone plutôt qu'à celle de
 * la vue.
 */
export function analysisZoneSourceBounds(zone: AnalysisZone): [number, number, number, number] {
  const [w, s, e, n] = analysisZoneBBox(zone);
  // Rétrécit légèrement à l'intérieur de l'emprise pour que les tuiles voisines
  // qui ne font que toucher le bord de l'emprise ne soient pas demandées quand
  // le polygone les exclut strictement. Le Service Worker applique par-dessus
  // le masque exact du polygone, pixel par pixel.
  const padX = Math.min(0.0025, (e - w) * 0.01);
  const padY = Math.min(0.0025, (n - s) * 0.01);
  return [
    Math.max(LNG_MIN, w - padX),
    Math.max(LAT_MIN, s - padY),
    Math.min(LNG_MAX, e + padX),
    Math.min(LAT_MAX, n + padY),
  ];
}

/**
 * Empreinte stable et compacte (FNV-1a 32 bits, hexadécimal) de l'anneau,
 * quantifiée à 1e-6 degré (~0,1 m) pour que le bruit des flottants ne change
 * jamais la clé. Sert de jeton d'invalidation `?zone=` dans les URL de tuiles
 * et de clé de registre du Service Worker : même polygone → mêmes tuiles,
 * polygone modifié → nouvelles tuiles.
 */
export function hashAnalysisZone(zone: AnalysisZone): string {
  let hash = 0x811c9dc5;
  const ring = analysisZoneRing(zone);
  for (const [lng, lat] of ring) {
    const token = `${lat.toFixed(6)},${lng.toFixed(6)};`;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

/** Anneau à plat [lng, lat, lng, lat, …] pour les workers / le Service Worker. */
export function analysisZoneRingPayload(zone: AnalysisZone): number[] {
  const out: number[] = [];
  for (const [lng, lat] of analysisZoneRing(zone)) {
    out.push(lng, lat);
  }
  return out;
}
