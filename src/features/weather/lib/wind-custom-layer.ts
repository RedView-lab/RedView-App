// ── Mapbox GL Custom Layer for Wind Arrows ────────────────────────────
// Renders 3D wind arrows directly into Mapbox's GL context.
// Each particle is a terrain-following arrow oriented along the wind
// direction, with head-to-tail opacity fade and proper arrowhead shape.

import mapboxgl, { type CustomLayerInterface, type Map as MapboxMap } from 'mapbox-gl';
import type { WindData } from './wind-gl';

const LAYER_ID = 'wind-particles';
const VERTEX_STRIDE = 7; // x, y, z, r, g, b, a
const VERTS_PER_ARROW = 9; // 3 triangles: arrowhead(3) + body quad(6)
const FIXED_PARTICLE_COUNT = 1000;
const PARTICLE_ALTITUDE_OFFSET = 2;
const MAX_DELTA_SECONDS = 0.05;
const MIN_PARTICLE_LIFE = 5;
const MAX_PARTICLE_LIFE = 14;
const EQUATORIAL_CIRCUMFERENCE = 40_075_017;

// Arrow geometry proportions
const HEAD_LENGTH_RATIO = 0.32; // arrowhead is 32% of total arrow length
const SHOULDER_HW_PX = 14; // arrowhead half-width in pixels
const BODY_HW_PX = 4; // body half-width in pixels
const TAIL_TAPER = 0.5; // tail narrows to 50% of body width
const ARROW_BASE_PX = 80; // base arrow length in pixels (at 0 wind speed)
const ARROW_SPEED_SCALE = 4; // extra pixels per m/s of wind speed

// Direction temporal smoothing factor (0→1: lower = smoother)
const DIRECTION_SMOOTH = 0.25;
// Fade-in rate: particles reach full opacity in ~0.4s
const FADE_IN_RATE = 2.5;

interface WindBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

interface ParticleProgram {
  program: WebGLProgram;
  a_position: number;
  a_color: number;
  u_matrix: WebGLUniformLocation | null;
}

interface SavedGLState {
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

interface WindSample {
  u: number;
  v: number;
  speed: number;
}

const VERTEX_SHADER = `
precision highp float;

attribute vec3 a_position;
attribute vec4 a_color;

uniform mat4 u_matrix;

varying vec4 v_color;

void main() {
    gl_Position = u_matrix * vec4(a_position, 1.0);
    v_color = a_color;
}
`;

const FRAGMENT_SHADER = `
precision mediump float;

varying vec4 v_color;

void main() {
    gl_FragColor = v_color;
}
`;

const COLOR_STOPS: Array<{ speed: number; color: [number, number, number] }> = [
  { speed: 0, color: [0.25, 0.52, 0.96] },
  { speed: 3, color: [0.10, 0.75, 0.85] },
  { speed: 6, color: [0.05, 0.85, 0.35] },
  { speed: 10, color: [0.70, 0.92, 0.10] },
  { speed: 15, color: [0.98, 0.80, 0.05] },
  { speed: 20, color: [0.98, 0.45, 0.05] },
  { speed: 30, color: [0.90, 0.15, 0.12] },
  { speed: 40, color: [0.70, 0.05, 0.40] },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Unable to create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Shader compilation failed';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): ParticleProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('Unable to create GL program');

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'Program link failed';
    gl.deleteProgram(program);
    throw new Error(message);
  }

  return {
    program,
    a_position: gl.getAttribLocation(program, 'a_position'),
    a_color: gl.getAttribLocation(program, 'a_color'),
    u_matrix: gl.getUniformLocation(program, 'u_matrix'),
  };
}

