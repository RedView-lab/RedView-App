// ============================================
// LiDAR viewer tools — terrain statistics of a polygon
// ============================================
//
// Plan and surface area, perimeter and the slope/aspect make-up of an area:
// the size of a starting zone, how much of a face is above 35°, which way
// it faces.

import { SLOPE_BASELINE_M, type TerrainField } from './terrainField';

export interface AreaStats {
  planAreaM2: number;
  /** Area of the ground surface (slope-corrected), m². */
  surfaceAreaM2: number;
  /** Perimeter along the ground, m. */
  perimeterM: number;
  meanSlopeDeg: number;
  /** Plan-area share of the polygon at or above 30 / 35 / 40 / 45°. */
  shareAbove: { 30: number; 35: number; 40: number; 45: number };
  /** Dominant aspect (true azimuth, degrees), `null` on flat or mixed ground. */
  dominantAspectDeg: number | null;
  minAltitudeM: number;
  maxAltitudeM: number;
}

/** At most this many ground samples per polygon. */
const MAX_SAMPLES = 250_000;
/** Below this mean resultant length the aspects are too mixed for a dominant one. */
const MIN_ASPECT_CONSISTENCY = 0.35;

type PlanPoint = { projX: number; projY: number };

function polygonPlanArea(vertices: readonly PlanPoint[]): number {
  let sum = 0;
  for (let k = 0; k < vertices.length; k++) {
    const a = vertices[k]!;
    const b = vertices[(k + 1) % vertices.length]!;
    sum += a.projX * b.projY - b.projX * a.projY;
  }
  return Math.abs(sum) / 2;
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

  // Scanline fill: sample rows, cell centres between edge crossings.
  for (let y = minY + step / 2; y < maxY; y += step) {
    crossings.length = 0;
    for (let k = 0; k < vertices.length; k++) {
      const a = vertices[k]!;
      const b = vertices[(k + 1) % vertices.length]!;
      if ((a.projY <= y) !== (b.projY <= y)) {
        crossings.push(a.projX + ((y - a.projY) / (b.projY - a.projY)) * (b.projX - a.projX));
      }
    }
    crossings.sort((p, q) => p - q);
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
    // Sampled surface scaled to the exact plan area (edge cells are partial).
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
