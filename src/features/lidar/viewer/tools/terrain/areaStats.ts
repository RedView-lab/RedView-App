// ============================================
// Outils du viewer LiDAR — statistiques de terrain d'un polygone
// ============================================
//
// Surface en plan et réelle, périmètre et répartition pente/exposition d'une
// zone : la taille d'une zone de départ, quelle part d'un versant dépasse 35°,
// de quel côté il est tourné.

import { SLOPE_BASELINE_M, type TerrainField } from './terrainField';

export interface AreaStats {
  planAreaM2: number;
  /** Surface du sol (corrigée de la pente), m². */
  surfaceAreaM2: number;
  /** Périmètre le long du sol, m. */
  perimeterM: number;
  meanSlopeDeg: number;
  /** Part de la surface en plan du polygone à 30 / 35 / 40 / 45° ou plus. */
  shareAbove: { 30: number; 35: number; 40: number; 45: number };
  /** Exposition dominante (azimut vrai, degrés), `null` sur sol plat ou mélangé. */
  dominantAspectDeg: number | null;
  minAltitudeM: number;
  maxAltitudeM: number;
}

/** Nombre maximal d'échantillons de sol par polygone. */
const MAX_SAMPLES = 250_000;
/** Sous cette longueur résultante moyenne, les expositions sont trop mélangées pour en avoir une dominante. */
const MIN_ASPECT_CONSISTENCY = 0.35;

type PlanPoint = { projX: number; projY: number };

/** Abscisses triées où la ligne horizontale `y` coupe les arêtes (même règle que le balayage). */
function edgeCrossings(vertices: readonly PlanPoint[], y: number, out: number[]): number[] {
  out.length = 0;
  for (let k = 0; k < vertices.length; k++) {
    const a = vertices[k]!;
    const b = vertices[(k + 1) % vertices.length]!;
    if ((a.projY <= y) !== (b.projY <= y)) {
      out.push(a.projX + ((y - a.projY) / (b.projY - a.projY)) * (b.projX - a.projX));
    }
  }
  return out.sort((p, q) => p - q);
}

/**
 * Surface en plan exacte selon la règle pair-impair, celle du remplissage des
 * statistiques : un polygone qui se recoupe (« nœud papillon », sommet cliqué
 * dans le mauvais ordre) compte tous ses lobes. La formule du lacet additionne
 * des aires signées, qui s'annulent alors (H2-1, audit du 2026-10-10).
 *
 * Entre deux ordonnées d'événement consécutives (sommets et croisements
 * d'arêtes), l'ordre des arêtes coupées ne change pas : la largeur intérieure
 * est linéaire en y, donc exacte au milieu de la tranche. Les polygones sont
 * cliqués (quelques dizaines de sommets) : la recherche des croisements en
 * O(n²) est négligeable.
 */
function polygonPlanArea(vertices: readonly PlanPoint[]): number {
  const n = vertices.length;
  const events: number[] = vertices.map((v) => v.projY);
  for (let i = 0; i < n; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // arêtes voisines par le sommet 0
      const c = vertices[j]!;
      const d = vertices[(j + 1) % n]!;
      const den = (b.projX - a.projX) * (d.projY - c.projY) - (b.projY - a.projY) * (d.projX - c.projX);
      if (den === 0) continue;
      const t = ((c.projX - a.projX) * (d.projY - c.projY) - (c.projY - a.projY) * (d.projX - c.projX)) / den;
      const u = ((c.projX - a.projX) * (b.projY - a.projY) - (c.projY - a.projY) * (b.projX - a.projX)) / den;
      if (t > 0 && t < 1 && u > 0 && u < 1) events.push(a.projY + t * (b.projY - a.projY));
    }
  }
  events.sort((p, q) => p - q);
  const crossings: number[] = [];
  let area = 0;
  for (let k = 0; k + 1 < events.length; k++) {
    const y0 = events[k]!;
    const y1 = events[k + 1]!;
    if (!(y1 > y0)) continue;
    edgeCrossings(vertices, (y0 + y1) / 2, crossings);
    let width = 0;
    for (let c = 0; c + 1 < crossings.length; c += 2) width += crossings[c + 1]! - crossings[c]!;
    area += width * (y1 - y0);
  }
  return area;
}

