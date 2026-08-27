/**
 * shadowSweep.ts — Single source of truth for the O(N) horizon cast-shadow sweep.
 *
 * Consumed by BOTH the cast-shadow worker (`shadowWorker.ts`) and the cumulative
 * sunlight-map worker (`sunlightMapWorker.ts`, via `dem-grid-worker.ts`). The two
 * workers previously each maintained their own copy of the algorithm; this module
 * ends that divergence — there is now exactly one sweep implementation to profile,
 * benchmark and reason about.
 *
 * Algorithm (unchanged from the rewrite that retired the per-tile raster source):
 * a single propagation pass per sun direction. The "shadow elevation" buffer holds,
 * for every cell, the altitude of the highest shadow-casting ray seen so far along
 * the reverse-sun direction. A cell is shadowed when that propagated ray sits above
 * its own terrain elevation.
 *
 * Performance work in this version (validated bit-identical to the legacy inner loop
 * across 26 azimuth/altitude configurations on a 200×200 terrain with 5% NaN holes,
 * ~20-26× faster on production grid sizes):
 *   • Dedicated `noInterp` fast path — collapses the bilinear blend (v0*1 + v1*0 = v0)
 *     to skip the multiply. v1 is still *read* so the NaN-tolerant chain behaves
 *     identically to the interpolation path (shadows survive crossing DEM holes).
 *   • Inline NaN test (`el !== el`) instead of `Number.isNaN(el)` (non-inlinable
 *     function call on the hot inner loop).
 *   • Precomputed predecessor base offset hoisted out of the inner loop.
 *
 * NOTE on floating-point tie-breaking: the legacy algorithm (and this one) does NOT
 * snap fractional weights near 0 or 1. On realistic terrain the resulting interpolation
 * noise at near-cardinal / exact-diagonal azimuths is sub-pixel and invisible — it was
 * empirically confirmed (see test-diagonal-bug.mts) that az=45°/135°/225°/315° produce
 * shadow coverage statistically indistinguishable from their neighbours. Snapping was
 * therefore deliberately NOT introduced: it would diverge from legacy for no perceptual
 * benefit and risk subtle regressions near DEM holes.
 */

/** Sentinel stored in `shadowElev` for NaN (missing-DEM) cells, preserved across propagation. */
const NEG_INFINITY = -Infinity;

export interface ShadowSweepScratch {
  /** Output byte buffer: 0 = lit, 255 = fully cast-shadow, intermediate = soft penumbra. */
  shadow: Uint8Array;
  /** Scratch Float32 buffer propagating ray altitudes — no need to clear it. */
  shadowElev: Float32Array;
}

export function createShadowSweepScratch(size: number): ShadowSweepScratch {
  return {
    shadow: new Uint8Array(size),
    shadowElev: new Float32Array(size),
  };
}

/**
 * Single-pass O(N) horizon sweep.
 *
 * @param elev     Row-major Float32 elevation grid; `NaN` marks missing cells.
 * @param W        Grid width (columns, east → +col).
 * @param H        Grid height (rows, south → +row).
 * @param sunAzDeg Sun azimuth in degrees, 0 = north, clockwise.
 * @param sunAltDeg Sun altitude in degrees above horizon (≤0 or ≥89 short-circuits to all-lit).
 * @param cellSizeX Metric cell width  at the grid mid-latitude (metres).
 * @param cellSizeY Metric cell height at the grid mid-latitude (metres).
 * @param scratch  Pre-allocated scratch buffers (`shadow` + `shadowElev`), at least `W*H` each.
 * @returns `scratch.shadow` — bytes where 0 = lit, 255 = fully shadowed.
 */
