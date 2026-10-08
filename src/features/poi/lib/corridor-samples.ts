/**
 * Polyligne envoyée au serveur POI pour la recherche corridor.
 *
 * Le serveur teste la distance POI → SEGMENT : il n'a pas besoin de points
 * denses, mais il faut que la polyligne envoyée suive la trace. L'ancien
 * échantillonnage ne gardait qu'un sommet GPX tous les max(10 m, 1,4·r,
 * longueur/8000) : les cordes coupaient les virages et, sur un long
 * itinéraire, le pas dépassait largement le rayon (≈ 50 % des POI perdus sur
 * 2 700 km à r = 20 m).
 *
 * Ici :
 *   1. simplification Douglas-Peucker de la trace ORIGINALE avec une
 *      tolérance t <= r/4 (augmentée seulement si le budget de points
 *      l'exige) : tout sommet où la direction change de façon notable est
 *      conservé, et chaque point de la trace est à <= t de la polyligne ;
 *   2. le rayon interrogé devient r + t, pour que tout POI à <= r de la
 *      trace soit à <= r + t de la polyligne (le filtre latéral client
 *      ramène ensuite chaque catégorie à sa propre distance X) ;
 *   3. densification par interpolation le long des segments avec le budget
 *      restant (pas <= 1,4 × rayon quand le budget le permet) : utile pour
 *      les anciennes versions du serveur, qui n'indexaient que les points.
 */
import {
  POI_CORRIDOR_MAX_POINTS,
  POI_CORRIDOR_MAX_RADIUS_M,
  clampCorridorRadiusM,
} from './poi-api';

type LatLon = { lat: number; lon: number };

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON_EQ = 111_320;
const DEG = Math.PI / 180;

/** Marge sous le plafond serveur (le serveur rejette au-delà de 10 000). */
const DEFAULT_MAX_SAMPLES = POI_CORRIDOR_MAX_POINTS - 500;

function segmentLengthM(a: LatLon, b: LatLon): number {
  const kx = M_PER_DEG_LON_EQ * Math.cos(((a.lat + b.lat) / 2) * DEG);
  const dx = (b.lon - a.lon) * kx;
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Distance (m) de `p` au segment [a, b], métrique locale du segment (comme le serveur). */
function pointSegmentDistanceM(p: LatLon, a: LatLon, b: LatLon): number {
  const kx = M_PER_DEG_LON_EQ * Math.cos(((a.lat + b.lat) / 2) * DEG);
  const x2 = (b.lon - a.lon) * kx;
  const y2 = (b.lat - a.lat) * M_PER_DEG_LAT;
  const px = (p.lon - a.lon) * kx;
  const py = (p.lat - a.lat) * M_PER_DEG_LAT;
  const lenSq = x2 * x2 + y2 * y2;
  let t = lenSq === 0 ? 0 : (px * x2 + py * y2) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const dx = px - t * x2;
  const dy = py - t * y2;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Douglas-Peucker itératif : indices des sommets conservés (premier et dernier inclus). */
function simplifyIndices(points: LatLon[], toleranceM: number): number[] {
  const n = points.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let maxDist = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = pointSegmentDistanceM(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index >= 0 && maxDist > toleranceM) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

export interface CorridorSamples {
  /** Polyligne à envoyer (<= maxSamples points). */
  samples: LatLon[];
  /** Rayon à demander au serveur (rayon utilisateur + tolérance de simplification). */
  queryRadiusM: number;
}

export function buildCorridorSamples(
  points: LatLon[],
  radiusM: number,
  maxSamples: number = DEFAULT_MAX_SAMPLES,
): CorridorSamples {
  const radius = clampCorridorRadiusM(radiusM);
  const clean = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (clean.length < 2) return { samples: clean.map((p) => ({ lat: p.lat, lon: p.lon })), queryRadiusM: radius };
  const budget = Math.max(2, Math.min(maxSamples, POI_CORRIDOR_MAX_POINTS));

  // 1. Simplification : tolérance r/4, relevée jusqu'à r/2 si la trace
  //    simplifiée occupe plus de la moitié du budget (pour garder des points
  //    de densification), puis au-delà seulement si elle dépasse le budget.
  //    Près du rayon max serveur, la marge r + t est bornée : on garde alors
  //    t <= (max - r) tant que le budget le permet.
  const freeTolerance = Math.max(0, POI_CORRIDOR_MAX_RADIUS_M - radius);
  const densityTolerance = Math.min(radius / 2, freeTolerance);
  let tolerance = Math.min(radius / 4, Math.max(freeTolerance, radius / 100));
  let kept = simplifyIndices(clean, tolerance);
  while (kept.length > budget / 2 && tolerance < densityTolerance) {
    tolerance = Math.min(densityTolerance, tolerance * 1.5);
    kept = simplifyIndices(clean, tolerance);
  }
  while (kept.length > budget) {
    tolerance *= 1.5;
    kept = simplifyIndices(clean, tolerance);
  }
  const simplified = kept.map((i) => clean[i]);

  // 2. Rayon interrogé : r + t, borné par le serveur. Au-delà de ~9,9 km de
  //    rayon la marge est rognée : les POI à plus de r - t (t >= r/100) de
  //    la trace peuvent manquer — 1 % du rayon, tout au bord.
  const queryRadiusM = clampCorridorRadiusM(Math.min(POI_CORRIDOR_MAX_RADIUS_M, radius + tolerance));

  // 3. Densification le long des segments avec le budget restant.
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < simplified.length; i++) {
    const len = segmentLengthM(simplified[i - 1], simplified[i]);
    lengths.push(len);
    total += len;
  }
  const spare = budget - simplified.length;
  // somme(ceil(len/spacing)) <= total/spacing + segments <= spare + simplified.length - 1 < budget
  const spacing = Math.max(1.4 * queryRadiusM, spare > 0 ? total / spare : Infinity);
  const samples: LatLon[] = [{ lat: simplified[0].lat, lon: simplified[0].lon }];
  for (let i = 1; i < simplified.length; i++) {
    const a = simplified[i - 1];
    const b = simplified[i];
    const pieces = Number.isFinite(spacing) && spacing > 0 ? Math.max(1, Math.ceil(lengths[i - 1] / spacing)) : 1;
    for (let k = 1; k < pieces; k++) {
      const t = k / pieces;
      samples.push({ lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) });
    }
    samples.push({ lat: b.lat, lon: b.lon });
  }
  return { samples, queryRadiusM };
}
