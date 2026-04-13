import type { CustomLayerInterface, Map as MapboxMap } from 'mapbox-gl';
import { LAYER_ID, VERTEX_STRIDE } from './types';
import type { WindBounds, WindData } from './types';
import { createWindProgram, saveGLState, restoreGLState } from './shaders';
import { WindSampler } from './sampler';
import { ParticleSystem } from './particles';
import { TrailGeometryBuilder } from './geometry';

// ── Mapbox GL Custom Layer for Wind Arrows ─────────────────────────────
// Thin orchestrator: composes WindSampler + ParticleSystem + ArrowGeometryBuilder.
// Owns GPU resources (program + VBO) and the Mapbox lifecycle hooks.

export class WindCustomLayer implements CustomLayerInterface {
  readonly id = LAYER_ID;
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;
  readonly slot = 'middle' as const;

  private map: MapboxMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: ReturnType<typeof createWindProgram> | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private matrix = new Float32Array(16);

  private sampler = new WindSampler();
  private particles = new ParticleSystem();
  private geometry = new TrailGeometryBuilder();
  private initialized = false;
  private vertexCount = 0;

  // ── Mapbox lifecycle ─────────────────────────────────────────────

  onAdd(map: MapboxMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    this.program = createWindProgram(gl);
    this.vertexBuffer = gl.createBuffer();
    if (!this.vertexBuffer) throw new Error('Unable to create wind vertex buffer');
  }

  prerender(_gl: WebGL2RenderingContext, matrix: number[]): void {
    if (!this.map || !this.gl || !this.program || !this.vertexBuffer || !this.sampler.hasData) return;

    const bounds = this.sampler.currentBounds!;

    // First-frame init
    if (!this.initialized) {
      this.particles.configure(this.map, bounds);
      this.initialized = true;
    }

    // Viewport redistribution
    this.particles.redistribute(this.map, bounds);

    const now = performance.now();
    this.sampler.advanceBlend(now);
    this.particles.advance(now, this.map, this.sampler, bounds);

    // Build trail geometry (NDC-based: project through globe matrix on CPU)
    this.matrix.set(matrix);
    const canvas = this.map.getCanvas();
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const center = this.map.getCenter();
    const vertexCount = this.geometry.build(
      this.particles,
      this.matrix,
      canvas.width,
      canvas.height,
      this.map.getZoom(),
      dpr,
      center.lng,
      center.lat,
    );
    this.vertexCount = vertexCount;
    if (vertexCount === 0) return;

    // Upload to GPU
    const uploadSize = vertexCount * VERTEX_STRIDE;
    const prevBuf = this.gl.getParameter(this.gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      this.geometry.vertexData.subarray(0, uploadSize),
      this.gl.DYNAMIC_DRAW,
    );
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, prevBuf);
  }

  render(gl: WebGL2RenderingContext, _matrix: number[]): void {
    if (!this.program || !this.vertexBuffer || this.vertexCount === 0) return;

    const attribs = [this.program.a_position, this.program.a_color];
    const saved = saveGLState(gl, attribs);

    gl.useProgram(this.program.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    const stride = VERTEX_STRIDE * Float32Array.BYTES_PER_ELEMENT;
    gl.enableVertexAttribArray(this.program.a_position);
    gl.vertexAttribPointer(this.program.a_position, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.program.a_color);
    gl.vertexAttribPointer(this.program.a_color, 4, gl.FLOAT, false, stride, 3 * Float32Array.BYTES_PER_ELEMENT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);

    // No polygonOffset — adaptive altitude offset handles terrain clearance properly
    gl.disable(gl.POLYGON_OFFSET_FILL);

    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);

    restoreGLState(gl, saved, attribs);
    this.map?.triggerRepaint();
  }

  onRemove(_map: MapboxMap, gl: WebGL2RenderingContext): void {
    if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
    if (this.program) gl.deleteProgram(this.program.program);
    this.vertexBuffer = null;
    this.program = null;
    this.gl = null;
    this.map = null;
    this.sampler.dispose();
    this.initialized = false;
  }

  // ── Public API ───────────────────────────────────────────────────

  setWind(windData: WindData, bounds: WindBounds): void {
    const wasEmpty = !this.sampler.hasData;
    this.sampler.setWindData(windData, bounds);

    if (wasEmpty && this.map) {
      this.particles.configure(this.map, bounds);
      this.initialized = true;
    }

    this.map?.triggerRepaint();
  }
}

export { LAYER_ID as WIND_LAYER_ID };