function groundPerimeter(field: TerrainField, vertices: readonly PlanPoint[]): number | null {
  const draped = field.drape([...vertices, vertices[0]!], field.cell);
  return draped.length > 1 ? draped[draped.length - 1]!.surfaceDistanceM : null;
}

export function computeAreaStats(field: TerrainField, vertices: readonly PlanPoint[]): AreaStats | null {
  if (vertices.length < 3) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let perimeter = 0;
  for (let k = 0; k < vertices.length; k++) {
    const a = vertices[k]!;
    const b = vertices[(k + 1) % vertices.length]!;
    perimeter += Math.hypot(b.projX - a.projX, b.projY - a.projY);
    minX = Math.min(minX, a.projX); maxX = Math.max(maxX, a.projX);
    minY = Math.min(minY, a.projY); maxY = Math.max(maxY, a.projY);
  }
  const step = Math.max(field.cell, Math.sqrt(((maxX - minX) * (maxY - minY)) / MAX_SAMPLES));
  const cellArea = step * step;

  let samples = 0;
  let surface = 0;
  let slopeSum = 0;
  const above = { 30: 0, 35: 0, 40: 0, 45: 0 };
  let aspectX = 0;
  let aspectY = 0;
  let aspectWeight = 0;
  let minAlt = Infinity;
  let maxAlt = -Infinity;
  const crossings: number[] = [];

  // Remplissage par lignes de balayage : lignes d'échantillons, centres de cellules entre les croisements d'arêtes.
  for (let y = minY + step / 2; y < maxY; y += step) {
    edgeCrossings(vertices, y, crossings);
    for (let c = 0; c + 1 < crossings.length; c += 2) {
      const start = minX + Math.ceil((crossings[c]! - minX) / step - 0.5) * step + step / 2;
      for (let x = start; x < crossings[c + 1]!; x += step) {
        const altitude = field.altitudeAt(x, y);
        const slope = field.slopeAt(x, y, SLOPE_BASELINE_M);
        if (altitude == null || !slope) continue;
        samples++;
        minAlt = Math.min(minAlt, altitude);
        maxAlt = Math.max(maxAlt, altitude);
        surface += cellArea / Math.max(0.05, Math.cos((slope.slopeDeg * Math.PI) / 180));
        slopeSum += slope.slopeDeg;
        if (slope.slopeDeg >= 30) above[30]++;
        if (slope.slopeDeg >= 35) above[35]++;
        if (slope.slopeDeg >= 40) above[40]++;
        if (slope.slopeDeg >= 45) above[45]++;
        if (slope.slopeDeg >= 5) {
          const az = (slope.aspectDeg * Math.PI) / 180;
          aspectX += Math.sin(az);
          aspectY += Math.cos(az);
          aspectWeight++;
        }
      }
    }
  }
  if (samples === 0) return null;

  const planArea = polygonPlanArea(vertices);
  const consistency = aspectWeight > 0 ? Math.hypot(aspectX, aspectY) / aspectWeight : 0;
  return {
    planAreaM2: planArea,
    // Surface échantillonnée ramenée à la surface en plan exacte (les cellules du bord sont partielles).
    surfaceAreaM2: (surface / (samples * cellArea)) * planArea,
    perimeterM: groundPerimeter(field, vertices) ?? perimeter,
    meanSlopeDeg: slopeSum / samples,
    shareAbove: {
      30: above[30] / samples,
      35: above[35] / samples,
      40: above[40] / samples,
      45: above[45] / samples,
    },
    dominantAspectDeg: consistency >= MIN_ASPECT_CONSISTENCY
      ? (((Math.atan2(aspectX, aspectY) * 180) / Math.PI) + 360) % 360
      : null,
    minAltitudeM: minAlt,
    maxAltitudeM: maxAlt,
  };
}
