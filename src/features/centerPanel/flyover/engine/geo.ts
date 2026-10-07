/**
 * Géométrie du flyover : Web Mercator normalisé [0, 1] (le repère de Mapbox
 * et de geojson-vt), conversions mètres ↔ unités Mercator, angles.
 * Mercator est conforme : un cap calculé sur des écarts Mercator est le cap vrai.
 */

/** Rayon terrestre utilisé par Mapbox pour l'échelle Mercator. */
const EARTH_RADIUS_M = 6_371_008.8;
export const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * EARTH_RADIUS_M;

const DEG = Math.PI / 180;
const MAX_MERCATOR_LAT = 85.051129;

export function mercatorXFromLng(lng: number): number {
  return (180 + lng) / 360;
}

export function mercatorYFromLat(lat: number): number {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2))) / 360;
}

export function lngFromMercatorX(x: number): number {
  return x * 360 - 180;
}

export function latFromMercatorY(y: number): number {
  const y2 = 180 - y * 360;
  return (360 / Math.PI) * Math.atan(Math.exp(y2 * DEG)) - 90;
}

/** Mètres par unité Mercator à une latitude (inverse de `mercatorZfromAltitude` de Mapbox). */
function metersPerMercatorUnit(lat: number): number {
  return EARTH_CIRCUMFERENCE_M * Math.cos(lat * DEG);
}

/** Même grandeur, depuis une ordonnée Mercator. */
export function metersPerMercatorUnitAtY(y: number): number {
  return metersPerMercatorUnit(latFromMercatorY(y));
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ramène un angle (radians) dans ]-π, π]. */
export function wrapPi(angle: number): number {
  const wrapped = angle - 2 * Math.PI * Math.floor((angle + Math.PI) / (2 * Math.PI));
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

/** Déroule une suite d'angles (radians) : plus de saut de 2π entre voisins. */
export function unwrapAngles(angles: Float64Array): void {
  for (let i = 1; i < angles.length; i += 1) {
    angles[i] = angles[i - 1] + wrapPi(angles[i] - angles[i - 1]);
  }
}

export function toRadians(degrees: number): number {
  return degrees * DEG;
}

export function toDegrees(radians: number): number {
  return radians / DEG;
}