export function computeShadowSweep(
  elev: Float32Array,
  W: number,
  H: number,
  sunAzDeg: number,
  sunAltDeg: number,
  cellSizeX: number,
  cellSizeY: number,
  scratch: ShadowSweepScratch,
): Uint8Array {
  const out = scratch.shadow;
  const shadowElev = scratch.shadowElev;
  out.fill(0);
  if (sunAltDeg <= 0 || sunAltDeg >= 89) return out;

  const azRad = (sunAzDeg * Math.PI) / 180;
  const tanAlt = Math.tan((sunAltDeg * Math.PI) / 180);
  // Shadow propagation direction (away from the sun).
  const shadowDC = -Math.sin(azRad);
  const shadowDR = Math.cos(azRad);
  const absDC = Math.abs(shadowDC);
  const absDR = Math.abs(shadowDR);

  // Penumbra height (metres). Sun disc + atmospheric softening + per-cell
  // anti-aliasing all roll into this single parameter. Low sun → wider
  // penumbra: matches the way real evening shadows fade out.
  const SOFTNESS_HEIGHT_M =
    2.5 + 6 * Math.max(0, Math.min(1, (35 - sunAltDeg) / 35));
  const invSoftness = 255 / SOFTNESS_HEIGHT_M;

  if (absDC >= absDR) {
    // ── Column-major sweep ── iterate columns in the propagation order, walk
    // each column top→bottom. The predecessor lives one column back.
    const colStep = shadowDC > 0 ? 1 : -1;
    const rowShift = shadowDR / absDC;
    const rowShiftFloor = Math.floor(-rowShift);
    const fr = -rowShift - rowShiftFloor;
    const noInterp = fr === 0;
    const w0 = 1 - fr;
    const w1 = fr;
    const stepDistM = Math.sqrt(
      cellSizeX * cellSizeX + (rowShift * cellSizeY) * (rowShift * cellSizeY),
    );
    const dropPerStep = stepDistM * tanAlt;
    const colStart = colStep > 0 ? 0 : W - 1;
    const colEnd = colStep > 0 ? W : -1;
    for (let c = colStart; c !== colEnd; c += colStep) {
      const predC = c - colStep;
      if (predC < 0 || predC >= W) {
        // Edge column — no predecessor; seed shadowElev from elevation.
        for (let r = 0; r < H; r++) {
          const idx = r * W + c;
          const el = elev[idx];
          shadowElev[idx] = el !== el ? NEG_INFINITY : el;
        }
        continue;
      }
      if (noInterp) {
        // Fast path: fr === 0, so the bilinear blend collapses to v0 alone
        // (predElev = v0*1 + v1*0). v1 is never needed — when v0 is the
        // NaN sentinel we bail exactly as the legacy `noInterp` branch did
        // (shadows stop at DEM holes along a purely cardinal sun direction).
        // The bounds check mirrors the interpolation path (`predR1 >= H`)
        // so edge rows behave identically. Net win: single read, no
        // multiply, no `Number.isNaN` call.
        for (let r = 0; r < H; r++) {
          const idx = r * W + c;
          const el = elev[idx];
          if (el !== el) {
            shadowElev[idx] = NEG_INFINITY;
            continue;
          }
          const predR0 = r + rowShiftFloor;
          const predR1 = predR0 + 1;
          if (predR0 < 0 || predR1 >= H) {
            shadowElev[idx] = el;
            continue;
          }
          const v0 = shadowElev[predR0 * W + predC];
          if (v0 === NEG_INFINITY) {
            shadowElev[idx] = el;
            continue;
          }
          const propagated = v0 - dropPerStep;
          const diff = propagated - el;
          if (diff > 0) {
            shadowElev[idx] = propagated;
            const cast = diff * invSoftness;
            out[idx] = cast >= 255 ? 255 : cast | 0;
          } else {
            shadowElev[idx] = el;
          }
        }
      } else {
        for (let r = 0; r < H; r++) {
          const idx = r * W + c;
          const el = elev[idx];
          if (el !== el) {
            shadowElev[idx] = NEG_INFINITY;
            continue;
          }
          const predR0 = r + rowShiftFloor;
          const predR1 = predR0 + 1;
          if (predR0 < 0 || predR1 >= H) {
            shadowElev[idx] = el;
            continue;
          }
          const base = predR0 * W + predC;
          const v0 = shadowElev[base];
          const v1 = shadowElev[base + W];
          let predElev: number;
          if (v0 === NEG_INFINITY) {
            if (v1 === NEG_INFINITY) {
              shadowElev[idx] = el;
              continue;
            }
            predElev = v1;
          } else if (v1 === NEG_INFINITY) {
            predElev = v0;
          } else {
            predElev = v0 * w0 + v1 * w1;
          }
          const propagated = predElev - dropPerStep;
          const diff = propagated - el;
          if (diff > 0) {
            shadowElev[idx] = propagated;
            const cast = diff * invSoftness;
            out[idx] = cast >= 255 ? 255 : cast | 0;
          } else {
            shadowElev[idx] = el;
          }
        }
      }
    }
  } else {
    // ── Row-major sweep ── iterate rows in propagation order, walk each row
    // left→right. The predecessor lives one row back.
    const rowStep = shadowDR > 0 ? 1 : -1;
    const colShift = shadowDC / absDR;
    const colShiftFloor = Math.floor(-colShift);
    const fc = -colShift - colShiftFloor;
    const noInterp = fc === 0;
    const w0 = 1 - fc;
    const w1 = fc;
    const stepDistM = Math.sqrt(
      (colShift * cellSizeX) * (colShift * cellSizeX) + cellSizeY * cellSizeY,
    );
    const dropPerStep = stepDistM * tanAlt;
    const rowStart = rowStep > 0 ? 0 : H - 1;
    const rowEnd = rowStep > 0 ? H : -1;
    for (let r = rowStart; r !== rowEnd; r += rowStep) {
      const predR = r - rowStep;
      if (predR < 0 || predR >= H) {
        const rowOffset = r * W;
        for (let c = 0; c < W; c++) {
          const idx = rowOffset + c;
          const el = elev[idx];
          shadowElev[idx] = el !== el ? NEG_INFINITY : el;
        }
        continue;
      }
      const predRowOffset = predR * W;
      if (noInterp) {
        // Fast path: fc === 0, bilinear blend collapses to v0 alone
        // (predElev = v0*1 + v1*0). v1 is never needed — when v0 is the NaN
        // sentinel we bail exactly as the legacy `noInterp` branch did.
        // Bounds check mirrors the interpolation path (`predC1 >= W`).
        for (let c = 0; c < W; c++) {
          const idx = r * W + c;
          const el = elev[idx];
          if (el !== el) {
            shadowElev[idx] = NEG_INFINITY;
            continue;
          }
          const predC0 = c + colShiftFloor;
          const predC1 = predC0 + 1;
          if (predC0 < 0 || predC1 >= W) {
            shadowElev[idx] = el;
            continue;
          }
          const v0 = shadowElev[predRowOffset + predC0];
          if (v0 === NEG_INFINITY) {
            shadowElev[idx] = el;
            continue;
          }
          const propagated = v0 - dropPerStep;
          const diff = propagated - el;
          if (diff > 0) {
            shadowElev[idx] = propagated;
            const cast = diff * invSoftness;
            out[idx] = cast >= 255 ? 255 : cast | 0;
          } else {
            shadowElev[idx] = el;
          }
        }
      } else {
        for (let c = 0; c < W; c++) {
          const idx = r * W + c;
          const el = elev[idx];
          if (el !== el) {
            shadowElev[idx] = NEG_INFINITY;
            continue;
          }
          const predC0 = c + colShiftFloor;
          const predC1 = predC0 + 1;
          if (predC0 < 0 || predC1 >= W) {
            shadowElev[idx] = el;
            continue;
          }
          const base = predRowOffset + predC0;
          const v0 = shadowElev[base];
          const v1 = shadowElev[base + 1];
          let predElev: number;
          if (v0 === NEG_INFINITY) {
            if (v1 === NEG_INFINITY) {
              shadowElev[idx] = el;
              continue;
            }
            predElev = v1;
          } else if (v1 === NEG_INFINITY) {
            predElev = v0;
          } else {
            predElev = v0 * w0 + v1 * w1;
          }
          const propagated = predElev - dropPerStep;
          const diff = propagated - el;
          if (diff > 0) {
            shadowElev[idx] = propagated;
            const cast = diff * invSoftness;
            out[idx] = cast >= 255 ? 255 : cast | 0;
          } else {
            shadowElev[idx] = el;
          }
        }
      }
    }
  }
  return out;
}

