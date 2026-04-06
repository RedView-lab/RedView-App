import type { Map as MapboxMap } from 'mapbox-gl';
import { WindGL, type WindData } from './wind-gl';

// ── Configuration ─────────────────────────────────────────────────────

const NUM_PARTICLES = 65536; // 256 × 256 particle state texture

// ── Canvas overlay manager ────────────────────────────────────────────

export class WindCanvas {
  private map: MapboxMap;
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private windGL: WindGL;
  private animationId: number | null = null;
  private resizeObserver: ResizeObserver;
  private hasWindData = false;

  constructor(map: MapboxMap) {
    this.map = map;

    // Create a canvas that overlays the map container
    const container = map.getContainer();
    this.canvas = document.createElement('canvas');
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.pointerEvents = 'none';
    container.appendChild(this.canvas);

    // Match pixel size to display size (accounting for devicePixelRatio)
    this.syncSize();

    // Initialize WebGL
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: false })!;
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;

    // Initialize the wind particle engine
    this.windGL = new WindGL(gl);
    this.windGL.numParticles = NUM_PARTICLES;

    // Watch for container resizes
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);
  }

  /** Set the wind data and (re)start the animation */
  setWind(windData: WindData): void {
    this.windGL.setWind(windData);
    this.hasWindData = true;
    if (!this.animationId) {
      this.startAnimation();
    }
  }

  /** Stop the animation (e.g. during map pan/zoom) */
  stop(): void {
    if (this.animationId != null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  /** Resume if we have wind data */
  resume(): void {
    if (this.hasWindData && !this.animationId) {
      // Clear screen textures to avoid stale trails from old viewport
      this.windGL.resize();
      this.startAnimation();
    }
  }

  /** Fully destroy — remove canvas, release GL resources */
  destroy(): void {
    this.stop();
    this.resizeObserver.disconnect();
    this.canvas.remove();

    // Lose the GL context to free GPU resources
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }

  // ── Private ──────────────────────────────────────────────────────

  private startAnimation(): void {
    const frame = () => {
      this.windGL.draw();
      this.animationId = requestAnimationFrame(frame);
    };
    this.animationId = requestAnimationFrame(frame);
  }

  private syncSize(): void {
    const container = this.map.getContainer();
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
  }

  private handleResize(): void {
    this.syncSize();
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.windGL.resize();
  }
}
