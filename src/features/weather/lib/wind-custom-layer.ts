// ── Mapbox GL Custom Layer for Wind Streaks ───────────────────────────
// Renders 3D wind streaks directly into Mapbox's GL context.
// Each particle is a terrain-tangent quad oriented along the wind
// direction, with head-to-tail opacity fade.

import mapboxgl, { type CustomLayerInterface, type Map as MapboxMap } from 'mapbox-gl';
import type { WindData } from './wind-gl';

const LAYER_ID = 'wind-particles';
const VERTEX_STRIDE = 7; // x, y, z, r, g, b, a
const VERTS_PER_STREAK = 6; // 2 triangles per quad
const ELEVATION_GRID_SIZE = 56;
const MIN_PARTICLES = 4000;
const MAX_PARTICLES = 10000;
const PARTICLE_ALTITUDE_OFFSET = 4;
const MAX_DELTA_SECONDS = 0.05;
const MIN_PARTICLE_LIFE = 4;
const MAX_PARTICLE_LIFE = 11;
const ELEVATION_REFRESH_MS = 1500;
const EQUATORIAL_CIRCUMFERENCE = 40_075_017;

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
  { speed: 0, color: [0.196, 0.533, 0.741] },
  { speed: 5, color: [0.4, 0.761, 0.647] },
  { speed: 10, color: [0.671, 0.867, 0.643] },
  { speed: 20, color: [0.992, 0.878, 0.545] },
  { speed: 30, color: [0.957, 0.427, 0.263] },
  { speed: 40, color: [0.835, 0.243, 0.31] },
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
    return [r, g, b, 0.6];
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
        clamp(0.6 + speed * 0.012, 0.6, 0.95),
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
  private vertexData = new Float32Array(0);

  private elevationGrid = new Float32Array(0);
  private lastFrameTime = 0;
  private lastElevationRefresh = 0;
  private missingElevationSamples = 0;
  private lastConfiguredZoom = -1;

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

    if (Math.abs(this.map.getZoom() - this.lastConfiguredZoom) > 0.75) {
      this.configureParticles();
    }

    const now = performance.now();
    if (this.missingElevationSamples > 0 && now - this.lastElevationRefresh > ELEVATION_REFRESH_MS) {
      this.rebuildElevationGrid();
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

    gl.drawArrays(gl.TRIANGLES, 0, this.particleCount * VERTS_PER_STREAK);

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
    this.windData = windData;
    this.bounds = bounds;
    this.hasWindData = true;
    this.lastFrameTime = 0;
    this.rebuildElevationGrid();
    this.configureParticles();
    this.map?.triggerRepaint();
  }

  private configureParticles(): void {
    if (!this.map || !this.bounds) return;

    const nextCount = clamp(Math.round(3000 + this.map.getZoom() * 400), MIN_PARTICLES, MAX_PARTICLES);
    this.particleCount = nextCount;
    this.lastConfiguredZoom = this.map.getZoom();

    this.particlePositions = new Float32Array(this.particleCount * 2);
    this.particleAges = new Float32Array(this.particleCount);
    this.particleLives = new Float32Array(this.particleCount);
    this.particleSpeeds = new Float32Array(this.particleCount);
    this.particleWindU = new Float32Array(this.particleCount);
    this.particleWindV = new Float32Array(this.particleCount);
    this.vertexData = new Float32Array(this.particleCount * VERTS_PER_STREAK * VERTEX_STRIDE);

    for (let index = 0; index < this.particleCount; index++) {
      this.respawnParticle(index, true);
    }
  }

  private rebuildElevationGrid(): void {
    if (!this.map || !this.bounds) return;

    const resolution = ELEVATION_GRID_SIZE;
    const grid = new Float32Array(resolution * resolution);
    let missingCount = 0;

    for (let y = 0; y < resolution; y++) {
      const lat = lerp(this.bounds.north, this.bounds.south, y / (resolution - 1));
      for (let x = 0; x < resolution; x++) {
        const lng = lerp(this.bounds.west, this.bounds.east, x / (resolution - 1));
        const terrainElevation = this.map.queryTerrainElevation([lng, lat]);
        if (terrainElevation == null) {
          missingCount++;
        }
        grid[y * resolution + x] = terrainElevation ?? 0;
      }
    }

    this.elevationGrid = grid;
    this.missingElevationSamples = missingCount;
    this.lastElevationRefresh = performance.now();
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

      this.particleAges[index] += deltaSeconds;
      if (this.particleAges[index] >= this.particleLives[index]) {
        this.respawnParticle(index, false);
        continue;
      }

      const wind = this.sampleWind(lng, lat);
      this.particleSpeeds[index] = wind.speed;
      this.particleWindU[index] = wind.u;
      this.particleWindV[index] = wind.v;

      const metersPerDegreeLng = Math.max(1, Math.cos((lat * Math.PI) / 180) * metersPerDegreeLat);
      lng += (wind.u * deltaSeconds * simulationScale) / metersPerDegreeLng;
      lat += (wind.v * deltaSeconds * simulationScale) / metersPerDegreeLat;

      if (!this.isWithinBounds(lng, lat, 0.01)) {
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
    const centerLat = (this.bounds.north + this.bounds.south) / 2;
    const cosLat = Math.cos(centerLat * Math.PI / 180);
    const metersPerDegreeLat = 111_320;
    const metersPerDegreeLng = Math.max(1, cosLat * metersPerDegreeLat);
    const metersPerPx = EQUATORIAL_CIRCUMFERENCE * cosLat / (512 * Math.pow(2, zoom));
    const pixelScale = 1 / (512 * Math.pow(2, zoom));

    for (let index = 0; index < this.particleCount; index++) {
      const positionIndex = index * 2;
      const lng = this.particlePositions[positionIndex];
      const lat = this.particlePositions[positionIndex + 1];
      const speed = this.particleSpeeds[index];
      const wu = this.particleWindU[index];
      const wv = this.particleWindV[index];

      // Streak length & width in screen-pixel equivalents
      const streakPixels = 10 + speed * 0.5;
      const streakMeters = streakPixels * metersPerPx;
      const hwMc = 1.8 * pixelScale;

      // Wind direction (default east if calm)
      const windMag = Math.hypot(wu, wv);
      let dirU = 1, dirV = 0;
      if (windMag > 0.01) {
        dirU = wu / windMag;
        dirV = wv / windMag;
      }

      // Tail position (upwind from head) in geographic space
      const tailLng = lng - (dirU * streakMeters) / metersPerDegreeLng;
      const tailLat = lat - (dirV * streakMeters) / metersPerDegreeLat;

      // Terrain elevation at head & tail
      const headElev = this.sampleElevation(lng, lat) + PARTICLE_ALTITUDE_OFFSET;
      const tailElev = this.sampleElevation(tailLng, tailLat) + PARTICLE_ALTITUDE_OFFSET;

      // Mercator world-space positions
      const headMc = mapboxgl.MercatorCoordinate.fromLngLat({ lng, lat }, headElev);
      const tailMc = mapboxgl.MercatorCoordinate.fromLngLat({ lng: tailLng, lat: tailLat }, tailElev);

      // Perpendicular direction in Mercator XY for quad width
      const dx = headMc.x - tailMc.x;
      const dy = headMc.y - tailMc.y;
      const len2d = Math.hypot(dx, dy);

      let perpX: number, perpY: number;
      if (len2d > 1e-12) {
        perpX = (-dy / len2d) * hwMc;
        perpY = (dx / len2d) * hwMc;
      } else {
        perpX = hwMc;
        perpY = 0;
      }

      // Color (head = full, tail = faded)
      const [r, g, b, a] = interpolateColor(speed);
      const tailAlpha = a * 0.2;

      const hx = headMc.x, hy = headMc.y, hz = headMc.z;
      const tx = tailMc.x, ty = tailMc.y, tz = tailMc.z;

      // 6 vertices (2 triangles): v0-v1-v2, v0-v2-v3
      // v0 = head+perp, v1 = head-perp, v2 = tail-perp, v3 = tail+perp
      const base = index * VERTS_PER_STREAK * VERTEX_STRIDE;

      // v0: head + perp
      this.vertexData[base]      = hx + perpX;
      this.vertexData[base + 1]  = hy + perpY;
      this.vertexData[base + 2]  = hz;
      this.vertexData[base + 3]  = r;
      this.vertexData[base + 4]  = g;
      this.vertexData[base + 5]  = b;
      this.vertexData[base + 6]  = a;

      // v1: head - perp
      this.vertexData[base + 7]  = hx - perpX;
      this.vertexData[base + 8]  = hy - perpY;
      this.vertexData[base + 9]  = hz;
      this.vertexData[base + 10] = r;
      this.vertexData[base + 11] = g;
      this.vertexData[base + 12] = b;
      this.vertexData[base + 13] = a;

      // v2: tail - perp
      this.vertexData[base + 14] = tx - perpX;
      this.vertexData[base + 15] = ty - perpY;
      this.vertexData[base + 16] = tz;
      this.vertexData[base + 17] = r;
      this.vertexData[base + 18] = g;
      this.vertexData[base + 19] = b;
      this.vertexData[base + 20] = tailAlpha;

      // v0 again: head + perp
      this.vertexData[base + 21] = hx + perpX;
      this.vertexData[base + 22] = hy + perpY;
      this.vertexData[base + 23] = hz;
      this.vertexData[base + 24] = r;
      this.vertexData[base + 25] = g;
      this.vertexData[base + 26] = b;
      this.vertexData[base + 27] = a;

      // v2 again: tail - perp
      this.vertexData[base + 28] = tx - perpX;
      this.vertexData[base + 29] = ty - perpY;
      this.vertexData[base + 30] = tz;
      this.vertexData[base + 31] = r;
      this.vertexData[base + 32] = g;
      this.vertexData[base + 33] = b;
      this.vertexData[base + 34] = tailAlpha;

      // v3: tail + perp
      this.vertexData[base + 35] = tx + perpX;
      this.vertexData[base + 36] = ty + perpY;
      this.vertexData[base + 37] = tz;
      this.vertexData[base + 38] = r;
      this.vertexData[base + 39] = g;
      this.vertexData[base + 40] = b;
      this.vertexData[base + 41] = tailAlpha;
    }

    const previousArrayBuffer = this.gl.getParameter(this.gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.vertexData, this.gl.DYNAMIC_DRAW);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, previousArrayBuffer);
  }

  private sampleWind(lng: number, lat: number): WindSample {
    if (!this.windData || !this.bounds) {
      return { u: 0, v: 0, speed: 0 };
    }

    const width = this.windData.width;
    const height = this.windData.height;
    const rangeLng = this.bounds.east - this.bounds.west;
    const rangeLat = this.bounds.north - this.bounds.south;
    if (rangeLng <= 0 || rangeLat <= 0) {
      return { u: 0, v: 0, speed: 0 };
    }

    const nx = clamp((lng - this.bounds.west) / rangeLng, 0, 1) * (width - 1);
    const ny = clamp((this.bounds.north - lat) / rangeLat, 0, 1) * (height - 1);
    const x0 = Math.floor(nx);
    const y0 = Math.floor(ny);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = nx - x0;
    const ty = ny - y0;

    const topLeft = this.readWindTexel(x0, y0);
    const topRight = this.readWindTexel(x1, y0);
    const bottomLeft = this.readWindTexel(x0, y1);
    const bottomRight = this.readWindTexel(x1, y1);

    const uTop = lerp(topLeft.u, topRight.u, tx);
    const uBottom = lerp(bottomLeft.u, bottomRight.u, tx);
    const vTop = lerp(topLeft.v, topRight.v, tx);
    const vBottom = lerp(bottomLeft.v, bottomRight.v, tx);

    const u = lerp(uTop, uBottom, ty);
    const v = lerp(vTop, vBottom, ty);
    return { u, v, speed: Math.hypot(u, v) };
  }

  private readWindTexel(x: number, y: number): { u: number; v: number } {
    if (!this.windData) {
      return { u: 0, v: 0 };
    }

    const index = (y * this.windData.width + x) * 4;
    const uNorm = this.windData.image[index] / 255;
    const vNorm = this.windData.image[index + 1] / 255;

    return {
      u: lerp(this.windData.uMin, this.windData.uMax, uNorm),
      v: lerp(this.windData.vMin, this.windData.vMax, vNorm),
    };
  }

  private sampleElevation(lng: number, lat: number): number {
    if (!this.bounds || this.elevationGrid.length === 0) {
      return 0;
    }

    const resolution = ELEVATION_GRID_SIZE;
    const nx = clamp((lng - this.bounds.west) / (this.bounds.east - this.bounds.west), 0, 1) * (resolution - 1);
    const ny = clamp((this.bounds.north - lat) / (this.bounds.north - this.bounds.south), 0, 1) * (resolution - 1);
    const x0 = Math.floor(nx);
    const y0 = Math.floor(ny);
    const x1 = Math.min(resolution - 1, x0 + 1);
    const y1 = Math.min(resolution - 1, y0 + 1);
    const tx = nx - x0;
    const ty = ny - y0;

    const top = lerp(this.elevationGrid[y0 * resolution + x0], this.elevationGrid[y0 * resolution + x1], tx);
    const bottom = lerp(this.elevationGrid[y1 * resolution + x0], this.elevationGrid[y1 * resolution + x1], tx);
    return lerp(top, bottom, ty);
  }

  private respawnParticle(index: number, randomAge: boolean): void {
    if (!this.bounds) return;

    const positionIndex = index * 2;
    this.particlePositions[positionIndex] = lerp(this.bounds.west, this.bounds.east, Math.random());
    this.particlePositions[positionIndex + 1] = lerp(this.bounds.south, this.bounds.north, Math.random());
    this.particleLives[index] = lerp(MIN_PARTICLE_LIFE, MAX_PARTICLE_LIFE, Math.random());
    this.particleAges[index] = randomAge ? Math.random() * this.particleLives[index] : 0;
    this.particleSpeeds[index] = 0;
  }

  private isWithinBounds(lng: number, lat: number, marginRatio: number): boolean {
    if (!this.bounds) return false;
    const lngMargin = (this.bounds.east - this.bounds.west) * marginRatio;
    const latMargin = (this.bounds.north - this.bounds.south) * marginRatio;
    return (
      lng >= this.bounds.west - lngMargin &&
      lng <= this.bounds.east + lngMargin &&
      lat >= this.bounds.south - latMargin &&
      lat <= this.bounds.north + latMargin
    );
  }

  private getSimulationScale(): number {
    if (!this.map) return 80;
    return clamp(150 - this.map.getZoom() * 8, 40, 120);
  }
}

export { LAYER_ID as WIND_LAYER_ID };
