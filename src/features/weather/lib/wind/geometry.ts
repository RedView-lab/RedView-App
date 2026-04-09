import mapboxgl, { type Map as MapboxMap } from 'mapbox-gl';
import {
  lerp,
  VERTEX_STRIDE, VERTS_PER_ARROW, MAX_PARTICLE_ALLOC,
  EQUATORIAL_CIRCUMFERENCE, HEAD_LENGTH_RATIO, TAIL_TAPER,
  adaptiveArrowLength, adaptiveArrowWidths, pitchSizeCorrection,
  adaptiveAltitudeOffset,
} from './types';
import { interpolateColor, arrowAlphaGradient } from './color';
import type { ParticleSystem } from './particles';

// ── Arrow geometry builder ─────────────────────────────────────────────
// Builds a packed Float32Array of triangle vertices from particle state.
// Each arrow = 3 triangles (arrowhead + body quad) = 9 vertices × 7 floats.
//
// Terrain clipping fix: adaptive altitude offset per-vertex that accounts
// for zoom, slope steepness, and camera pitch — no more polygonOffset hack.

export class ArrowGeometryBuilder {
  /** Pre-allocated vertex buffer (always MAX_PARTICLE_ALLOC sized). */
  readonly vertexData = new Float32Array(MAX_PARTICLE_ALLOC * VERTS_PER_ARROW * VERTEX_STRIDE);

