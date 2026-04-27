import type { WindGridDefinition, WindPoint } from '../types';
import type { WindData } from './wind-gl';

// ── Configuration ─────────────────────────────────────────────────────

// ── Wind texture generation ───────────────────────────────────────────

function toWindComponents(point: WindPoint): { u: number; v: number; speed: number } {
  const rad = (point.direction * Math.PI) / 180;
  return {
    u: -point.speed * Math.sin(rad),
    v: -point.speed * Math.cos(rad),
    speed: point.speed,
  };
}

/**
 * Build a wind texture directly from a regular gridded wind field.
 *
 * The result is a Float32Array texture with 3 floats per texel:
 *   [u, v, speed] stored directly as physical m/s values.
 */
export function buildWindTexture(
  grid: WindGridDefinition,
  points: WindPoint[],
): WindData {
  const width = Math.max(1, grid.cols);
  const height = Math.max(1, grid.rows);

  if (points.length === 0 || grid.rows <= 0 || grid.cols <= 0) {
    return {
      image: new Float32Array(width * height * 3),
      width,
      height,
      uMin: 0,
      uMax: 0,
      vMin: 0,
      vMax: 0,
      speedMin: 0,
      speedMax: 0,
    };
  }

  const image = new Float32Array(width * height * 3);
  let uMin = Infinity,
    uMax = -Infinity,
    vMin = Infinity,
    vMax = -Infinity,
    speedMin = Infinity,
    speedMax = -Infinity;

  for (let index = 0; index < width * height; index += 1) {
      const point = points[index];
      const { u, v, speed } = point ? toWindComponents(point) : { u: 0, v: 0, speed: 0 };
      const idx = index * 3;
      image[idx] = u;
      image[idx + 1] = v;
      image[idx + 2] = speed;

      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
      if (speed < speedMin) speedMin = speed;
      if (speed > speedMax) speedMax = speed;
  }

  // Ensure non-zero ranges (metadata only — not used for encoding)
  if (uMin === uMax) { uMin -= 0.1; uMax += 0.1; }
  if (vMin === vMax) { vMin -= 0.1; vMax += 0.1; }
  if (speedMin === speedMax) { speedMin = Math.max(0, speedMin - 0.1); speedMax += 0.1; }

  return { image, width, height, uMin, uMax, vMin, vMax, speedMin, speedMax };
}
