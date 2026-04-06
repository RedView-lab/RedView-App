import type { WindPoint } from '../types';
import type { WindData } from './wind-gl';

// ── Configuration ─────────────────────────────────────────────────────

/** Resolution of the wind texture (width × height pixels) */
const TEX_SIZE = 128;

/** IDW (Inverse Distance Weighting) power parameter */
const IDW_POWER = 2;
const IDW_MIN_DIST = 0.001; // degrees — avoids division by zero

// ── Wind texture generation ───────────────────────────────────────────

/**
 * Build a WebGL-ready wind texture from sparse API points.
 *
 * The texture is a TEX_SIZE × TEX_SIZE RGBA image where:
 *   R channel = normalized u component (east–west wind)
 *   G channel = normalized v component (north–south wind)
 *   B, A = unused (0)
 *
 * u/v are normalized from [uMin..uMax] / [vMin..vMax] → [0..255].
 * The shader decodes them back using the returned min/max uniforms.
 */
export function buildWindTexture(
  sparsePoints: WindPoint[],
  bounds: { north: number; south: number; east: number; west: number },
): WindData {
  const latRange = bounds.north - bounds.south;
  const lngRange = bounds.east - bounds.west;

  if (sparsePoints.length === 0 || latRange <= 0 || lngRange <= 0) {
    return {
      image: new Uint8Array(TEX_SIZE * TEX_SIZE * 4),
      width: TEX_SIZE,
      height: TEX_SIZE,
      uMin: 0,
      uMax: 0,
      vMin: 0,
      vMax: 0,
    };
  }

  // First pass: compute u/v at each texel via IDW, find min/max
  const grid = new Float32Array(TEX_SIZE * TEX_SIZE * 2); // [u, v] per texel
  let uMin = Infinity,
    uMax = -Infinity,
    vMin = Infinity,
    vMax = -Infinity;

  for (let y = 0; y < TEX_SIZE; y++) {
    // Map texel y to latitude (top = north, bottom = south)
    const lat = bounds.north - (y / (TEX_SIZE - 1)) * latRange;

    for (let x = 0; x < TEX_SIZE; x++) {
      // Map texel x to longitude (left = west, right = east)
      const lng = bounds.west + (x / (TEX_SIZE - 1)) * lngRange;

      // IDW interpolation
      let wSum = 0;
      let uSum = 0;
      let vSum = 0;

      for (const p of sparsePoints) {
        const dLat = p.lat - lat;
        const dLng = p.lng - lng;
        const dist = Math.sqrt(dLat * dLat + dLng * dLng);

        if (dist < IDW_MIN_DIST) {
          // Exact match — use this point directly
          const rad = (p.direction * Math.PI) / 180;
          uSum = -p.speed * Math.sin(rad);
          vSum = -p.speed * Math.cos(rad);
          wSum = 1;
          break;
        }

        const w = 1 / Math.pow(dist, IDW_POWER);
        wSum += w;

        // Convert meteorological direction → u/v components
        // Meteorological direction = where wind comes FROM
        // u = east component of where wind GOES TO → -speed * sin(dir)
        // v = north component of where wind GOES TO → -speed * cos(dir)
        const rad = (p.direction * Math.PI) / 180;
        uSum += w * (-p.speed * Math.sin(rad));
        vSum += w * (-p.speed * Math.cos(rad));
      }

      const u = wSum > 0 ? uSum / wSum : 0;
      const v = wSum > 0 ? vSum / wSum : 0;

      const idx = (y * TEX_SIZE + x) * 2;
      grid[idx] = u;
      grid[idx + 1] = v;

      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
  }

  // Ensure non-zero range (avoid division by zero in shader)
  if (uMin === uMax) {
    uMin -= 0.1;
    uMax += 0.1;
  }
  if (vMin === vMax) {
    vMin -= 0.1;
    vMax += 0.1;
  }

  // Second pass: encode u/v as normalized [0..255] RGBA
  const image = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  const uRange = uMax - uMin;
  const vRange = vMax - vMin;

  for (let i = 0; i < TEX_SIZE * TEX_SIZE; i++) {
    const u = grid[i * 2];
    const v = grid[i * 2 + 1];

    image[i * 4] = Math.round(((u - uMin) / uRange) * 255);     // R = normalized u
    image[i * 4 + 1] = Math.round(((v - vMin) / vRange) * 255); // G = normalized v
    image[i * 4 + 2] = 0;                                        // B unused
    image[i * 4 + 3] = 255;                                      // A = opaque
  }

  return { image, width: TEX_SIZE, height: TEX_SIZE, uMin, uMax, vMin, vMax };
}