  /**
   * Rebuild vertex data from current particle state.
   * Returns the number of vertices to upload (= visibleArrows × VERTS_PER_ARROW).
   */
  build(particles: ParticleSystem, map: MapboxMap): number {
    const zoom = map.getZoom();
    const pitch = map.getPitch?.() ?? 0;
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const metersPerDegreeLat = 111_320;
    const pixelScale = 1 / (512 * Math.pow(2, zoom));
    const pitchCorr = pitchSizeCorrection(pitch);

    let writeIndex = 0;

    for (let i = 0; i < particles.count; i++) {
      if (!particles.visible[i]) continue;

      const pi = i * 2;
      const lng = particles.positions[pi];
      const lat = particles.positions[pi + 1];
      const speed = particles.speeds[i];
      const wu = particles.windU[i];
      const wv = particles.windV[i];
      const fade = particles.fade[i];
      const lifeRatio = particles.lives[i] > 0 ? particles.ages[i] / particles.lives[i] : 0;

      const cosLat = Math.cos(lat * Math.PI / 180);
      const metersPerDegreeLng = Math.max(1, cosLat * metersPerDegreeLat);
      const metersPerPx = EQUATORIAL_CIRCUMFERENCE * cosLat / (512 * Math.pow(2, zoom));

      // ── Arrow sizing (fully adaptive) ──────────────────────────────
      const arrowPx = adaptiveArrowLength(zoom, speed, dpr) * pitchCorr;
      const arrowMeters = arrowPx * metersPerPx;

      const { shoulderHW: shoulderHwPx, bodyHW: bodyHwPx } = adaptiveArrowWidths(zoom, speed, dpr);

      // ── Arrow direction: use actual displacement when available ─────
      // Guarantees the arrow points exactly in its movement direction.
      // Falls back to wind direction for newly spawned particles.
      const du = particles.dirU[i];
      const dv = particles.dirV[i];
      const dmag = Math.hypot(du, dv);
      let dirU: number, dirV: number;
      if (dmag > 0.5) {
        dirU = du / dmag;
        dirV = dv / dmag;
      } else {
        // Fallback: wind direction (for fresh spawns with no displacement yet)
        const windMag = Math.hypot(wu, wv);
        if (windMag > 0.01) {
          dirU = wu / windMag;
          dirV = wv / windMag;
        } else {
          dirU = 1;
          dirV = 0;
        }
      }

      // Tail & neck positions in geographic space
      const tailLng = lng - (dirU * arrowMeters) / metersPerDegreeLng;
      const tailLat = lat - (dirV * arrowMeters) / metersPerDegreeLat;
      const neckLng = lerp(lng, tailLng, HEAD_LENGTH_RATIO);
      const neckLat = lerp(lat, tailLat, HEAD_LENGTH_RATIO);

      // ── Flat arrow with max-terrain elevation (anti-clip + no tilt) ─
      // Sample terrain at all key points, use the maximum, add offset.
      // This keeps the arrow perfectly flat → no perspective direction distortion.
      const rawTip  = map.queryTerrainElevation?.([lng, lat]) ?? 0;
      const rawNeck = map.queryTerrainElevation?.([neckLng, neckLat]) ?? 0;
      const rawTail = map.queryTerrainElevation?.([tailLng, tailLat]) ?? 0;
      const maxTerrain = Math.max(rawTip, rawNeck, rawTail);
      const altOffset = adaptiveAltitudeOffset(map, lng, lat, metersPerPx, arrowMeters);
      const arrowElev = maxTerrain + altOffset;

      // Mercator world-space positions (all at same elevation → flat arrow)
      const tipMc = mapboxgl.MercatorCoordinate.fromLngLat({ lng, lat }, arrowElev);
      const neckMc = mapboxgl.MercatorCoordinate.fromLngLat({ lng: neckLng, lat: neckLat }, arrowElev);
      const tailMc = mapboxgl.MercatorCoordinate.fromLngLat({ lng: tailLng, lat: tailLat }, arrowElev);

      // Perpendicular direction in Mercator XY
      const dx = tipMc.x - tailMc.x;
      const dy = tipMc.y - tailMc.y;
      const len2d = Math.hypot(dx, dy);
      let perpX: number, perpY: number;
      if (len2d > 1e-12) {
        perpX = -dy / len2d;
        perpY = dx / len2d;
      } else {
        perpX = 1;
        perpY = 0;
      }

      // Widths in Mercator units (pitch-corrected)
      const shoulderHW = shoulderHwPx * pitchCorr * pixelScale;
      const bodyHW = bodyHwPx * pitchCorr * pixelScale;
      const tailHW = bodyHW * TAIL_TAPER;

      // ── Color with Nullschool-style bright tip ─────────────────────
      const [r, g, b, baseAlpha] = interpolateColor(speed, true);
      const [rBody, gBody, bBody] = interpolateColor(speed, false);
      const { headAlpha, neckAlpha, tailAlpha } = arrowAlphaGradient(baseAlpha, fade, lifeRatio);

      const base = writeIndex * VERTS_PER_ARROW * VERTEX_STRIDE;

      // ── Triangle 1: Arrowhead (Tip → ShoulderL → ShoulderR) ───────

      // v0: Tip (bright highlight)
      this.vertexData[base]      = tipMc.x;
      this.vertexData[base + 1]  = tipMc.y;
      this.vertexData[base + 2]  = tipMc.z;
      this.vertexData[base + 3]  = r;
      this.vertexData[base + 4]  = g;
      this.vertexData[base + 5]  = b;
      this.vertexData[base + 6]  = headAlpha;

      // v1: ShoulderLeft
      this.vertexData[base + 7]  = neckMc.x + perpX * shoulderHW;
      this.vertexData[base + 8]  = neckMc.y + perpY * shoulderHW;
      this.vertexData[base + 9]  = neckMc.z;
      this.vertexData[base + 10] = rBody;
      this.vertexData[base + 11] = gBody;
      this.vertexData[base + 12] = bBody;
      this.vertexData[base + 13] = neckAlpha;

      // v2: ShoulderRight
      this.vertexData[base + 14] = neckMc.x - perpX * shoulderHW;
      this.vertexData[base + 15] = neckMc.y - perpY * shoulderHW;
      this.vertexData[base + 16] = neckMc.z;
      this.vertexData[base + 17] = rBody;
      this.vertexData[base + 18] = gBody;
      this.vertexData[base + 19] = bBody;
      this.vertexData[base + 20] = neckAlpha;

      // ── Triangle 2: Body upper (NeckL → NeckR → TailR) ────────────

      // v3: NeckLeft
      this.vertexData[base + 21] = neckMc.x + perpX * bodyHW;
      this.vertexData[base + 22] = neckMc.y + perpY * bodyHW;
      this.vertexData[base + 23] = neckMc.z;
      this.vertexData[base + 24] = rBody;
      this.vertexData[base + 25] = gBody;
      this.vertexData[base + 26] = bBody;
      this.vertexData[base + 27] = neckAlpha;

      // v4: NeckRight
      this.vertexData[base + 28] = neckMc.x - perpX * bodyHW;
      this.vertexData[base + 29] = neckMc.y - perpY * bodyHW;
      this.vertexData[base + 30] = neckMc.z;
      this.vertexData[base + 31] = rBody;
      this.vertexData[base + 32] = gBody;
      this.vertexData[base + 33] = bBody;
      this.vertexData[base + 34] = neckAlpha;

      // v5: TailRight
      this.vertexData[base + 35] = tailMc.x - perpX * tailHW;
      this.vertexData[base + 36] = tailMc.y - perpY * tailHW;
      this.vertexData[base + 37] = tailMc.z;
      this.vertexData[base + 38] = rBody;
      this.vertexData[base + 39] = gBody;
      this.vertexData[base + 40] = bBody;
      this.vertexData[base + 41] = tailAlpha;

      // ── Triangle 3: Body lower (NeckL → TailR → TailL) ────────────

      // v6: NeckLeft (duplicate)
      this.vertexData[base + 42] = neckMc.x + perpX * bodyHW;
      this.vertexData[base + 43] = neckMc.y + perpY * bodyHW;
      this.vertexData[base + 44] = neckMc.z;
      this.vertexData[base + 45] = rBody;
      this.vertexData[base + 46] = gBody;
      this.vertexData[base + 47] = bBody;
      this.vertexData[base + 48] = neckAlpha;

      // v7: TailRight (duplicate)
      this.vertexData[base + 49] = tailMc.x - perpX * tailHW;
      this.vertexData[base + 50] = tailMc.y - perpY * tailHW;
      this.vertexData[base + 51] = tailMc.z;
      this.vertexData[base + 52] = rBody;
      this.vertexData[base + 53] = gBody;
      this.vertexData[base + 54] = bBody;
      this.vertexData[base + 55] = tailAlpha;

      // v8: TailLeft
      this.vertexData[base + 56] = tailMc.x + perpX * tailHW;
      this.vertexData[base + 57] = tailMc.y + perpY * tailHW;
      this.vertexData[base + 58] = tailMc.z;
      this.vertexData[base + 59] = rBody;
      this.vertexData[base + 60] = gBody;
      this.vertexData[base + 61] = bBody;
      this.vertexData[base + 62] = tailAlpha;

      writeIndex++;
    }

    return writeIndex * VERTS_PER_ARROW;
  }
}
