/**
 * Sun Disk — Mapbox GL CustomLayerInterface that renders a visible sun glow
 * in the sky at the astronomically correct azimuth + altitude.
 *
 * Rendering approach: a fullscreen quad is drawn; the fragment shader
 * computes a radial glow around the sun's projected screen-space position.
 * Two concentric effects:
 *   1. A bright sun disk (~0.53° angular diameter → small hot spot)
 *   2. A softer corona / halo with exponential falloff
 *
 * The layer uses `renderingMode: '2d'` so it paints on top of the sky
 * (above terrain + fog) and does NOT participate in depth testing.
 */
import type { CustomLayerInterface, Map as MapboxMap } from 'mapbox-gl';
import mapboxgl from 'mapbox-gl';

// ── Layer ID ────────────────────────────────────────────────────────────
export const SUN_DISK_LAYER_ID = 'sun-disk';

// ── GLSL ────────────────────────────────────────────────────────────────

const VERT = `
precision highp float;
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5; // [0,1]
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;

varying vec2 v_uv;

uniform vec2  u_sunScreen;   // sun position in [0,1] UV space
uniform float u_intensity;   // 0 (below horizon) → 1 (high sun)
uniform float u_aspect;      // viewport width / height
uniform vec3  u_sunColor;    // warm tint driven by altitude

void main() {
    vec2 uv = v_uv;
    vec2 sunUV = u_sunScreen;

    // Aspect-correct distance
    vec2 delta = uv - sunUV;
    delta.x *= u_aspect;
    float dist = length(delta);

    // Sun disk — tight bright core (angular radius ~0.004 in UV space at typical FOV)
    float diskRadius = 0.012;
    float disk = smoothstep(diskRadius, diskRadius * 0.3, dist);

    // Corona — wider soft glow
    float corona = exp(-dist * 18.0) * 0.6;

    // Outer atmospheric glow
    float glow = exp(-dist * 6.0) * 0.15;

    float brightness = (disk + corona + glow) * u_intensity;

    // Color: hot white core → sun color at edge → transparent
    vec3 white = vec3(1.0, 1.0, 0.98);
    vec3 color = mix(u_sunColor, white, disk);

    gl_FragColor = vec4(color * brightness, brightness);
}
`;

// ── Helpers ──────────────────────────────────────────────────────────────

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error('createShader failed');
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const msg = gl.getShaderInfoLog(s) || '';
    gl.deleteShader(s);
    throw new Error(msg);
  }
  return s;
}

interface SunDiskProgram {
  program: WebGLProgram;
  a_pos: number;
  u_sunScreen: WebGLUniformLocation | null;
  u_intensity: WebGLUniformLocation | null;
  u_aspect: WebGLUniformLocation | null;
  u_sunColor: WebGLUniformLocation | null;
}

// ── Sun color from altitude (warm orange at horizon → white at zenith) ──
function sunColorFromAltitude(altDeg: number): [number, number, number] {
  if (altDeg <= -2) return [1.0, 0.45, 0.15]; // deep orange below horizon
  if (altDeg <= 5)  return [1.0, 0.65, 0.3];  // golden hour
  if (altDeg <= 15) return [1.0, 0.82, 0.55]; // warm morning/evening
  if (altDeg <= 30) return [1.0, 0.92, 0.75]; // slightly warm
  return [1.0, 0.97, 0.92];                    // near-white at midday
}

// ── Custom Layer ────────────────────────────────────────────────────────

export class SunDiskLayer implements CustomLayerInterface {
  readonly id = SUN_DISK_LAYER_ID;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MapboxMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private prog: SunDiskProgram | null = null;
  private vbo: WebGLBuffer | null = null;

  // Updated externally via updateSunPosition()
  private azimuthDeg = 180;
  private altitudeDeg = 45;

