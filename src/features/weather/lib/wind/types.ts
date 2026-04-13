import type { Map as MapboxMap } from 'mapbox-gl';
import type { WindData } from '../wind-gl';

// ── Re-export WindData so consumers don't need wind-gl directly ────────
export type { WindData };

// ── Geometry constants ─────────────────────────────────────────────────

export const LAYER_ID = 'wind-particles';
export const VERTEX_STRIDE = 7;        // x, y, z, r, g, b, a
export const EQUATORIAL_CIRCUMFERENCE = 40_075_017;

// ── Trail geometry constants ───────────────────────────────────────────

export const TRAIL_LENGTH = 64;                        // ring buffer size per particle
export const VERTS_PER_SEGMENT = 6;                    // 2 triangles per trail segment
export const MAX_TRAIL_SEGMENTS = TRAIL_LENGTH - 1;    // = 63

// ── Simulation constants ───────────────────────────────────────────────

export const MAX_DELTA_SECONDS = 0.05;
export const DIRECTION_SMOOTH = 0.22;
export const FADE_IN_RATE = 4.5;
export const WIND_BLEND_DURATION = 1.2; // seconds for prev→current crossfade
export const DROP_RATE = 0.001;          // base random respawn probability per frame
export const DROP_RATE_BUMP = 0.001;     // additional respawn rate × speed_t

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

/** Particle count — screen-density based so coverage stays uniform at all zoom levels. */
export function adaptiveParticleCount(zoom: number, _viewportWidthDeg: number, _viewportHeightDeg: number): number {
  const zoomT = clamp((zoom - 4) / 12, 0, 1);
  return Math.round(lerp(1000, MAX_PARTICLE_ALLOC, zoomT * zoomT));
}

/** Trail half-width in screen pixels. Visible streamlines across all zooms. */
export function adaptiveTrailWidth(zoom: number, speed: number, dpr: number): number {
  const zoomT = clamp((zoom - 4) / 12, 0, 1);
  const basePx = lerp(2.0, 3.5, zoomT);
  const speedBoost = clamp(speed * 0.04, 0, 1.0);
  return (basePx + speedBoost) / Math.max(1, dpr * 0.75);
}

/** Particle lifetime adapts to wind speed (fast = short, slow = long). */
export function adaptiveLifetime(speed: number): number {
  const t = clamp(speed / 25, 0, 1);
  return lerp(16, 5, t); // calm=16s, gale=5s (longer for flowing trails)
}

/** Simulation speed scale — exponential so trails stay ~150px across all zoom levels.
 *  1_500_000 * 2^(-zoom) gives ~4.5 screen-px/frame at 60fps for 10 m/s wind. */
export function adaptiveSimulationScale(zoom: number): number {
  return clamp(1_500_000 * Math.pow(2, -zoom), 10, 50_000);
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
  // Base offset: 10 screen-pixels' worth of meters — generous clearance
  const baseOffset = metersPerPx * 10;

  // Slope detection: sample elevation in a small cross pattern
  const delta = metersPerPx * 10 / 111_320; // ~10px in degrees
  const elev = map.queryTerrainElevation?.([lng, lat]) ?? 0;
  const elevN = map.queryTerrainElevation?.([lng, lat + delta]) ?? elev;
  const elevS = map.queryTerrainElevation?.([lng, lat - delta]) ?? elev;
  const elevE = map.queryTerrainElevation?.([lng + delta, lat]) ?? elev;
  const elevW = map.queryTerrainElevation?.([lng - delta, lat]) ?? elev;
  const slopeX = Math.abs(elevE - elevW) / (2 * delta * 111_320);
  const slopeY = Math.abs(elevN - elevS) / (2 * delta * 111_320);
  const slopeMag = Math.hypot(slopeX, slopeY); // rise/run (unitless)
  const slopeBoost = slopeMag * metersPerPx * 20; // steeper → more offset

  // Pitch factor: oblique views lose Z-buffer precision
  const pitch = map.getPitch?.() ?? 0;
  const pitchFactor = 1 + (pitch / 90) * 0.8;

  // Floor: never less than 5m or 5% of arrow length
  const floor = Math.max(5, arrowMeters * 0.05);

  return Math.max(floor, (baseOffset + slopeBoost) * pitchFactor);
}
