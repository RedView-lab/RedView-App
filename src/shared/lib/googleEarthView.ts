/**
 * Point de vue Google Earth (web) identique à une caméra RedView (carte 3D,
 * viewer LiDAR), ouvert avec la touche M.
 *
 * Format de l'URL, mesuré sur earth.google.com (2026-10-07, headless, lecture
 * des coordonnées sous le curseur à des pixels connus) :
 *   `/web/@<lat>,<lon>,<a>a,<d>d,<y>y,<h>h,<t>t,<r>r`
 *   - lat/lon : point visé (au centre de la fenêtre) ;
 *   - a : altitude de ce point en mètres au-dessus du niveau de la mer —
 *     respectée telle quelle, même en l'air (la caméra reste à a + d·cos t) ;
 *   - d : distance caméra → point visé (m) ;
 *   - y : champ de vision **vertical** (degrés, sur la hauteur de la fenêtre) :
 *     à 1 500 m, `35y`, 300 px sous le centre d'une fenêtre de 800 px = 355 m
 *     au sol (1500 · 300 · tan 17,5° / 400 = 354,7) ; l'échelle suit la hauteur
 *     de la fenêtre, pas sa largeur ;
 *   - h : cap de la visée, degrés horaires depuis le nord vrai ;
 *   - t : inclinaison depuis la verticale (0 = vers le bas, 90 = horizon,
 *     > 90 = vers le ciel) ; r : roulis.
 * Une caméra se décrit donc entièrement par sa position et un point de sa
 * ligne de visée : peu importe lequel, on prend le sol quand la visée le
 * touche (Google Earth orbite ensuite autour de lui).
 */

const DEG = Math.PI / 180;

/** WGS84 : demi-grand axe et première excentricité au carré. */
const WGS84_A = 6378137;
const WGS84_E2 = 6.69437999014e-3;

export interface GeoPoint {
  lon: number;
  lat: number;
  /** Altitude (m) au-dessus du niveau de la mer. */
  altitudeM: number;
}

export interface GoogleEarthView {
  /** Point visé. */
  target: GeoPoint;
  /** Distance caméra → point visé (m). */
  distanceM: number;
  /** Champ de vision vertical (degrés). */
  fovYDeg: number;
  /** Cap de la visée (degrés, horaire depuis le nord vrai). */
  headingDeg: number;
  /** Inclinaison depuis la verticale descendante (degrés, 0…180). */
  tiltDeg: number;
}

/** Vecteur local est / nord / haut (m). */
export type Enu = [number, number, number];

/**
 * Mètres par radian de latitude (rayon méridien M) et de longitude
 * (N · cos φ) sur l'ellipsoïde : exact localement, sans l'erreur ≈ 0,3 % d'une
 * Terre sphérique (plus grande que l'écart d'échelle d'un Lambert-93).
 */
function metersPerRadian(latDeg: number): { north: number; east: number } {
  const phi = latDeg * DEG;
  const s = Math.sin(phi);
  const w = 1 - WGS84_E2 * s * s;
  const n = WGS84_A / Math.sqrt(w);
  return { north: (WGS84_A * (1 - WGS84_E2)) / (w * Math.sqrt(w)), east: n * Math.cos(phi) };
}

/** Écart de `from` à `to` dans le plan tangent local (assez exact jusqu'à quelques dizaines de km). */
export function enuBetween(from: GeoPoint, to: GeoPoint): Enu {
  const scale = metersPerRadian((from.lat + to.lat) / 2);
  let dLon = to.lon - from.lon;
  if (dLon > 180) dLon -= 360;
  else if (dLon < -180) dLon += 360;
  return [dLon * DEG * scale.east, (to.lat - from.lat) * DEG * scale.north, to.altitudeM - from.altitudeM];
}

/** Point à `enu` mètres de `from` (inverse de `enuBetween`). */
export function offsetGeoPoint(from: GeoPoint, [east, north, up]: Enu): GeoPoint {
  let scale = metersPerRadian(from.lat);
  let lat = from.lat + north / scale.north / DEG;
  // Une itération à la latitude moyenne, comme `enuBetween`.
  scale = metersPerRadian((from.lat + lat) / 2);
  lat = from.lat + north / scale.north / DEG;
  let lon = from.lon + east / scale.east / DEG;
  if (lon > 180) lon -= 360;
  else if (lon < -180) lon += 360;
  return { lon, lat, altitudeM: from.altitudeM + up };
}

/** Une visée plus proche de la verticale n'a plus de cap : il vient du haut de l'écran. */
const VERTICAL_SIGHT_RATIO = 1e-6;

/**
 * Vue Google Earth d'une caméra placée en `camera` et visant `target`, sans
 * roulis (horizon horizontal, comme RedView). `screenUp` (haut de l'écran,
 * est/nord/haut) donne le cap d'une visée verticale — vue zénithale tournée.
 */
export function googleEarthViewFromCamera(
  camera: GeoPoint,
  target: GeoPoint,
  fovYDeg: number,
  screenUp?: Enu,
): GoogleEarthView | null {
  const [east, north, up] = enuBetween(camera, target);
  const distanceM = Math.hypot(east, north, up);
  if (!(distanceM > 1e-3) || !Number.isFinite(distanceM)) return null;
  const horizontal = Math.hypot(east, north);
  let headingDeg = 0;
  if (horizontal > distanceM * VERTICAL_SIGHT_RATIO) {
    headingDeg = normalizeDegrees(Math.atan2(east, north) / DEG);
  } else if (screenUp && Math.hypot(screenUp[0], screenUp[1]) > 1e-9) {
    // Vers le bas, le haut de l'écran pointe le cap ; vers le ciel, son opposé.
    const sign = up < 0 ? 1 : -1;
    headingDeg = normalizeDegrees(Math.atan2(sign * screenUp[0], sign * screenUp[1]) / DEG);
  }
  return { target, distanceM, fovYDeg, headingDeg, tiltDeg: Math.atan2(horizontal, -up) / DEG };
}

function normalizeDegrees(value: number): number {
  const wrapped = value % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function fixed(value: number, digits: number): string {
  // Jamais « -0.0000 » dans l'URL.
  const text = value.toFixed(digits);
  return /^-0\.?0*$/.test(text) ? text.slice(1) : text;
}

export function buildGoogleEarthUrl(view: GoogleEarthView): string {
  const { target } = view;
  const parts = [
    fixed(target.lat, 8),
    fixed(target.lon, 8),
    `${fixed(target.altitudeM, 3)}a`,
    `${fixed(Math.max(view.distanceM, 0.01), 3)}d`,
    `${fixed(view.fovYDeg, 4)}y`,
    `${fixed(normalizeDegrees(view.headingDeg), 4)}h`,
    `${fixed(Math.min(180, Math.max(0, view.tiltDeg)), 4)}t`,
    '0r',
  ];
  return `https://earth.google.com/web/@${parts.join(',')}`;
}

/**
 * Ouvre la vue dans un nouvel onglet. À appeler pendant le geste (keydown)
 * pour passer le bloqueur de pop-up ; `noopener` : Google Earth n'a pas la
 * main sur l'onglet RedView.
 */
export function openGoogleEarthView(view: GoogleEarthView): void {
  window.open(buildGoogleEarthUrl(view), '_blank', 'noopener,noreferrer');
}

/** Touche M (la lettre, quelle que soit la disposition du clavier), sans modificateur ni répétition. */
export function isGoogleEarthShortcut(event: KeyboardEvent): boolean {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return false;
  return event.key === 'm' || event.key === 'M';
}
