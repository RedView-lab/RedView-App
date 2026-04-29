import type { CustomLayerInterface, Map as MapboxMap } from 'mapbox-gl';
import mapboxgl from 'mapbox-gl';

export const SUN_RAY_LAYER_ID = 'sun-ray';

const VERT = `
precision highp float;
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;

varying vec2 v_uv;

uniform vec2 u_anchor;
uniform vec2 u_source;
uniform float u_intensity;
uniform float u_aspect;
uniform vec3 u_color;

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
  return length(pa - ba * h);
}

float segmentT(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
}

void main() {
  vec2 uv = v_uv;
  vec2 anchor = u_anchor;
  vec2 source = u_source;

  vec2 p = uv;
  vec2 a = anchor;
  vec2 b = source;

  p.x *= u_aspect;
  a.x *= u_aspect;
  b.x *= u_aspect;

  float distLine = sdSegment(p, a, b);
  float rayT = segmentT(p, b, a);
  float lineCore = smoothstep(0.0028, 0.0009, distLine);
  float lineGlow = exp(-distLine * 82.0) * 0.16;
  float lineAlpha = (lineCore * 0.92 + lineGlow) * mix(0.55, 1.0, rayT);

  float anchorDist = length(p - a);
  float ring = smoothstep(0.025, 0.022, anchorDist) - smoothstep(0.016, 0.013, anchorDist);
  float impact = smoothstep(0.007, 0.0028, anchorDist);
  float halo = exp(-anchorDist * 42.0) * 0.09;

  float alpha = (lineAlpha + ring * 0.6 + impact * 0.42 + halo) * u_intensity;
  vec3 coreColor = mix(u_color, vec3(1.0), 0.28);

  gl_FragColor = vec4(coreColor, clamp(alpha, 0.0, 1.0));
}
`;

interface SunRayProgram {
  program: WebGLProgram;
  a_pos: number;
  u_anchor: WebGLUniformLocation | null;
  u_source: WebGLUniformLocation | null;
  u_intensity: WebGLUniformLocation | null;
  u_aspect: WebGLUniformLocation | null;
  u_color: WebGLUniformLocation | null;
}

