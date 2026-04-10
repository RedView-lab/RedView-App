import type { Map as MapboxMap } from 'mapbox-gl';
import {
  VERTEX_STRIDE, MAX_PARTICLE_ALLOC, TRAIL_LENGTH,
  VERTS_PER_SEGMENT, MAX_TRAIL_SEGMENTS,
  adaptiveTrailWidth, pitchSizeCorrection,
} from './types';
import { interpolateColor, trailAlpha } from './color';
import type { ParticleSystem } from './particles';

// ── Trail geometry builder ─────────────────────────────────────────────
// Builds flowing streamline ribbons from per-particle trail ring buffers.
// Each trail segment = 2 triangles (quad) = 6 vertices × 7 floats.
// Terrain elevation is pre-stored in the ring buffer — zero terrain queries here.

export class TrailGeometryBuilder {
  /** Pre-allocated vertex buffer. */
  readonly vertexData = new Float32Array(
    MAX_PARTICLE_ALLOC * MAX_TRAIL_SEGMENTS * VERTS_PER_SEGMENT * VERTEX_STRIDE,
  );

  /**
   * Rebuild vertex data from current particle trail state.
   * Returns the total number of vertices to upload.
   */
  build(particles: ParticleSystem, map: MapboxMap): number {
    const zoom = map.getZoom();
    const pitch = map.getPitch?.() ?? 0;
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const pixelScale = 1 / (512 * Math.pow(2, zoom));
    const pitchCorr = pitchSizeCorrection(pitch);

    let totalVerts = 0;

    for (let i = 0; i < particles.count; i++) {
      const count = particles.trailCount[i];
      if (count < 2) continue; // need at least 2 points for 1 segment

      const speed = particles.speeds[i];
      const fade = particles.fade[i];
      const lifeRatio = particles.lives[i] > 0 ? particles.ages[i] / particles.lives[i] : 0;
      const halfWidth = adaptiveTrailWidth(zoom, speed, dpr) * pitchCorr * pixelScale;

      // Color for this trail (uniform per-particle)
      const [r, g, b, baseAlpha] = interpolateColor(speed, false);
      // Head highlight color
      const rH = Math.min(1, r + 0.15);
      const gH = Math.min(1, g + 0.15);
      const bH = Math.min(1, b + 0.15);

      const ringBase = i * TRAIL_LENGTH;
      const head = particles.trailHead[i];
      const segments = count - 1;

      for (let s = 0; s < segments; s++) {
        // Ring buffer indices: oldest → newest
        const idx0 = (head - count + s + TRAIL_LENGTH) % TRAIL_LENGTH;
        const idx1 = (head - count + s + 1 + TRAIL_LENGTH) % TRAIL_LENGTH;

        // Read pre-computed Mercator coords directly (no fromLngLat overhead)
        const x0 = particles.trailX[ringBase + idx0];
        const y0 = particles.trailY[ringBase + idx0];
        const z0 = particles.trailZ[ringBase + idx0];
        const x1 = particles.trailX[ringBase + idx1];
        const y1 = particles.trailY[ringBase + idx1];
        const z1 = particles.trailZ[ringBase + idx1];

        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy);
        if (len < 1e-14) continue; // skip zero-length segments

        const perpX = -dy / len;
        const perpY = dx / len;

        // Parametric position along trail: 0 = tail, 1 = head
        const t0 = s / segments;
        const t1 = (s + 1) / segments;

        // Width taper: smoothstep from 0 at tail → full width at 30%
        const w0 = halfWidth * smoothstep(0, 0.3, t0);
        const w1 = halfWidth * smoothstep(0, 0.3, t1);

        // Alpha gradient: tail→head
        const a0 = trailAlpha(t0, baseAlpha, fade, lifeRatio);
        const a1 = trailAlpha(t1, baseAlpha, fade, lifeRatio);

        // Head glow on last 10% of trail
        const r0 = t0 > 0.9 ? rH : r, g0 = t0 > 0.9 ? gH : g, b0 = t0 > 0.9 ? bH : b;
        const r1 = t1 > 0.9 ? rH : r, g1 = t1 > 0.9 ? gH : g, b1 = t1 > 0.9 ? bH : b;

        const off = totalVerts * VERTEX_STRIDE;

        // Triangle 1: v0L, v0R, v1L
        this.vertexData[off]      = x0 + perpX * w0;
        this.vertexData[off + 1]  = y0 + perpY * w0;
        this.vertexData[off + 2]  = z0;
        this.vertexData[off + 3]  = r0; this.vertexData[off + 4] = g0; this.vertexData[off + 5] = b0;
        this.vertexData[off + 6]  = a0;

        this.vertexData[off + 7]  = x0 - perpX * w0;
        this.vertexData[off + 8]  = y0 - perpY * w0;
        this.vertexData[off + 9]  = z0;
        this.vertexData[off + 10] = r0; this.vertexData[off + 11] = g0; this.vertexData[off + 12] = b0;
        this.vertexData[off + 13] = a0;

        this.vertexData[off + 14] = x1 + perpX * w1;
        this.vertexData[off + 15] = y1 + perpY * w1;
        this.vertexData[off + 16] = z1;
        this.vertexData[off + 17] = r1; this.vertexData[off + 18] = g1; this.vertexData[off + 19] = b1;
        this.vertexData[off + 20] = a1;

        // Triangle 2: v0R, v1R, v1L
        this.vertexData[off + 21] = x0 - perpX * w0;
        this.vertexData[off + 22] = y0 - perpY * w0;
        this.vertexData[off + 23] = z0;
        this.vertexData[off + 24] = r0; this.vertexData[off + 25] = g0; this.vertexData[off + 26] = b0;
        this.vertexData[off + 27] = a0;

        this.vertexData[off + 28] = x1 - perpX * w1;
        this.vertexData[off + 29] = y1 - perpY * w1;
        this.vertexData[off + 30] = z1;
        this.vertexData[off + 31] = r1; this.vertexData[off + 32] = g1; this.vertexData[off + 33] = b1;
        this.vertexData[off + 34] = a1;

        this.vertexData[off + 35] = x1 + perpX * w1;
        this.vertexData[off + 36] = y1 + perpY * w1;
        this.vertexData[off + 37] = z1;
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