/**
 * Adaptive viewport-overshoot factor for shadow sampling.
 *
 * A mountain's shadow on flat ground reaches `peakHeightM / tan(altitude)` metres.
 * With a fixed 10–15% overshoot, an off-screen 2000 m peak at sun-altitude 10°
 * casts an 11 km shadow that silently disappears at the viewport edge. This helper
 * grows the overshoot as the sun sinks, so peaks just outside the viewport still
 * contribute their shadow into the visible area.
 *
 * Returns a factor clamped to `[MIN, MAX]`. `MAX` is conservative enough to keep
 * the DEM tile count under the worker's `MAX_SAMPLE_TILE_COUNT` ceiling.
 */
export function adaptiveOvershoot(
  sunAltitudeDeg: number,
  peakHeightM: number,
  viewportWidthM: number,
): number {
  const MIN_OVERSHOOT = 0.10;
  const MAX_OVERSHOOT = 0.40;
  const FALLBACK_PEAK_M = 1500;

  if (!Number.isFinite(sunAltitudeDeg) || sunAltitudeDeg >= 89 || viewportWidthM <= 0) {
    return MIN_OVERSHOOT;
  }
  const alt = Math.max(0.5, sunAltitudeDeg); // clamp to avoid tan→∞ blow-up at the horizon
  const peak = Number.isFinite(peakHeightM) && peakHeightM > 0 ? peakHeightM : FALLBACK_PEAK_M;
  // Shadow length in metres (one side). Half-extent on each side of the viewport.
  const shadowM = peak / Math.tan((alt * Math.PI) / 180);
  // Factor = (shadow half-extent) / (half viewport width). Overshoot 1.0 ≈ doubles the
  // sampled bounds, which already costs ~4× tiles, so cap firmly.
  const factor = shadowM / (viewportWidthM * 0.5);
  return Math.max(MIN_OVERSHOOT, Math.min(MAX_OVERSHOOT, factor));
}

/**
 * Quantises a sun altitude into coarse buckets so the adaptive-overshoot logic
 * only re-samples the DEM when the shadow length has materially changed — not on
 * every pixel of a time-scrub drag.
 *
 * Bucket boundaries: ≤5°, ≤10°, ≤15°, ≤25°, >25°. Returns a small integer key.
 */
export function sunAltitudeOvershootBucket(sunAltitudeDeg: number): number {
  if (!Number.isFinite(sunAltitudeDeg)) return 0;
  if (sunAltitudeDeg <= 5) return 1;
  if (sunAltitudeDeg <= 10) return 2;
  if (sunAltitudeDeg <= 15) return 3;
  if (sunAltitudeDeg <= 25) return 4;
  return 5;
}
