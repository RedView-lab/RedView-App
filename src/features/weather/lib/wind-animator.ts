import type { Map as MapboxMap } from 'mapbox-gl';
import type { AnimatedWindPoint } from '../types';
import type { DenseWindPoint } from './wind-field';
import { updateWindData } from './wind-layer';

// ── Configuration ─────────────────────────────────────────────────────

/** Animation tick rate. Slower than before to avoid visible symbol re-placement. */
const TICK_MS = 200;

/** Full back-and-forth cycle duration for moderate wind. */
const BASE_CYCLE_MS = 12_000;

/** Base opacity is constant to avoid clignotement from fade zones. */
const BASE_OPACITY = 0.92;

function phaseStep(speed: number): number {
  const speedFactor = Math.min(1.1, Math.max(0.35, speed / 12));
  return ((Math.PI * 2) / BASE_CYCLE_MS) * TICK_MS * speedFactor;
}

function motionAmplitude(zoom: number, speed: number): number {
  // Keep motion very subtle when zoomed in, broader when zoomed out.
  const minAmplitude = 0.00018;
  const maxAmplitude = 0.18;

  let zoomAmplitude = maxAmplitude;
  if (zoom >= 16) {
    zoomAmplitude = minAmplitude;
  } else if (zoom > 5) {
    const t = (zoom - 5) / (16 - 5);
    zoomAmplitude = maxAmplitude * Math.pow(minAmplitude / maxAmplitude, t);
  }

  const speedFactor = Math.min(1.15, Math.max(0.55, speed / 10));
  return zoomAmplitude * speedFactor;
}

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
      phase: Math.random() * Math.PI * 2,
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

    for (const p of this.particles) {
      p.phase += phaseStep(p.speed);
      if (p.phase >= Math.PI * 2) {
        p.phase -= Math.PI * 2;
      }
    }

    this.renderFrame();
  }

  private renderFrame(): void {
    if (this.destroyed) return;

    const points: AnimatedWindPoint[] = new Array(this.particles.length);

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];

      // Convert meteorological direction to flow vector
      // Meteorological = where wind comes FROM, so add 180° for flow direction
      const flowDeg = p.direction + 180;
      const flowRad = (flowDeg * Math.PI) / 180;

      // Slow oscillation along the wind vector. This keeps the field alive
      // without particle resets that cause visible blinking in symbol layers.
      const offset = Math.sin(p.phase) * motionAmplitude(this.zoom, p.speed);

      // Move along flow direction (north=0° → +lat, east=90° → +lng)
      const dLat = offset * Math.cos(flowRad);
      const dLng = offset * Math.sin(flowRad);

      points[i] = {
        lat: p.originLat + dLat,
        lng: p.originLng + dLng,
        speed: p.speed,
        direction: p.direction,
        gusts: p.gusts,
        opacity: BASE_OPACITY,
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
