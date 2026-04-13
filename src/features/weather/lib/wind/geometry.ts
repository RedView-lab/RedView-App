import {
  VERTEX_STRIDE, MAX_PARTICLE_ALLOC, TRAIL_LENGTH,
  VERTS_PER_SEGMENT, MAX_TRAIL_SEGMENTS,
  adaptiveTrailWidth,
} from './types';
import { interpolateColor, trailAlpha } from './color';
import type { ParticleSystem } from './particles';

// ── Trail geometry builder (NDC-based, globe-aware) ────────────────────
// Projects Mercator trail points through the Mapbox globe matrix on the CPU,
// computes perpendicular offsets in screen pixels, then outputs final NDC
// vertices. This ensures trails follow the globe curvature at any zoom level.
//
// Each trail segment = 2 triangles (quad) = 6 vertices × 7 floats.

// Scratch arrays for per-particle projected trail (avoid per-frame allocation)
const _scratchNDC = new Float32Array(MAX_PARTICLE_ALLOC * 3); // ndcX, ndcY, ndcZ per point
const _scratchScreen = new Float32Array(MAX_PARTICLE_ALLOC * 2); // screenX, screenY
const _scratchVisible = new Uint8Array(MAX_PARTICLE_ALLOC);

const DEPTH_BIAS = 0.0015;

export class TrailGeometryBuilder {
  /** Pre-allocated vertex buffer. */
  readonly vertexData = new Float32Array(
    MAX_PARTICLE_ALLOC * MAX_TRAIL_SEGMENTS * VERTS_PER_SEGMENT * VERTEX_STRIDE,
  );