  onAdd(map: MapboxMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'link failed');
    }

    this.prog = {
      program,
      a_pos: gl.getAttribLocation(program, 'a_pos'),
      u_sunScreen: gl.getUniformLocation(program, 'u_sunScreen'),
      u_intensity: gl.getUniformLocation(program, 'u_intensity'),
      u_aspect: gl.getUniformLocation(program, 'u_aspect'),
      u_sunColor: gl.getUniformLocation(program, 'u_sunColor'),
    };

    // Fullscreen quad: two triangles covering clip space [-1, 1]
    const verts = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  }

  render(gl: WebGL2RenderingContext, matrix: number[]): void {
    if (!this.prog || !this.vbo || !this.map) return;

    // Don't render if sun is well below the horizon (no visible glow)
    if (this.altitudeDeg < -4) return;

    // ── Project sun direction to screen space ────────────────────────
    // Strategy: place a virtual point along the sun direction at a large
    // distance from the camera, project it using the Mapbox matrix.
    // We work in Mercator coordinates.
    const center = this.map.getCenter();
    const cam = mapboxgl.MercatorCoordinate.fromLngLat(center, 0);

    // Sun direction in world-space (ENU: East, North, Up)
    const azRad = (this.azimuthDeg * Math.PI) / 180;
    const altRad = (this.altitudeDeg * Math.PI) / 180;
    const sunE = Math.sin(azRad) * Math.cos(altRad);
    const sunN = Math.cos(azRad) * Math.cos(altRad);
    const sunU = Math.sin(altRad);

    // Convert to Mercator offsets — scale by a large distance (~50 km)
    const dist = 50000; // meters
    const meterScale = cam.meterInMercatorCoordinateUnits();
    const dx = sunE * dist * meterScale;
    const dy = -sunN * dist * meterScale; // Mercator Y is flipped
    const dz = sunU * dist * meterScale;

    // Point in Mercator space
    const sx = cam.x + dx;
    const sy = cam.y + dy;
    const sz = cam.z + dz;

    // Project with the Mapbox matrix
    const m = matrix;
    const clipX = m[0] * sx + m[4] * sy + m[8] * sz + m[12];
    const clipY = m[1] * sx + m[5] * sy + m[9] * sz + m[13];
    const clipW = m[3] * sx + m[7] * sy + m[11] * sz + m[15];

    if (clipW <= 0) return; // behind camera

    // NDC → UV [0, 1]
    const ndcX = clipX / clipW;
    const ndcY = clipY / clipW;
    const screenU = ndcX * 0.5 + 0.5;
    const screenV = 1.0 - (ndcY * 0.5 + 0.5); // flip Y for UV

    // Intensity: 0 below -4°, ramp to 1 at +2°
    const intensity = this.altitudeDeg >= 2
      ? 1.0
      : Math.max(0, (this.altitudeDeg + 4) / 6);

    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const aspect = viewport[2] / viewport[3];
    const [r, g, b] = sunColorFromAltitude(this.altitudeDeg);

    // ── Save GL state ────────────────────────────────────────────────
    const prevProg = gl.getParameter(gl.CURRENT_PROGRAM);
    const prevBuf = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    const prevBlend = gl.isEnabled(gl.BLEND);
    const prevDepth = gl.isEnabled(gl.DEPTH_TEST);
    const prevSrcRgb = gl.getParameter(gl.BLEND_SRC_RGB);
    const prevDstRgb = gl.getParameter(gl.BLEND_DST_RGB);
    const prevSrcA = gl.getParameter(gl.BLEND_SRC_ALPHA);
    const prevDstA = gl.getParameter(gl.BLEND_DST_ALPHA);
    const a_pos = this.prog.a_pos;
    const prevAttribEnabled = a_pos >= 0 ? Boolean(gl.getVertexAttrib(a_pos, gl.VERTEX_ATTRIB_ARRAY_ENABLED)) : false;

    // ── Draw ─────────────────────────────────────────────────────────
    gl.useProgram(this.prog.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive blending for glow
    gl.disable(gl.DEPTH_TEST);

    gl.uniform2f(this.prog.u_sunScreen, screenU, screenV);
    gl.uniform1f(this.prog.u_intensity, intensity);
    gl.uniform1f(this.prog.u_aspect, aspect);
    gl.uniform3f(this.prog.u_sunColor, r, g, b);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(a_pos);
    gl.vertexAttribPointer(a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // ── Restore GL state ─────────────────────────────────────────────
    if (!prevAttribEnabled && a_pos >= 0) gl.disableVertexAttribArray(a_pos);
    if (prevBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
    if (prevDepth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
    gl.blendFuncSeparate(prevSrcRgb, prevDstRgb, prevSrcA, prevDstA);
    gl.bindBuffer(gl.ARRAY_BUFFER, prevBuf);
    gl.useProgram(prevProg);
  }

  onRemove(): void {
    if (this.gl && this.prog) {
      this.gl.deleteProgram(this.prog.program);
      this.prog = null;
    }
    if (this.gl && this.vbo) {
      this.gl.deleteBuffer(this.vbo);
      this.vbo = null;
    }
    this.map = null;
    this.gl = null;
  }

  // Public setter — called from useSunlight on every position update
  updatePosition(azimuthDeg: number, altitudeDeg: number): void {
    this.azimuthDeg = azimuthDeg;
    this.altitudeDeg = altitudeDeg;
  }
}

// ── Module-level singleton & helpers ────────────────────────────────────

let sunDiskInstance: SunDiskLayer | null = null;

export function addSunDiskLayer(map: MapboxMap): SunDiskLayer {
  if (sunDiskInstance && map.getLayer(SUN_DISK_LAYER_ID)) {
    return sunDiskInstance;
  }
  // Clean up stale instance if layer was removed externally
  if (sunDiskInstance) sunDiskInstance = null;
  if (map.getLayer(SUN_DISK_LAYER_ID)) {
    try { map.removeLayer(SUN_DISK_LAYER_ID); } catch { /* */ }
  }

  sunDiskInstance = new SunDiskLayer();
  map.addLayer(sunDiskInstance as unknown as mapboxgl.LayerSpecification);
  return sunDiskInstance;
}

export function removeSunDiskLayer(map: MapboxMap): void {
  if (map.getLayer(SUN_DISK_LAYER_ID)) {
    try { map.removeLayer(SUN_DISK_LAYER_ID); } catch { /* */ }
  }
  sunDiskInstance = null;
}

export function updateSunDiskPosition(azimuthDeg: number, altitudeDeg: number): void {
  if (sunDiskInstance) {
    sunDiskInstance.updatePosition(azimuthDeg, altitudeDeg);
  }
}
