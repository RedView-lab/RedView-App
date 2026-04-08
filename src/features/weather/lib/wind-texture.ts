import type { WindPoint } from '../types';
import type { WindData } from './wind-gl';

// ── Configuration ─────────────────────────────────────────────────────

/** Resolution of the wind texture (width × height pixels) */
const TEX_SIZE = 192;

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
 *   B channel = normalized scalar speed (IDW of point speeds directly)
 *   A = 255 (opaque)
 *
 * u/v are normalized from [uMin..uMax] / [vMin..vMax] → [0..255].
 * speed is normalized from [speedMin..speedMax] → [0..255].
 * Scalar speed is interpolated independently from u/v to avoid vector
 * cancellation artifacts in rotating wind fields (cyclones, etc.).
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
      speedMin: 0,
      speedMax: 0,
    };
  }

  // First pass: compute u/v/speed at each texel via IDW, find min/max
  const grid = new Float32Array(TEX_SIZE * TEX_SIZE * 3); // [u, v, speed] per texel
  let uMin = Infinity,
    uMax = -Infinity,
    vMin = Infinity,
    vMax = -Infinity,
    speedMin = Infinity,
    speedMax = -Infinity;

  for (let y = 0; y < TEX_SIZE; y++) {
    // Map texel y to latitude (top = north, bottom = south)
    const lat = bounds.north - (y / (TEX_SIZE - 1)) * latRange;
    const cosLat = Math.cos((lat * Math.PI) / 180);

    for (let x = 0; x < TEX_SIZE; x++) {
      // Map texel x to longitude (left = west, right = east)
      const lng = bounds.west + (x / (TEX_SIZE - 1)) * lngRange;

      // IDW interpolation
      let wSum = 0;
      let uSum = 0;
      let vSum = 0;
      let speedSum = 0;

      for (const p of sparsePoints) {
        const dLat = p.lat - lat;
        const dLng = (p.lng - lng) * cosLat; // correct for longitude shrinkage
        const dist = Math.sqrt(dLat * dLat + dLng * dLng);

        if (dist < IDW_MIN_DIST) {
          // Exact match — use this point directly
          const rad = (p.direction * Math.PI) / 180;
          uSum = -p.speed * Math.sin(rad);
          vSum = -p.speed * Math.cos(rad);
          speedSum = p.speed;
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
        // Scalar speed interpolated separately (avoids vector cancellation)
        speedSum += w * p.speed;
      }

      const u = wSum > 0 ? uSum / wSum : 0;
      const v = wSum > 0 ? vSum / wSum : 0;
      const speed = wSum > 0 ? speedSum / wSum : 0;

      const idx = (y * TEX_SIZE + x) * 3;
      grid[idx] = u;
      grid[idx + 1] = v;
      grid[idx + 2] = speed;

      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
      if (speed < speedMin) speedMin = speed;
      if (speed > speedMax) speedMax = speed;
    }
  }

  // Ensure non-zero ranges (avoid division by zero)
  if (uMin === uMax) {
    uMin -= 0.1;
    uMax += 0.1;
  }
  if (vMin === vMax) {
    vMin -= 0.1;
    vMax += 0.1;
  }
  if (speedMin === speedMax) {
    speedMin = Math.max(0, speedMin - 0.1);
    speedMax += 0.1;
  }

  // Second pass: encode u/v/speed as normalized [0..255] RGBA
  const image = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  const uRange = uMax - uMin;
  const vRange = vMax - vMin;
  const speedRange = speedMax - speedMin;

  for (let i = 0; i < TEX_SIZE * TEX_SIZE; i++) {
    const u = grid[i * 3];
    const v = grid[i * 3 + 1];
    const speed = grid[i * 3 + 2];

    image[i * 4] = Math.round(((u - uMin) / uRange) * 255);           // R = normalized u
    image[i * 4 + 1] = Math.round(((v - vMin) / vRange) * 255);       // G = normalized v
    image[i * 4 + 2] = Math.round(((speed - speedMin) / speedRange) * 255); // B = normalized speed
    image[i * 4 + 3] = 255;                                            // A = opaque
  }

  return { image, width: TEX_SIZE, height: TEX_SIZE, uMin, uMax, vMin, vMax, speedMin, speedMax };
}
