import type { Map as MapboxMap } from 'mapbox-gl';
import type { WindData } from '../wind-gl';

// ── Re-export WindData so consumers don't need wind-gl directly ────────
export type { WindData };

// ── Geometry constants ─────────────────────────────────────────────────

export const LAYER_ID = 'wind-particles';
export const VERTEX_STRIDE = 7;        // x, y, z, r, g, b, a
export const VERTS_PER_ARROW = 9;      // 3 triangles: arrowhead(3) + body quad(6)
export const EQUATORIAL_CIRCUMFERENCE = 40_075_017;

// ── Arrow shape proportions ────────────────────────────────────────────

export const HEAD_LENGTH_RATIO = 0.30;
export const TAIL_TAPER = 0.45;

// ── Simulation constants ───────────────────────────────────────────────

export const MAX_DELTA_SECONDS = 0.05;
export const DIRECTION_SMOOTH = 0.22;
export const FADE_IN_RATE = 2.8;
export const WIND_BLEND_DURATION = 0.5; // seconds for prev→current crossfade

// ── Max allocation (avoids re-allocation on zoom) ──────────────────────

export const MAX_PARTICLE_ALLOC = 2000;

// ── Interfaces ─────────────────────────────────────────────────────────

export interface WindBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface ParticleProgram {
  program: WebGLProgram;
  a_position: number;
  a_color: number;
  u_matrix: WebGLUniformLocation | null;
}

export interface SavedGLState {
  blend: boolean;
  depthTest: boolean;
  stencilTest: boolean;
  scissorTest: boolean;
  cullFace: boolean;
  depthMask: boolean;
  blendSrcRgb: number;
  blendDstRgb: number;
  blendSrcAlpha: number;
  blendDstAlpha: number;
  blendEquationRgb: number;
  blendEquationAlpha: number;
  activeTexture: number;
  program: WebGLProgram | null;
  framebuffer: WebGLFramebuffer | null;
  arrayBuffer: WebGLBuffer | null;
  viewport: Int32Array;
  attribEnabled: boolean[];
  polygonOffsetFill: boolean;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
}

export interface WindSample {
  u: number;
  v: number;
  speed: number;
}

// ── Utility functions ──────────────────────────────────────────────────

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ── Adaptive parameter functions ───────────────────────────────────────
// All visual parameters are continuous functions of zoom/pitch/dpi — no
// fixed breakpoints. Inspired by Windy.com and earth.nullschool.net.

/** Particle count adapts to viewport area and zoom. Higher zoom = more arrows for density. */
export function adaptiveParticleCount(zoom: number, viewportWidthDeg: number, viewportHeightDeg: number): number {
  // Approximate viewport area in km² (at latitude ~46° for France)
  const kmPerDegLat = 111;
  const kmPerDegLng = 111 * Math.cos(46 * Math.PI / 180);
  const areaKm2 = viewportWidthDeg * kmPerDegLng * viewportHeightDeg * kmPerDegLat;
  // Target density: ~0.8 arrows per km² at zoom 8, scaling with zoom
  const zoomFactor = Math.pow(1.15, zoom - 8);
  const baseDensity = 0.8;
  const count = baseDensity * zoomFactor * Math.sqrt(areaKm2);
  return Math.round(clamp(count, 300, MAX_PARTICLE_ALLOC));
}

/** Arrow base length in screen pixels. Scales with zoom + DPI + speed contribution. */
export function adaptiveArrowLength(zoom: number, speed: number, dpr: number): number {
  const zoomT = clamp((zoom - 4) / 12, 0, 1); // 0 at z4, 1 at z16
  const basePx = lerp(16, 70, zoomT * zoomT); // quadratic curve for smoother scaling
  const speedBoost = speed * lerp(0.8, 4.0, zoomT);
  return (basePx + speedBoost) / Math.max(1, dpr * 0.75); // DPI-normalize
}

/** Arrow widths (shoulder + body half-widths) in screen pixels. */
export function adaptiveArrowWidths(zoom: number, speed: number, dpr: number): {
  shoulderHW: number;
  bodyHW: number;
} {
  const zoomT = clamp((zoom - 4) / 12, 0, 1);
  // Fast wind → narrower/longer (streamlined), slow → stubbier (like Windy)
  const speedTaper = clamp(1.0 - speed * 0.012, 0.6, 1.0);
  const shoulderHW = lerp(3.5, 14, zoomT) * speedTaper / Math.max(1, dpr * 0.75);
  const bodyHW = lerp(1.0, 4.5, zoomT) * speedTaper / Math.max(1, dpr * 0.75);
  return { shoulderHW, bodyHW };
}

/** Minimum screen-space spacing between arrows. Adapts to arrow size for uniform look. */
export function adaptiveArrowSpacing(zoom: number, dpr: number): number {
  const zoomT = clamp((zoom - 4) / 12, 0, 1);
  const basePx = lerp(40, 75, zoomT);
  return basePx / Math.max(1, dpr * 0.75);
}

/** Particle lifetime adapts to wind speed (fast = short, slow = long). */
export function adaptiveLifetime(speed: number): number {
  const t = clamp(speed / 25, 0, 1);
  return lerp(12, 4, t); // calm=12s, gale=4s
}

/** Simulation speed scale adapts to zoom. */
export function adaptiveSimulationScale(zoom: number): number {
  return clamp(130 - zoom * 6.5, 25, 100);
}

/** Pitch-aware size correction: at high pitch, arrows viewed from side appear smaller. */
export function pitchSizeCorrection(pitchDeg: number): number {
  const pitchRad = pitchDeg * Math.PI / 180;
  return 1 / Math.max(0.45, Math.cos(pitchRad));
}

/** Adaptive altitude offset to prevent terrain clipping.
 *  Accounts for zoom (metersPerPx), slope steepness, and camera pitch. */
export function adaptiveAltitudeOffset(
  map: MapboxMap,
  lng: number,
  lat: number,
  metersPerPx: number,
  arrowMeters: number,
): number {
  // Base offset: 4 screen-pixels' worth of meters — always visible
  const baseOffset = metersPerPx * 4;

  // Slope detection: sample elevation in a small cross pattern
  const delta = metersPerPx * 8 / 111_320; // ~8px in degrees
  const elev = map.queryTerrainElevation?.([lng, lat]) ?? 0;
  const elevN = map.queryTerrainElevation?.([lng, lat + delta]) ?? elev;
  const elevS = map.queryTerrainElevation?.([lng, lat - delta]) ?? elev;
  const elevE = map.queryTerrainElevation?.([lng + delta, lat]) ?? elev;
  const elevW = map.queryTerrainElevation?.([lng - delta, lat]) ?? elev;
  const slopeX = Math.abs(elevE - elevW) / (2 * delta * 111_320);
  const slopeY = Math.abs(elevN - elevS) / (2 * delta * 111_320);
  const slopeMag = Math.hypot(slopeX, slopeY); // rise/run (unitless)
  const slopeBoost = slopeMag * metersPerPx * 12; // steeper → more offset

  // Pitch factor: oblique views lose Z-buffer precision
  const pitch = map.getPitch?.() ?? 0;
  const pitchFactor = 1 + (pitch / 90) * 0.6;

  // Floor: never less than 2m or 2% of arrow length
  const floor = Math.max(2, arrowMeters * 0.02);

  return Math.max(floor, (baseOffset + slopeBoost) * pitchFactor);
}