function saveGLState(gl: WebGL2RenderingContext, attribs: number[]): SavedGLState {
  return {
    blend: gl.isEnabled(gl.BLEND),
    depthTest: gl.isEnabled(gl.DEPTH_TEST),
    stencilTest: gl.isEnabled(gl.STENCIL_TEST),
    scissorTest: gl.isEnabled(gl.SCISSOR_TEST),
    cullFace: gl.isEnabled(gl.CULL_FACE),
    depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
    blendSrcRgb: gl.getParameter(gl.BLEND_SRC_RGB),
    blendDstRgb: gl.getParameter(gl.BLEND_DST_RGB),
    blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA),
    blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
    blendEquationRgb: gl.getParameter(gl.BLEND_EQUATION_RGB),
    blendEquationAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA),
    activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE),
    program: gl.getParameter(gl.CURRENT_PROGRAM),
    framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING),
    arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
    viewport: gl.getParameter(gl.VIEWPORT),
    attribEnabled: attribs.map((attrib) =>
      attrib >= 0 ? Boolean(gl.getVertexAttrib(attrib, gl.VERTEX_ATTRIB_ARRAY_ENABLED)) : false,
    ),
    polygonOffsetFill: gl.isEnabled(gl.POLYGON_OFFSET_FILL),
    polygonOffsetFactor: gl.getParameter(gl.POLYGON_OFFSET_FACTOR),
    polygonOffsetUnits: gl.getParameter(gl.POLYGON_OFFSET_UNITS),
  };
}

function restoreGLState(gl: WebGL2RenderingContext, state: SavedGLState, attribs: number[]): void {
  if (state.blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
  if (state.depthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
  if (state.stencilTest) gl.enable(gl.STENCIL_TEST); else gl.disable(gl.STENCIL_TEST);
  if (state.scissorTest) gl.enable(gl.SCISSOR_TEST); else gl.disable(gl.SCISSOR_TEST);
  if (state.cullFace) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);

  gl.depthMask(state.depthMask);
  gl.blendFuncSeparate(state.blendSrcRgb, state.blendDstRgb, state.blendSrcAlpha, state.blendDstAlpha);
  gl.blendEquationSeparate(state.blendEquationRgb, state.blendEquationAlpha);
  gl.useProgram(state.program);
  gl.bindFramebuffer(gl.FRAMEBUFFER, state.framebuffer);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.arrayBuffer);
  gl.viewport(state.viewport[0], state.viewport[1], state.viewport[2], state.viewport[3]);
  gl.activeTexture(state.activeTexture);

  if (state.polygonOffsetFill) gl.enable(gl.POLYGON_OFFSET_FILL); else gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.polygonOffset(state.polygonOffsetFactor, state.polygonOffsetUnits);

  for (let index = 0; index < attribs.length; index++) {
    const attrib = attribs[index];
    if (attrib < 0) continue;
    if (state.attribEnabled[index]) {
      gl.enableVertexAttribArray(attrib);
    } else {
      gl.disableVertexAttribArray(attrib);
    }
  }
}

function interpolateColor(speed: number): [number, number, number, number] {
  if (speed <= COLOR_STOPS[0].speed) {
    const [r, g, b] = COLOR_STOPS[0].color;
    return [r, g, b, 0.75];
  }

  for (let index = 1; index < COLOR_STOPS.length; index++) {
    const left = COLOR_STOPS[index - 1];
    const right = COLOR_STOPS[index];
    if (speed <= right.speed) {
      const t = (speed - left.speed) / (right.speed - left.speed);
      return [
        lerp(left.color[0], right.color[0], t),
        lerp(left.color[1], right.color[1], t),
        lerp(left.color[2], right.color[2], t),
        clamp(0.75 + speed * 0.015, 0.75, 0.95),
      ];
    }
  }

  const [r, g, b] = COLOR_STOPS[COLOR_STOPS.length - 1].color;
  return [r, g, b, 0.95];
}

export class WindCustomLayer implements CustomLayerInterface {
  readonly id = LAYER_ID;
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;
  readonly slot = 'middle' as const;

  private map: MapboxMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: ParticleProgram | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private matrix = new Float32Array(16);

  private windData: WindData | null = null;
  private bounds: WindBounds | null = null;
  private hasWindData = false;