interface ScreenPoint {
  u: number;
  v: number;
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'shader compile failed';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function sunRayColorFromAltitude(altitudeDeg: number): [number, number, number] {
  if (altitudeDeg <= 6) return [1.0, 0.9, 0.82];
  if (altitudeDeg <= 22) return [0.98, 0.95, 0.88];
  return [0.96, 0.97, 0.98];
}

function projectMercatorPoint(matrix: number[], point: mapboxgl.MercatorCoordinate): ScreenPoint | null {
  const x = point.x;
  const y = point.y;
  const z = point.z;
  const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  const clipW = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (!Number.isFinite(clipX) || !Number.isFinite(clipY) || !Number.isFinite(clipW) || clipW <= 0) {
    return null;
  }

  const ndcX = clipX / clipW;
  const ndcY = clipY / clipW;
  return {
    u: ndcX * 0.5 + 0.5,
    v: 1.0 - (ndcY * 0.5 + 0.5),
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clipScreenRayToViewport(anchor: ScreenPoint, source: ScreenPoint): ScreenPoint {
  const margin = 0.02;
  const min = margin;
  const max = 1 - margin;
  const dx = source.u - anchor.u;
  const dy = source.v - anchor.v;
  const epsilon = 1e-6;

  if (Math.abs(dx) < epsilon && Math.abs(dy) < epsilon) {
    return {
      u: anchor.u,
      v: clamp01(anchor.v - 0.25),
    };
  }

  let bestT = Number.POSITIVE_INFINITY;
  let best: ScreenPoint | null = null;

  if (Math.abs(dx) >= epsilon) {
    const txMin = (min - anchor.u) / dx;
    const yAtMin = anchor.v + dy * txMin;
    if (txMin > 0 && yAtMin >= min && yAtMin <= max && txMin < bestT) {
      bestT = txMin;
      best = { u: min, v: yAtMin };
    }

    const txMax = (max - anchor.u) / dx;
    const yAtMax = anchor.v + dy * txMax;
    if (txMax > 0 && yAtMax >= min && yAtMax <= max && txMax < bestT) {
      bestT = txMax;
      best = { u: max, v: yAtMax };
    }
  }

  if (Math.abs(dy) >= epsilon) {
    const tyMin = (min - anchor.v) / dy;
    const xAtMin = anchor.u + dx * tyMin;
    if (tyMin > 0 && xAtMin >= min && xAtMin <= max && tyMin < bestT) {
      bestT = tyMin;
      best = { u: xAtMin, v: min };
    }

    const tyMax = (max - anchor.v) / dy;
    const xAtMax = anchor.u + dx * tyMax;
    if (tyMax > 0 && xAtMax >= min && xAtMax <= max && tyMax < bestT) {
      bestT = tyMax;
      best = { u: xAtMax, v: max };
    }
  }

  if (best) {
    return best;
  }

  return {
    u: clamp01(source.u),
    v: clamp01(source.v),
  };
}

export class SunRayLayer implements CustomLayerInterface {
  readonly id = SUN_RAY_LAYER_ID;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MapboxMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: SunRayProgram | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private azimuthDeg = 180;
  private altitudeDeg = 45;

  /** Fixed world-space anchor — set once via updatePosition, never moves with the camera. */
  private anchorLng = 0;
  private anchorLat = 0;
  private anchorElevation = 0;

  onAdd(map: MapboxMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = gl.createProgram();
    if (!program) throw new Error('createProgram failed');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || 'program link failed';
      gl.deleteProgram(program);
      throw new Error(message);
    }

    this.program = {
      program,
      a_pos: gl.getAttribLocation(program, 'a_pos'),
      u_anchor: gl.getUniformLocation(program, 'u_anchor'),
      u_source: gl.getUniformLocation(program, 'u_source'),
      u_intensity: gl.getUniformLocation(program, 'u_intensity'),
      u_aspect: gl.getUniformLocation(program, 'u_aspect'),
      u_color: gl.getUniformLocation(program, 'u_color'),
    };

    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    this.vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  }

  render(gl: WebGL2RenderingContext, matrix: number[]): void {
    if (!this.map || !this.program || !this.vertexBuffer) return;
    if (this.altitudeDeg <= -1) return;

    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const renderWidth = viewport[2];
    const renderHeight = viewport[3];
    if (renderWidth <= 0 || renderHeight <= 0) return;

    // Use the stored fixed world-space anchor — does NOT follow the camera.
    const anchorPoint = mapboxgl.MercatorCoordinate.fromLngLat(
      { lng: this.anchorLng, lat: this.anchorLat },
      this.anchorElevation,
    );

    const azimuthRad = (this.azimuthDeg * Math.PI) / 180;
    const altitudeRad = (this.altitudeDeg * Math.PI) / 180;
    const horizontalFactor = Math.cos(altitudeRad);
    const sunEast = Math.sin(azimuthRad) * horizontalFactor;
    const sunNorth = Math.cos(azimuthRad) * horizontalFactor;
    const sunUp = Math.sin(altitudeRad);
    const rayDistanceMeters = 42000 + (1 - Math.max(0, sunUp)) * 58000;
    const meterScale = anchorPoint.meterInMercatorCoordinateUnits();
    const sourcePoint = new mapboxgl.MercatorCoordinate(
      anchorPoint.x + sunEast * rayDistanceMeters * meterScale,
      anchorPoint.y - sunNorth * rayDistanceMeters * meterScale,
      anchorPoint.z + sunUp * rayDistanceMeters * meterScale,
    );

    const anchorScreen = projectMercatorPoint(matrix, anchorPoint);
    const projectedSource = projectMercatorPoint(matrix, sourcePoint);
    if (!anchorScreen || !projectedSource) return;

    const sourceScreen = clipScreenRayToViewport(anchorScreen, projectedSource);
    const [r, g, b] = sunRayColorFromAltitude(this.altitudeDeg);
    const intensity = this.altitudeDeg >= 12
      ? 0.82
      : Math.max(0.16, Math.min(0.82, (this.altitudeDeg + 2) / 18));

    const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM);
    const prevBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    const prevBlend = gl.isEnabled(gl.BLEND);
    const prevDepth = gl.isEnabled(gl.DEPTH_TEST);
    const prevSrcRgb = gl.getParameter(gl.BLEND_SRC_RGB);
    const prevDstRgb = gl.getParameter(gl.BLEND_DST_RGB);
    const prevSrcAlpha = gl.getParameter(gl.BLEND_SRC_ALPHA);
    const prevDstAlpha = gl.getParameter(gl.BLEND_DST_ALPHA);
    const attribute = this.program.a_pos;
    const prevAttribEnabled = attribute >= 0
      ? Boolean(gl.getVertexAttrib(attribute, gl.VERTEX_ATTRIB_ARRAY_ENABLED))
      : false;

    gl.useProgram(this.program.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    gl.uniform2f(this.program.u_anchor, anchorScreen.u, anchorScreen.v);
    gl.uniform2f(this.program.u_source, sourceScreen.u, sourceScreen.v);
    gl.uniform1f(this.program.u_intensity, intensity);
    gl.uniform1f(this.program.u_aspect, renderWidth / renderHeight);
    gl.uniform3f(this.program.u_color, r, g, b);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    if (!prevAttribEnabled && attribute >= 0) gl.disableVertexAttribArray(attribute);
    if (prevBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
    if (prevDepth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
    gl.blendFuncSeparate(prevSrcRgb, prevDstRgb, prevSrcAlpha, prevDstAlpha);
    gl.bindBuffer(gl.ARRAY_BUFFER, prevBuffer);
    gl.useProgram(prevProgram);
  }

  onRemove(): void {
    if (this.gl && this.program) {
      this.gl.deleteProgram(this.program.program);
      this.program = null;
    }
    if (this.gl && this.vertexBuffer) {
      this.gl.deleteBuffer(this.vertexBuffer);
      this.vertexBuffer = null;
    }
    this.map = null;
    this.gl = null;
  }

  /**
   * Update the sun direction AND the fixed anchor point in world space.
   * The anchor is the geographic point where the ray "hits" the terrain.
   */
  updatePosition(azimuthDeg: number, altitudeDeg: number, lng: number, lat: number, elevation: number): void {
    this.azimuthDeg = azimuthDeg;
    this.altitudeDeg = altitudeDeg;
    this.anchorLng = lng;
    this.anchorLat = lat;
    this.anchorElevation = elevation;
    this.map?.triggerRepaint();
  }
}

let sunRayInstance: SunRayLayer | null = null;

export function addSunRayLayer(map: MapboxMap): SunRayLayer {
  if (sunRayInstance && map.getLayer(SUN_RAY_LAYER_ID)) {
    return sunRayInstance;
  }
  if (sunRayInstance) sunRayInstance = null;
  if (map.getLayer(SUN_RAY_LAYER_ID)) {
    try { map.removeLayer(SUN_RAY_LAYER_ID); } catch { /* no-op */ }
  }

  sunRayInstance = new SunRayLayer();
  map.addLayer(sunRayInstance as unknown as mapboxgl.LayerSpecification);
  return sunRayInstance;
}

export function removeSunRayLayer(map: MapboxMap): void {
  if (map.getLayer(SUN_RAY_LAYER_ID)) {
    try { map.removeLayer(SUN_RAY_LAYER_ID); } catch { /* no-op */ }
  }
  sunRayInstance = null;
}

export function updateSunRayPosition(azimuthDeg: number, altitudeDeg: number, lng: number, lat: number, elevation: number): void {
  if (sunRayInstance) {
    sunRayInstance.updatePosition(azimuthDeg, altitudeDeg, lng, lat, elevation);
  }
}