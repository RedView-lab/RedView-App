import type { WindPoint } from '../types';

// ── Configuration ─────────────────────────────────────────────────────

/** Target number of display arrows in the viewport */
const TARGET_ARROW_COUNT = 700;

// ── IDW (Inverse Distance Weighting) interpolation ───────────────────

const IDW_POWER = 2;
const IDW_MIN_DIST = 0.001; // degrees — avoids division by zero

interface InterpolatedWind {
  speed: number;
  /** Flow direction in degrees (meteorological, where wind comes FROM) */
  direction: number;
  gusts: number;
}

/**
 * Interpolate wind at (lat, lng) from sparse API points using IDW.
 * Direction is decomposed into u/v components then recomposed to avoid
 * the 359°↔1° averaging problem.
 */
function interpolateAt(
  lat: number,
  lng: number,
  sparsePoints: WindPoint[],
): InterpolatedWind {
  let wSum = 0;
  let uSum = 0;
  let vSum = 0;
  let speedSum = 0;
  let gustsSum = 0;

  for (const p of sparsePoints) {
    const dLat = p.lat - lat;
    const dLng = p.lng - lng;
    const dist = Math.sqrt(dLat * dLat + dLng * dLng);

    if (dist < IDW_MIN_DIST) {
      return { speed: p.speed, direction: p.direction, gusts: p.gusts };
    }

    const w = 1 / Math.pow(dist, IDW_POWER);
    wSum += w;

    // Decompose direction into u/v (mathematical convention for averaging)
    const rad = (p.direction * Math.PI) / 180;
    uSum += w * Math.sin(rad) * p.speed;
    vSum += w * Math.cos(rad) * p.speed;
    speedSum += w * p.speed;
    gustsSum += w * p.gusts;
  }

  if (wSum === 0) return { speed: 0, direction: 0, gusts: 0 };

  const uAvg = uSum / wSum;
  const vAvg = vSum / wSum;
  let dir = (Math.atan2(uAvg, vAvg) * 180) / Math.PI;
  if (dir < 0) dir += 360;

  return {
    speed: speedSum / wSum,
    direction: dir,
    gusts: gustsSum / wSum,
  };
}

// ── Dense field generation ────────────────────────────────────────────

export interface DenseWindPoint {
  lat: number;
  lng: number;
  speed: number;
  direction: number;
  gusts: number;
}

/**
 * Generate a dense field of interpolated wind points from sparse API data.
 * Returns ~TARGET_ARROW_COUNT points covering the viewport bounds.
 */
export function generateDenseField(
  sparsePoints: WindPoint[],
  bounds: { north: number; south: number; east: number; west: number },
  zoom: number,
): DenseWindPoint[] {
  if (sparsePoints.length === 0) return [];

  // Compute grid dimensions to hit target arrow count
  const latRange = bounds.north - bounds.south;
  const lngRange = bounds.east - bounds.west;

  if (latRange <= 0 || lngRange <= 0) return [];

  const aspect = lngRange / latRange;
  const nLat = Math.max(3, Math.round(Math.sqrt(TARGET_ARROW_COUNT / aspect)));
  const nLng = Math.max(3, Math.round(nLat * aspect));

  const dLat = latRange / nLat;
  const dLng = lngRange / nLng;

  // Add jitter based on zoom to make the grid look organic
  const jitterScale = Math.min(0.35, 0.1 + (14 - Math.min(zoom, 14)) * 0.02);

  const results: DenseWindPoint[] = [];

  // Deterministic pseudo-random (seeded by grid position)
  const hash = (a: number, b: number) => {
    const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return h - Math.floor(h);
  };

  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLng; j++) {
      const baseLat = bounds.south + (i + 0.5) * dLat;
      const baseLng = bounds.west + (j + 0.5) * dLng;

      // Deterministic jitter
      const jLat = (hash(i, j) - 0.5) * dLat * jitterScale;
      const jLng = (hash(j, i + 100) - 0.5) * dLng * jitterScale;

      const lat = Math.max(-90, Math.min(90, baseLat + jLat));
      const lng = Math.max(-180, Math.min(180, baseLng + jLng));

      const interp = interpolateAt(lat, lng, sparsePoints);
      results.push({
        lat,
        lng,
        speed: interp.speed,
        direction: interp.direction,
        gusts: interp.gusts,
      });
    }
  }

  console.log(`[wind] dense field: ${results.length} arrows from ${sparsePoints.length} API points`);
  return results;
}