  private particleCount = 0;
  private particlePositions = new Float32Array(0);
  private particleAges = new Float32Array(0);
  private particleLives = new Float32Array(0);
  private particleSpeeds = new Float32Array(0);
  private particleWindU = new Float32Array(0);
  private particleWindV = new Float32Array(0);
  private particleFade = new Float32Array(0); // 0→1 fade-in to prevent flickering
  private vertexData = new Float32Array(0);

  private lastFrameTime = 0;

  // Viewport tracking for particle redistribution
  private lastViewportCenterLng = 0;
  private lastViewportCenterLat = 0;
  private lastViewportZoom = -1;

  // Wind data blending for smooth transitions (Phase 5)
  private prevWindData: WindData | null = null;
  private prevBounds: WindBounds | null = null;
  private windBlendT = 1; // 0→1 blend from prev→current
  private windBlendStart = 0;

  onAdd(map: MapboxMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    this.program = createProgram(gl);
    this.vertexBuffer = gl.createBuffer();
    if (!this.vertexBuffer) {
      throw new Error('Unable to create wind vertex buffer');
    }
  }

  prerender(_gl: WebGL2RenderingContext, _matrix: number[]): void {
    if (!this.map || !this.gl || !this.program || !this.vertexBuffer || !this.hasWindData || !this.bounds) {
      return;
    }

    // Initialize particles on first frame if needed
    if (this.particleCount === 0) {
      this.configureParticles();
    }

    // Redistribute particles when viewport changes significantly
    this.redistributeParticles();

    const now = performance.now();

    // Advance wind blend factor
    if (this.windBlendT < 1) {
      const elapsed = (now - this.windBlendStart) / 1000;
      this.windBlendT = clamp(elapsed / 0.5, 0, 1); // 0.5s blend duration
    }

    this.advanceParticles(now);
    this.rebuildVertexData();
  }

  render(gl: WebGL2RenderingContext, matrix: number[]): void {
    if (!this.program || !this.vertexBuffer || this.particleCount === 0) {
      return;
    }

    this.matrix.set(matrix);

    const attribs = [this.program.a_position, this.program.a_color];
    const savedState = saveGLState(gl, attribs);

    gl.useProgram(this.program.program);
    gl.uniformMatrix4fv(this.program.u_matrix, false, this.matrix);

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
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -1);

    gl.drawArrays(gl.TRIANGLES, 0, this.particleCount * VERTS_PER_ARROW);

