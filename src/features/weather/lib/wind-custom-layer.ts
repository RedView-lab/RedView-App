// ── Mapbox GL Custom Layer for Wind Particles ─────────────────────────
// Renders WebGL wind particles directly into Mapbox's GL context.
// With renderingMode '2d', Mapbox automatically drapes the output
// onto the 3D terrain surface — particles follow the terrain contours.

import type { Map as MapboxMap, CustomLayerInterface } from 'mapbox-gl';
import { WindGL, type WindData } from './wind-gl';

// ── Configuration ─────────────────────────────────────────────────────

const NUM_PARTICLES = 65536; // 256 × 256 particle state texture
const LAYER_ID = 'wind-particles';

// ── Custom Layer ──────────────────────────────────────────────────────

export class WindCustomLayer implements CustomLayerInterface {
  readonly id = LAYER_ID;
  readonly type = 'custom' as const;
  /** '2d' → Mapbox drapes our output onto the terrain mesh automatically */
  readonly renderingMode = '2d' as const;

  private map: MapboxMap | null = null;
  private windGL: WindGL | null = null;
  private hasWindData = false;
  private lastCanvasW = 0;
  private lastCanvasH = 0;

  // ── CustomLayerInterface lifecycle ──────────────────────────────

  onAdd(map: MapboxMap, gl: WebGLRenderingContext): void {
    this.map = map;

    this.windGL = new WindGL(gl);
    this.windGL.numParticles = NUM_PARTICLES;

    // Initial trail FBO size
    this.lastCanvasW = gl.canvas.width;
    this.lastCanvasH = gl.canvas.height;
    this.windGL.resize(this.lastCanvasW, this.lastCanvasH);
  }

  prerender(gl: WebGLRenderingContext, _matrix: number[]): void {
    if (!this.windGL || !this.hasWindData) return;

    // Resize trail FBOs if canvas dimensions changed
    const w = gl.canvas.width;
    const h = gl.canvas.height;
    if (w !== this.lastCanvasW || h !== this.lastCanvasH) {
      this.lastCanvasW = w;
      this.lastCanvasH = h;
      this.windGL.resize(w, h);
    }

    // Update particle positions (offscreen FBO pass)
    this.windGL.prerender();
  }

  render(gl: WebGLRenderingContext, _matrix: number[]): void {
    if (!this.windGL || !this.hasWindData) return;

    // Draw the trail texture into Mapbox's current framebuffer
    this.windGL.render();

    // Request continuous repaints for animation
    this.map?.triggerRepaint();
  }

  onRemove(_map: MapboxMap, _gl: WebGLRenderingContext): void {
    this.windGL?.dispose();
    this.windGL = null;
    this.map = null;
    this.hasWindData = false;
  }

  // ── Public API (called from wind-layer.ts) ──────────────────────

  setWind(windData: WindData): void {
    if (!this.windGL) return;
    this.windGL.setWind(windData);
    this.hasWindData = true;
    this.map?.triggerRepaint();
  }
}

export { LAYER_ID as WIND_LAYER_ID };
