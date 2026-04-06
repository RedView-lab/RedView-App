import type { Map as MapboxMap } from 'mapbox-gl';
import type { AnimatedWindPoint } from '../types';
import type { DenseWindPoint } from './wind-field';
import { updateWindData } from './wind-layer';

// ── Configuration ─────────────────────────────────────────────────────

/** Animation tick rate (ms). 10 fps = 100ms. */
const TICK_MS = 100;

/**
 * Travel distance per tick at 1 m/s, in degrees.
 * Tuned so arrows visibly move but don't teleport.
 * At 10 m/s → 0.002° per tick → ~0.02°/s ≈ 2 km/s visual speed.
 */
const TRAVEL_PER_MS_PER_SPEED = 0.0002;

/** Total travel distance (degrees) before a particle resets. Zoom-adaptive. */
function travelDistance(zoom: number): number {
  // At z5 → long travel (~3°), at z14 → short travel (~0.03°)
  if (zoom <= 5) return 3.0;
  if (zoom >= 14) return 0.03;
  // Log interpolation
  return 3.0 * Math.pow(0.03 / 3.0, (zoom - 5) / (14 - 5));
}

/** Fade-in / fade-out zones as fraction of phase [0,1] */
const FADE_IN = 0.08;
const FADE_OUT = 0.08;

// ── Animator class ────────────────────────────────────────────────────

export class WindAnimator {
  private map: MapboxMap;
  private timer: ReturnType<typeof setInterval> | null = null;
  private particles: Particle[] = [];
  private zoom = 5;
  private destroyed = false;

  constructor(map: MapboxMap) {
    this.map = map;
  }

  /**
   * Set new wind field data. Resets all particle phases.
   */
  setField(field: DenseWindPoint[], zoom: number): void {
    this.zoom = zoom;
    this.particles = field.map((p) => ({
      originLat: p.lat,
      originLng: p.lng,
      speed: p.speed,
      direction: p.direction,
      gusts: p.gusts,
      phase: Math.random(), // random initial phase → staggered movement
    }));

    // Immediately render the first frame
    this.renderFrame();
  }

  /**
   * Start the animation loop.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /**
   * Stop the animation loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Clean up everything.
   */
  destroy(): void {
    this.stop();
    this.particles = [];
    this.destroyed = true;
  }

  get particleCount(): number {
    return this.particles.length;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private tick(): void {
    if (this.destroyed || this.particles.length === 0) return;

    const dt = TICK_MS;
    const travel = travelDistance(this.zoom);

    for (const p of this.particles) {
      // Advance phase proportionally to wind speed
      // Faster wind → faster phase advance → faster arrow movement
      const speedFactor = Math.max(0.3, p.speed); // minimum movement for calm wind
      const phaseAdvance = (speedFactor * TRAVEL_PER_MS_PER_SPEED * dt) / travel;
      p.phase += phaseAdvance;
      if (p.phase >= 1.0) {
        p.phase -= 1.0;
      }
    }

    this.renderFrame();
  }

  private renderFrame(): void {
    if (this.destroyed) return;

    const travel = travelDistance(this.zoom);
    const points: AnimatedWindPoint[] = new Array(this.particles.length);

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];

      // Convert meteorological direction to flow vector
      // Meteorological = where wind comes FROM, so add 180° for flow direction
      const flowDeg = p.direction + 180;
      const flowRad = (flowDeg * Math.PI) / 180;

      const offset = p.phase * travel;
      // Move along flow direction (north=0° → +lat, east=90° → +lng)
      const dLat = offset * Math.cos(flowRad);
      const dLng = offset * Math.sin(flowRad);

      // Compute opacity with fade-in/fade-out at edges
      let opacity = 0.9;
      if (p.phase < FADE_IN) {
        opacity = 0.9 * (p.phase / FADE_IN);
      } else if (p.phase > 1.0 - FADE_OUT) {
        opacity = 0.9 * ((1.0 - p.phase) / FADE_OUT);
      }

      points[i] = {
        lat: p.originLat + dLat,
        lng: p.originLng + dLng,
        speed: p.speed,
        direction: p.direction,
        gusts: p.gusts,
        opacity,
        originLat: p.originLat,
        originLng: p.originLng,
        phase: p.phase,
      };
    }

    try {
      updateWindData(this.map, points);
    } catch {
      // Map might be in an invalid state during cleanup
    }
  }
}

// ── Internal particle type ────────────────────────────────────────────

interface Particle {
  originLat: number;
  originLng: number;
  speed: number;
  direction: number;
  gusts: number;
  phase: number;
}