    restoreGLState(gl, savedState, attribs);
    this.map?.triggerRepaint();
  }

  onRemove(_map: MapboxMap, gl: WebGL2RenderingContext): void {
    if (this.vertexBuffer) {
      gl.deleteBuffer(this.vertexBuffer);
    }
    if (this.program) {
      gl.deleteProgram(this.program.program);
    }
    this.vertexBuffer = null;
    this.program = null;
    this.gl = null;
    this.map = null;
    this.windData = null;
    this.bounds = null;
    this.hasWindData = false;
  }

  setWind(windData: WindData, bounds: WindBounds): void {
    const hadData = this.hasWindData;

    // Keep old data for smooth blending
    if (hadData && this.windData && this.bounds) {
      this.prevWindData = this.windData;
      this.prevBounds = { ...this.bounds };
      this.windBlendT = 0;
      this.windBlendStart = performance.now();
    }

    this.windData = windData;
    this.bounds = bounds;
    this.hasWindData = true;

    if (!hadData || this.particleCount === 0) {
      this.configureParticles();
    }
    // No clampParticlesToBounds needed — redistributeParticles handles viewport changes each frame

    this.map?.triggerRepaint();
  }

  private configureParticles(): void {
    if (!this.map || !this.bounds) return;

    this.particleCount = FIXED_PARTICLE_COUNT;

    this.particlePositions = new Float32Array(this.particleCount * 2);
    this.particleAges = new Float32Array(this.particleCount);
    this.particleLives = new Float32Array(this.particleCount);
    this.particleSpeeds = new Float32Array(this.particleCount);
    this.particleWindU = new Float32Array(this.particleCount);
    this.particleWindV = new Float32Array(this.particleCount);
    this.particleFade = new Float32Array(this.particleCount);
    this.vertexData = new Float32Array(this.particleCount * VERTS_PER_ARROW * VERTEX_STRIDE);

    for (let index = 0; index < this.particleCount; index++) {
      this.respawnParticle(index, true);
    }

    // Track initial viewport
    const b = this.map.getBounds();
    if (b) {
      this.lastViewportCenterLng = (b.getWest() + b.getEast()) / 2;
      this.lastViewportCenterLat = (b.getSouth() + b.getNorth()) / 2;
      this.lastViewportZoom = this.map.getZoom();
    }
  }

  /**
   * Redistribute particles when the viewport changes.
   * Particles outside the current viewport are respawned inside it with fade-in.
   * This keeps density constant regardless of zoom/pan state.
   */
  private redistributeParticles(): void {
    if (!this.map || !this.bounds || this.particleCount === 0) return;

    const b = this.map.getBounds();
    if (!b) return;

    const vpWest = b.getWest();
    const vpEast = b.getEast();
    const vpSouth = b.getSouth();
    const vpNorth = b.getNorth();
    const vpCenterLng = (vpWest + vpEast) / 2;
    const vpCenterLat = (vpSouth + vpNorth) / 2;
    const vpZoom = this.map.getZoom();

    // Check if viewport has shifted meaningfully
    const vpW = vpEast - vpWest;
    const vpH = vpNorth - vpSouth;
    if (vpW <= 0 || vpH <= 0) return;

    const shiftLng = Math.abs(vpCenterLng - this.lastViewportCenterLng) / vpW;
    const shiftLat = Math.abs(vpCenterLat - this.lastViewportCenterLat) / vpH;
    const zoomDelta = Math.abs(vpZoom - this.lastViewportZoom);

    // Only redistribute when meaningful viewport change occurred
    if (shiftLng < 0.05 && shiftLat < 0.05 && zoomDelta < 0.3) return;

    this.lastViewportCenterLng = vpCenterLng;
    this.lastViewportCenterLat = vpCenterLat;
    this.lastViewportZoom = vpZoom;

    // Small margin so particles slightly outside viewport survive
    const marginLng = vpW * 0.1;
    const marginLat = vpH * 0.1;

    for (let index = 0; index < this.particleCount; index++) {
      const posIdx = index * 2;
      const lng = this.particlePositions[posIdx];
      const lat = this.particlePositions[posIdx + 1];

      // Is particle visible in current viewport (with margin)?
      const inViewport =
        lng >= vpWest - marginLng && lng <= vpEast + marginLng &&
        lat >= vpSouth - marginLat && lat <= vpNorth + marginLat;

      if (!inViewport) {
        // Respawn inside current viewport with fade-in
        this.respawnParticleInViewport(index, vpWest, vpEast, vpSouth, vpNorth);
      }
    }
  }

  private advanceParticles(now: number): void {
    if (!this.bounds || !this.windData) return;

    if (this.lastFrameTime === 0) {
      this.lastFrameTime = now;
      return;
    }

    const deltaSeconds = clamp((now - this.lastFrameTime) / 1000, 0, MAX_DELTA_SECONDS);
    this.lastFrameTime = now;
    if (deltaSeconds <= 0) return;

    const metersPerDegreeLat = 111_320;
    const simulationScale = this.getSimulationScale();

    for (let index = 0; index < this.particleCount; index++) {
      const positionIndex = index * 2;
      let lng = this.particlePositions[positionIndex];
      let lat = this.particlePositions[positionIndex + 1];

      // Fade in newly spawned particles smoothly
      if (this.particleFade[index] < 1) {
        this.particleFade[index] = Math.min(1, this.particleFade[index] + deltaSeconds * FADE_IN_RATE);
      }

      this.particleAges[index] += deltaSeconds;
      if (this.particleAges[index] >= this.particleLives[index]) {
        this.respawnParticle(index, false);
        continue;
      }

      const wind = this.sampleWind(lng, lat);

      // Temporal smoothing: blend new wind with previous to avoid direction jitter
      const prevSpeed = this.particleSpeeds[index];
      if (prevSpeed > 0.01 && this.particleFade[index] > 0.1) {
        this.particleSpeeds[index] = lerp(prevSpeed, wind.speed, DIRECTION_SMOOTH);
        this.particleWindU[index] = lerp(this.particleWindU[index], wind.u, DIRECTION_SMOOTH);
        this.particleWindV[index] = lerp(this.particleWindV[index], wind.v, DIRECTION_SMOOTH);
      } else {
        this.particleSpeeds[index] = wind.speed;
        this.particleWindU[index] = wind.u;
        this.particleWindV[index] = wind.v;
      }

      const metersPerDegreeLng = Math.max(1, Math.cos((lat * Math.PI) / 180) * metersPerDegreeLat);
      lng += (this.particleWindU[index] * deltaSeconds * simulationScale) / metersPerDegreeLng;
      lat += (this.particleWindV[index] * deltaSeconds * simulationScale) / metersPerDegreeLat;

      if (!this.isInsideDataBounds(lng, lat) && !this.isInViewport(lng, lat)) {
        this.respawnParticle(index, false);
        continue;
      }

      this.particlePositions[positionIndex] = lng;
      this.particlePositions[positionIndex + 1] = lat;
    }
  }

  private rebuildVertexData(): void {
    if (!this.map || !this.gl || !this.vertexBuffer || this.particleCount === 0 || !this.bounds) return;

    const zoom = this.map.getZoom();
    const metersPerDegreeLat = 111_320;
    const pixelScale = 1 / (512 * Math.pow(2, zoom));

    for (let index = 0; index < this.particleCount; index++) {
      const positionIndex = index * 2;
      const lng = this.particlePositions[positionIndex];
      const lat = this.particlePositions[positionIndex + 1];
      const speed = this.particleSpeeds[index];
      const wu = this.particleWindU[index];
      const wv = this.particleWindV[index];
      const fade = this.particleFade[index];

      // Per-particle latitude correction to match advanceParticles() direction
      const cosLat = Math.cos(lat * Math.PI / 180);
      const metersPerDegreeLng = Math.max(1, cosLat * metersPerDegreeLat);
      const metersPerPx = EQUATORIAL_CIRCUMFERENCE * cosLat / (512 * Math.pow(2, zoom));

      // Arrow length in screen-pixel equivalents (bigger & longer)
      const arrowPixels = ARROW_BASE_PX + speed * ARROW_SPEED_SCALE;
      const arrowMeters = arrowPixels * metersPerPx;

      // Wind direction (default east if calm)
      const windMag = Math.hypot(wu, wv);
      let dirU = 1, dirV = 0;
      if (windMag > 0.01) {
        dirU = wu / windMag;
        dirV = wv / windMag;
      }

      // Tail position (upwind from tip) in geographic space
      const tailLng = lng - (dirU * arrowMeters) / metersPerDegreeLng;
      const tailLat = lat - (dirV * arrowMeters) / metersPerDegreeLat;

      // Neck position (where arrowhead meets body)
      const neckLng = lerp(lng, tailLng, HEAD_LENGTH_RATIO);
      const neckLat = lerp(lat, tailLat, HEAD_LENGTH_RATIO);

      // Terrain elevation at tip, neck & tail
      const tipElev = this.sampleElevation(lng, lat) + PARTICLE_ALTITUDE_OFFSET;
      const neckElev = this.sampleElevation(neckLng, neckLat) + PARTICLE_ALTITUDE_OFFSET;
      const tailElev = this.sampleElevation(tailLng, tailLat) + PARTICLE_ALTITUDE_OFFSET;

      // Mercator world-space positions
      const tipMc = mapboxgl.MercatorCoordinate.fromLngLat({ lng, lat }, tipElev);
      const neckMc = mapboxgl.MercatorCoordinate.fromLngLat({ lng: neckLng, lat: neckLat }, neckElev);
      const tailMc = mapboxgl.MercatorCoordinate.fromLngLat({ lng: tailLng, lat: tailLat }, tailElev);

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

      // Widths in Mercator units
      const shoulderHW = SHOULDER_HW_PX * pixelScale;
      const bodyHW = BODY_HW_PX * pixelScale;
      const tailHW = bodyHW * TAIL_TAPER;

      // Color with fade-in applied
      const [r, g, b, baseAlpha] = interpolateColor(speed);
      const headAlpha = baseAlpha * fade;
      const neckAlpha = baseAlpha * 0.85 * fade;
      const tailAlpha = baseAlpha * 0.15 * fade;

      const base = index * VERTS_PER_ARROW * VERTEX_STRIDE;

      // ── Triangle 1: Arrowhead (Tip → ShoulderLeft → ShoulderRight) ──

      // v0: Tip (center point)
      this.vertexData[base]      = tipMc.x;
      this.vertexData[base + 1]  = tipMc.y;
      this.vertexData[base + 2]  = tipMc.z;
      this.vertexData[base + 3]  = r;
      this.vertexData[base + 4]  = g;
      this.vertexData[base + 5]  = b;
      this.vertexData[base + 6]  = headAlpha;

      // v1: ShoulderLeft (neck position + shoulder half-width)
      this.vertexData[base + 7]  = neckMc.x + perpX * shoulderHW;
      this.vertexData[base + 8]  = neckMc.y + perpY * shoulderHW;
      this.vertexData[base + 9]  = neckMc.z;
      this.vertexData[base + 10] = r;
      this.vertexData[base + 11] = g;
      this.vertexData[base + 12] = b;
      this.vertexData[base + 13] = neckAlpha;

      // v2: ShoulderRight (neck position - shoulder half-width)
      this.vertexData[base + 14] = neckMc.x - perpX * shoulderHW;
      this.vertexData[base + 15] = neckMc.y - perpY * shoulderHW;
      this.vertexData[base + 16] = neckMc.z;
      this.vertexData[base + 17] = r;
      this.vertexData[base + 18] = g;
      this.vertexData[base + 19] = b;
      this.vertexData[base + 20] = neckAlpha;

      // ── Triangle 2: Body upper (NeckLeft → NeckRight → TailRight) ──

      // v3: NeckLeft (neck position + body half-width)
      this.vertexData[base + 21] = neckMc.x + perpX * bodyHW;
      this.vertexData[base + 22] = neckMc.y + perpY * bodyHW;
      this.vertexData[base + 23] = neckMc.z;
      this.vertexData[base + 24] = r;
      this.vertexData[base + 25] = g;
      this.vertexData[base + 26] = b;
      this.vertexData[base + 27] = neckAlpha;

      // v4: NeckRight (neck position - body half-width)
      this.vertexData[base + 28] = neckMc.x - perpX * bodyHW;
      this.vertexData[base + 29] = neckMc.y - perpY * bodyHW;
      this.vertexData[base + 30] = neckMc.z;
      this.vertexData[base + 31] = r;
      this.vertexData[base + 32] = g;
      this.vertexData[base + 33] = b;
      this.vertexData[base + 34] = neckAlpha;

      // v5: TailRight (tail position - tail half-width)
      this.vertexData[base + 35] = tailMc.x - perpX * tailHW;
      this.vertexData[base + 36] = tailMc.y - perpY * tailHW;
      this.vertexData[base + 37] = tailMc.z;
      this.vertexData[base + 38] = r;
      this.vertexData[base + 39] = g;
      this.vertexData[base + 40] = b;
      this.vertexData[base + 41] = tailAlpha;

      // ── Triangle 3: Body lower (NeckLeft → TailRight → TailLeft) ──

      // v6: NeckLeft (same as v3)
      this.vertexData[base + 42] = neckMc.x + perpX * bodyHW;
      this.vertexData[base + 43] = neckMc.y + perpY * bodyHW;
      this.vertexData[base + 44] = neckMc.z;
      this.vertexData[base + 45] = r;
      this.vertexData[base + 46] = g;
      this.vertexData[base + 47] = b;
      this.vertexData[base + 48] = neckAlpha;

      // v7: TailRight (same as v5)
      this.vertexData[base + 49] = tailMc.x - perpX * tailHW;
      this.vertexData[base + 50] = tailMc.y - perpY * tailHW;
      this.vertexData[base + 51] = tailMc.z;
      this.vertexData[base + 52] = r;
      this.vertexData[base + 53] = g;
      this.vertexData[base + 54] = b;
      this.vertexData[base + 55] = tailAlpha;

      // v8: TailLeft (tail position + tail half-width)
      this.vertexData[base + 56] = tailMc.x + perpX * tailHW;
      this.vertexData[base + 57] = tailMc.y + perpY * tailHW;
      this.vertexData[base + 58] = tailMc.z;
      this.vertexData[base + 59] = r;
      this.vertexData[base + 60] = g;
      this.vertexData[base + 61] = b;
      this.vertexData[base + 62] = tailAlpha;
    }

    const previousArrayBuffer = this.gl.getParameter(this.gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.vertexData, this.gl.DYNAMIC_DRAW);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, previousArrayBuffer);
  }

  private sampleWind(lng: number, lat: number): WindSample {
    const current = this.sampleWindFrom(lng, lat, this.windData, this.bounds);

    // Blend with previous wind data during transition
    if (this.windBlendT < 1 && this.prevWindData && this.prevBounds) {
      const prev = this.sampleWindFrom(lng, lat, this.prevWindData, this.prevBounds);
      const t = this.windBlendT;
      const u = lerp(prev.u, current.u, t);
      const v = lerp(prev.v, current.v, t);
      return { u, v, speed: lerp(prev.speed, current.speed, t) };
    }

    return current;
  }

  private sampleWindFrom(lng: number, lat: number, windData: WindData | null, bounds: WindBounds | null): WindSample {
    if (!windData || !bounds) {
      return { u: 0, v: 0, speed: 0 };
    }

    const width = windData.width;
    const height = windData.height;
    const rangeLng = bounds.east - bounds.west;
    const rangeLat = bounds.north - bounds.south;
    if (rangeLng <= 0 || rangeLat <= 0) {
      return { u: 0, v: 0, speed: 0 };
    }

    const nx = clamp((lng - bounds.west) / rangeLng, 0, 1) * (width - 1);
    const ny = clamp((bounds.north - lat) / rangeLat, 0, 1) * (height - 1);
    const x0 = Math.floor(nx);
    const y0 = Math.floor(ny);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = nx - x0;
    const ty = ny - y0;

    const topLeft = this.readWindTexelFrom(x0, y0, windData);
    const topRight = this.readWindTexelFrom(x1, y0, windData);
    const bottomLeft = this.readWindTexelFrom(x0, y1, windData);
    const bottomRight = this.readWindTexelFrom(x1, y1, windData);

    const uTop = lerp(topLeft.u, topRight.u, tx);
    const uBottom = lerp(bottomLeft.u, bottomRight.u, tx);
    const vTop = lerp(topLeft.v, topRight.v, tx);
    const vBottom = lerp(bottomLeft.v, bottomRight.v, tx);

    const u = lerp(uTop, uBottom, ty);
    const v = lerp(vTop, vBottom, ty);

    // Read scalar speed from B channel (interpolated bilinearly)
    const speedTopLeft = this.readSpeedTexelFrom(x0, y0, windData);
    const speedTopRight = this.readSpeedTexelFrom(x1, y0, windData);
    const speedBottomLeft = this.readSpeedTexelFrom(x0, y1, windData);
    const speedBottomRight = this.readSpeedTexelFrom(x1, y1, windData);
    const speedTop = lerp(speedTopLeft, speedTopRight, tx);
    const speedBottom = lerp(speedBottomLeft, speedBottomRight, tx);
    const speed = lerp(speedTop, speedBottom, ty);

    return { u, v, speed };
  }

  private readWindTexelFrom(x: number, y: number, windData: WindData): { u: number; v: number } {
    const index = (y * windData.width + x) * 4;
    const uNorm = windData.image[index] / 255;
    const vNorm = windData.image[index + 1] / 255;

    return {
      u: lerp(windData.uMin, windData.uMax, uNorm),
      v: lerp(windData.vMin, windData.vMax, vNorm),
    };
  }

  private readSpeedTexelFrom(x: number, y: number, windData: WindData): number {
    const index = (y * windData.width + x) * 4;
    const speedNorm = windData.image[index + 2] / 255;
    return lerp(windData.speedMin, windData.speedMax, speedNorm);
  }

  private sampleElevation(lng: number, lat: number): number {
    if (!this.map) return 0;
    return this.map.queryTerrainElevation([lng, lat]) ?? 0;
  }

  private respawnParticle(index: number, randomAge: boolean): void {
    // Prefer spawning within the current viewport for uniform density
    if (this.map) {
      const b = this.map.getBounds();
      if (b) {
        this.respawnParticleInViewport(index, b.getWest(), b.getEast(), b.getSouth(), b.getNorth());
        if (randomAge) {
          this.particleAges[index] = Math.random() * this.particleLives[index];
          this.particleFade[index] = Math.min(1, Math.random() + 0.3);
        }
        return;
      }
    }

    // Fallback: spawn in data bounds
    if (!this.bounds) return;
    const positionIndex = index * 2;
    this.particlePositions[positionIndex] = lerp(this.bounds.west, this.bounds.east, Math.random());
    this.particlePositions[positionIndex + 1] = lerp(this.bounds.south, this.bounds.north, Math.random());
    this.particleLives[index] = lerp(MIN_PARTICLE_LIFE, MAX_PARTICLE_LIFE, Math.random());
    this.particleAges[index] = randomAge ? Math.random() * this.particleLives[index] : 0;
    this.particleSpeeds[index] = 0;
    this.particleFade[index] = randomAge ? Math.min(1, Math.random() + 0.3) : 0;
  }

  private respawnParticleInViewport(
    index: number,
    vpWest: number, vpEast: number, vpSouth: number, vpNorth: number,
  ): void {
    const positionIndex = index * 2;
    this.particlePositions[positionIndex] = lerp(vpWest, vpEast, Math.random());
    this.particlePositions[positionIndex + 1] = lerp(vpSouth, vpNorth, Math.random());
    this.particleLives[index] = lerp(MIN_PARTICLE_LIFE, MAX_PARTICLE_LIFE, Math.random());
    this.particleAges[index] = 0;
    this.particleSpeeds[index] = 0;
    this.particleFade[index] = 0; // smooth fade-in
  }

  /** Check if position is within the wind data bounds (for texture sampling validity) */
  private isInsideDataBounds(lng: number, lat: number): boolean {
    if (!this.bounds) return false;
    return (
      lng >= this.bounds.west &&
      lng <= this.bounds.east &&
      lat >= this.bounds.south &&
      lat <= this.bounds.north
    );
  }

  /** Check if position is within the current map viewport (with 10% margin) */
  private isInViewport(lng: number, lat: number): boolean {
    if (!this.map) return false;
    const b = this.map.getBounds();
    if (!b) return false;
    const w = b.getEast() - b.getWest();
    const h = b.getNorth() - b.getSouth();
    const mLng = w * 0.1;
    const mLat = h * 0.1;
    return (
      lng >= b.getWest() - mLng && lng <= b.getEast() + mLng &&
      lat >= b.getSouth() - mLat && lat <= b.getNorth() + mLat
    );
  }

  private getSimulationScale(): number {
    if (!this.map) return 60;
    return clamp(120 - this.map.getZoom() * 6, 30, 90);
  }
}

export { LAYER_ID as WIND_LAYER_ID };