  /**
   * Rebuild vertex data from current particle trail state.
   * Projects through the globe-aware matrix on CPU; outputs NDC positions.
   * Returns the total number of vertices to upload.
   */
  build(
    particles: ParticleSystem,
    matrix: Float32Array,
    canvasWidth: number,
    canvasHeight: number,
    zoom: number,
    dpr: number,
  ): number {
    const m = matrix;
    const halfW = canvasWidth * 0.5;
    const halfH = canvasHeight * 0.5;
    // Inverse half-canvas for converting screen-pixel offsets back to NDC
    const invHalfW = 1 / halfW;
    const invHalfH = 1 / halfH;

    let totalVerts = 0;

    for (let i = 0; i < particles.count; i++) {
      const count = particles.trailCount[i];
      if (count < 2) continue;

      const speed = particles.speeds[i];
      const fade = particles.fade[i];
      const lifeRatio = particles.lives[i] > 0 ? particles.ages[i] / particles.lives[i] : 0;

      // Half-width in screen pixels (no Mercator pixelScale — we're in NDC/screen space)
      const halfWidthPx = adaptiveTrailWidth(zoom, speed, dpr);

      const [cr, cg, cb, baseAlpha] = interpolateColor(speed, false);
      const rH = Math.min(1, cr + 0.15);
      const gH = Math.min(1, cg + 0.15);
      const bH = Math.min(1, cb + 0.15);

      const ringBase = i * TRAIL_LENGTH;
      const head = particles.trailHead[i];

      // ── Project all trail points through the globe matrix ──
      let visibleCount = 0;
      for (let p = 0; p < count; p++) {
        const idx = (head - count + p + TRAIL_LENGTH) % TRAIL_LENGTH;
        const mx = particles.trailX[ringBase + idx];
        const my = particles.trailY[ringBase + idx];
        const mz = particles.trailZ[ringBase + idx];

        // Matrix multiply: clip = m * vec4(mx, my, mz, 1)
        const clipW = m[3] * mx + m[7] * my + m[11] * mz + m[15];

        if (clipW <= 0.0001) {
          // Behind camera / on backface of globe → not visible
          _scratchVisible[p] = 0;
          continue;
        }

        const clipX = m[0] * mx + m[4] * my + m[8] * mz + m[12];
        const clipY = m[1] * mx + m[5] * my + m[9] * mz + m[13];
        const clipZ = m[2] * mx + m[6] * my + m[10] * mz + m[14];

        const invW = 1 / clipW;
        const ndcX = clipX * invW;
        const ndcY = clipY * invW;
        const ndcZ = clipZ * invW;

        _scratchNDC[p * 3] = ndcX;
        _scratchNDC[p * 3 + 1] = ndcY;
        _scratchNDC[p * 3 + 2] = ndcZ;

        // NDC → screen pixels
        _scratchScreen[p * 2] = (ndcX + 1) * halfW;
        _scratchScreen[p * 2 + 1] = (1 - ndcY) * halfH;

        _scratchVisible[p] = 1;
        visibleCount++;
      }

      if (visibleCount < 2) continue;

      const segments = count - 1;

      for (let s = 0; s < segments; s++) {
        if (!_scratchVisible[s] || !_scratchVisible[s + 1]) continue;

        // Screen-space positions
        const sx0 = _scratchScreen[s * 2];
        const sy0 = _scratchScreen[s * 2 + 1];
        const sx1 = _scratchScreen[(s + 1) * 2];
        const sy1 = _scratchScreen[(s + 1) * 2 + 1];

        const dsx = sx1 - sx0;
        const dsy = sy1 - sy0;
        const sLen = Math.sqrt(dsx * dsx + dsy * dsy);
        if (sLen < 0.01) continue;

        // Perpendicular direction in screen pixels
        const spx = -dsy / sLen;
        const spy = dsx / sLen;

        // Parametric position along trail: 0 = tail, 1 = head
        const t0 = s / segments;
        const t1 = (s + 1) / segments;

        // Width taper
        const w0 = halfWidthPx * (0.3 + 0.7 * smoothstep(0, 0.25, t0));
        const w1 = halfWidthPx * (0.3 + 0.7 * smoothstep(0, 0.25, t1));

        // Alpha gradient: tail→head
        const a0 = trailAlpha(t0, baseAlpha, fade, lifeRatio);
        const a1 = trailAlpha(t1, baseAlpha, fade, lifeRatio);

        // Head glow on last 10%
        const r0 = t0 > 0.9 ? rH : cr, g0 = t0 > 0.9 ? gH : cg, b0 = t0 > 0.9 ? bH : cb;
        const r1 = t1 > 0.9 ? rH : cr, g1 = t1 > 0.9 ? gH : cg, b1 = t1 > 0.9 ? bH : cb;

        // NDC center positions and depth
        const nx0 = _scratchNDC[s * 3];
        const ny0 = _scratchNDC[s * 3 + 1];
        const nz0 = _scratchNDC[s * 3 + 2] - DEPTH_BIAS;
        const nx1 = _scratchNDC[(s + 1) * 3];
        const ny1 = _scratchNDC[(s + 1) * 3 + 1];
        const nz1 = _scratchNDC[(s + 1) * 3 + 2] - DEPTH_BIAS;

        // Convert screen-pixel perpendicular offset to NDC offset
        // screenX = (ndcX + 1) * halfW → dNdcX = dScreenX / halfW
        // screenY = (1 - ndcY) * halfH → dNdcY = -dScreenY / halfH
        const offNdcX0 = spx * w0 * invHalfW;
        const offNdcY0 = -(spy * w0 * invHalfH);
        const offNdcX1 = spx * w1 * invHalfW;
        const offNdcY1 = -(spy * w1 * invHalfH);

        const off = totalVerts * VERTEX_STRIDE;

        // Triangle 1: v0L, v0R, v1L
        this.vertexData[off]      = nx0 + offNdcX0;
        this.vertexData[off + 1]  = ny0 + offNdcY0;
        this.vertexData[off + 2]  = nz0;
        this.vertexData[off + 3]  = r0; this.vertexData[off + 4] = g0; this.vertexData[off + 5] = b0;
        this.vertexData[off + 6]  = a0;

        this.vertexData[off + 7]  = nx0 - offNdcX0;
        this.vertexData[off + 8]  = ny0 - offNdcY0;
        this.vertexData[off + 9]  = nz0;
        this.vertexData[off + 10] = r0; this.vertexData[off + 11] = g0; this.vertexData[off + 12] = b0;
        this.vertexData[off + 13] = a0;

        this.vertexData[off + 14] = nx1 + offNdcX1;
        this.vertexData[off + 15] = ny1 + offNdcY1;
        this.vertexData[off + 16] = nz1;
        this.vertexData[off + 17] = r1; this.vertexData[off + 18] = g1; this.vertexData[off + 19] = b1;
        this.vertexData[off + 20] = a1;

        // Triangle 2: v0R, v1R, v1L
        this.vertexData[off + 21] = nx0 - offNdcX0;
        this.vertexData[off + 22] = ny0 - offNdcY0;
        this.vertexData[off + 23] = nz0;
        this.vertexData[off + 24] = r0; this.vertexData[off + 25] = g0; this.vertexData[off + 26] = b0;
        this.vertexData[off + 27] = a0;

        this.vertexData[off + 28] = nx1 - offNdcX1;
        this.vertexData[off + 29] = ny1 - offNdcY1;
        this.vertexData[off + 30] = nz1;
        this.vertexData[off + 31] = r1; this.vertexData[off + 32] = g1; this.vertexData[off + 33] = b1;
        this.vertexData[off + 34] = a1;

        this.vertexData[off + 35] = nx1 + offNdcX1;
        this.vertexData[off + 36] = ny1 + offNdcY1;
        this.vertexData[off + 37] = nz1;
        this.vertexData[off + 38] = r1; this.vertexData[off + 39] = g1; this.vertexData[off + 40] = b1;
        this.vertexData[off + 41] = a1;

        totalVerts += 6;
      }
    }

    return totalVerts;
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
