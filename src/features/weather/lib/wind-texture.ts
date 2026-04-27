import type { WindPoint } from '../types';
import type { WindData } from './wind-gl';

// ── Configuration ─────────────────────────────────────────────────────

/** Base and high-detail wind texture resolutions (width × height pixels) */
const BASE_TEX_SIZE = 256;
const HIGH_DETAIL_TEX_SIZE = 384;
const HIGH_DETAIL_SAMPLE_COUNT = 160;

/** IDW (Inverse Distance Weighting) power parameter */
const IDW_POWER = 2;
const IDW_MIN_DIST = 0.001; // degrees — avoids division by zero

// ── Wind texture generation ───────────────────────────────────────────

function textureSizeForPointCount(pointCount: number): number {
  return pointCount >= HIGH_DETAIL_SAMPLE_COUNT ? HIGH_DETAIL_TEX_SIZE : BASE_TEX_SIZE;
}

/**
 * Build a wind field grid from sparse API points using IDW interpolation.
 *
 * The result is a square Float32Array texture with 3 floats per texel:
 *   [u, v, speed] stored directly as physical m/s values.
 *
 * This avoids the previous Uint8 encode/decode cycle which caused
 * direction instability when normalization ranges shifted between fetches.
 */
export function buildWindTexture(
  sparsePoints: WindPoint[],
  bounds: { north: number; south: number; east: number; west: number },
): WindData {
  const texSize = textureSizeForPointCount(sparsePoints.length);
  const latRange = bounds.north - bounds.south;
  const lngRange = bounds.east - bounds.west;

  if (sparsePoints.length === 0 || latRange <= 0 || lngRange <= 0) {
    return {
      image: new Float32Array(texSize * texSize * 3),
      width: texSize,
      height: texSize,
      uMin: 0,
      uMax: 0,
      vMin: 0,
      vMax: 0,
      speedMin: 0,
      speedMax: 0,
    };
  }

  const image = new Float32Array(texSize * texSize * 3);
  let uMin = Infinity,
    uMax = -Infinity,
    vMin = Infinity,
    vMax = -Infinity,
    speedMin = Infinity,
    speedMax = -Infinity;

  for (let y = 0; y < texSize; y++) {
    // Map texel y to latitude (top = north, bottom = south)
    const lat = bounds.north - (y / (texSize - 1)) * latRange;
    const cosLat = Math.cos((lat * Math.PI) / 180);

    for (let x = 0; x < texSize; x++) {
      // Map texel x to longitude (left = west, right = east)
      const lng = bounds.west + (x / (texSize - 1)) * lngRange;

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
        const rad = (p.direction * Math.PI) / 180;
        uSum += w * (-p.speed * Math.sin(rad));
        vSum += w * (-p.speed * Math.cos(rad));
        // Scalar speed interpolated separately (avoids vector cancellation)
        speedSum += w * p.speed;
      }

      const u = wSum > 0 ? uSum / wSum : 0;
      const v = wSum > 0 ? vSum / wSum : 0;
      const speed = wSum > 0 ? speedSum / wSum : 0;

      const idx = (y * texSize + x) * 3;
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
  }

  // Ensure non-zero ranges (metadata only — not used for encoding)
  if (uMin === uMax) { uMin -= 0.1; uMax += 0.1; }
  if (vMin === vMax) { vMin -= 0.1; vMax += 0.1; }
  if (speedMin === speedMax) { speedMin = Math.max(0, speedMin - 0.1); speedMax += 0.1; }

  return { image, width: texSize, height: texSize, uMin, uMax, vMin, vMax, speedMin, speedMax };
}
