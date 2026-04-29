/**
 * Sun Ray — True 3D line rendered via CustomLayerInterface.
 *
 * Uses Mapbox's projection matrix (`renderingMode: '3d'`) to draw a line
 * from a fixed anchor point on the terrain up into the sky along the sun
 * direction.  The vertices are stored in Mercator coordinates and only
 * change when the sun position (date/time) is updated — NOT on camera
 * moves.  This makes the ray 100 % static during pan/rotate/zoom.
 *
 * Additionally a small circle marker is rendered at the anchor point via
 * a standard Mapbox circle layer (GeoJSON source).
 */
import type { CustomLayerInterface, Map as MapboxMap, GeoJSONSource } from 'mapbox-gl';
import mapboxgl from 'mapbox-gl';

export const SUN_RAY_LAYER_ID = 'sun-ray';
const SUN_RAY_CIRCLE_SOURCE_ID = 'sun-ray-circle-src';
const SUN_RAY_CIRCLE_LAYER_ID = 'sun-ray-circle';

// ── Color helpers ──────────────────────────────────────────────────────

function sunRayColor(altitudeDeg: number): [number, number, number] {
  if (altitudeDeg <= 6) return [1.0, 0.88, 0.70];
  if (altitudeDeg <= 22) return [1.0, 0.96, 0.82];
  return [1.0, 1.0, 0.98];
}

function sunRayCircleColor(altitudeDeg: number): string {
  if (altitudeDeg <= 6) return 'rgba(255, 235, 200, 1)';
  if (altitudeDeg <= 22) return 'rgba(255, 248, 225, 1)';
  return 'rgba(255, 255, 252, 1)';
}

// ── GLSL shaders ───────────────────────────────────────────────────────

const VERT = `
precision highp float;
attribute vec3 a_pos;
uniform mat4 u_matrix;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 1.0);
}
`;

const FRAG = `
precision highp float;
uniform vec4 u_color;
void main() {
  gl_FragColor = u_color;
}
`;

// ── Shader compile helper ──────────────────────────────────────────────

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const msg = gl.getShaderInfoLog(shader) || 'shader compile failed';
    gl.deleteShader(shader);
    throw new Error(msg);
  }
  return shader;
}

// ── Custom 3D Layer ────────────────────────────────────────────────────

class SunRayLayer implements CustomLayerInterface {
  readonly id = SUN_RAY_LAYER_ID;
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const; // participate in 3D depth

  private map: MapboxMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private aPos = -1;
  private uMatrix: WebGLUniformLocation | null = null;
  private uColor: WebGLUniformLocation | null = null;

  /** Pre-computed Mercator vertices: [anchorX, anchorY, anchorZ, srcX, srcY, srcZ] */
  private vertices = new Float32Array(6);
  private altitudeDeg = 45;
  private needsBufferUpload = true;

  // ── Lifecycle ──────────────────────────────────────────────────────

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
      const msg = gl.getProgramInfoLog(program) || 'link failed';
      gl.deleteProgram(program);
      throw new Error(msg);
    }

    this.program = program;
    this.aPos = gl.getAttribLocation(program, 'a_pos');
    this.uMatrix = gl.getUniformLocation(program, 'u_matrix');
    this.uColor = gl.getUniformLocation(program, 'u_color');

    this.buffer = gl.createBuffer();
  }

  render(gl: WebGL2RenderingContext, matrix: number[]): void {
    if (!this.program || !this.buffer || !this.map) return;
    if (this.altitudeDeg <= -1) return;

    // Upload vertices to GPU when they change
    if (this.needsBufferUpload) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.vertices, gl.DYNAMIC_DRAW);
      this.needsBufferUpload = false;
    }

    const [r, g, b] = sunRayColor(this.altitudeDeg);
    const alpha = this.altitudeDeg >= 12
      ? 0.92
      : Math.max(0.3, Math.min(0.92, (this.altitudeDeg + 2) / 14));

    // ── Save GL state ────────────────────────────────────────────
    const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM);
    const prevBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    const prevBlend = gl.isEnabled(gl.BLEND);
    const prevDepth = gl.isEnabled(gl.DEPTH_TEST);
    const prevLineWidth = gl.getParameter(gl.LINE_WIDTH);
    const attr = this.aPos;
    const prevAttrEnabled = attr >= 0
      ? Boolean(gl.getVertexAttrib(attr, gl.VERTEX_ATTRIB_ARRAY_ENABLED))
      : false;

    // ── Draw ─────────────────────────────────────────────────────
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.lineWidth(2.0); // GPU capped at implementation limit, usually 1–10

    gl.uniformMatrix4fv(this.uMatrix, false, matrix);
    gl.uniform4f(this.uColor, r, g, b, alpha);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(attr);
    gl.vertexAttribPointer(attr, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.LINES, 0, 2);

    // ── Restore GL state ─────────────────────────────────────────
    if (!prevAttrEnabled && attr >= 0) gl.disableVertexAttribArray(attr);
    if (prevBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
    if (prevDepth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
    gl.lineWidth(prevLineWidth);
    gl.bindBuffer(gl.ARRAY_BUFFER, prevBuffer);
    gl.useProgram(prevProgram);
  }

  onRemove(): void {
    if (this.gl && this.program) {
      this.gl.deleteProgram(this.program);
      this.program = null;
    }
    if (this.gl && this.buffer) {
      this.gl.deleteBuffer(this.buffer);
      this.buffer = null;
    }
    this.map = null;
    this.gl = null;
  }

  // ── Public update ──────────────────────────────────────────────

  updatePosition(
    azimuthDeg: number,
    altitudeDeg: number,
    lng: number,
    lat: number,
    elevation: number,
  ): void {
    this.altitudeDeg = altitudeDeg;

    // Anchor: fixed point on terrain
    const anchor = mapboxgl.MercatorCoordinate.fromLngLat({ lng, lat }, elevation);

    // Source: far point along the sun direction in the sky
    const azRad = (azimuthDeg * Math.PI) / 180;
    const altRad = (altitudeDeg * Math.PI) / 180;
    const cosAlt = Math.cos(altRad);
    const sunEast = Math.sin(azRad) * cosAlt;
    const sunNorth = Math.cos(azRad) * cosAlt;
    const sunUp = Math.sin(altRad);
    // Ray length in metres — long enough to always exit the viewport
    const rayLenM = 60000;
    const ms = anchor.meterInMercatorCoordinateUnits();

    this.vertices[0] = anchor.x;
    this.vertices[1] = anchor.y;
    this.vertices[2] = anchor.z;
    this.vertices[3] = anchor.x + sunEast * rayLenM * ms;
    this.vertices[4] = anchor.y - sunNorth * rayLenM * ms; // Mercator Y flipped
    this.vertices[5] = anchor.z + sunUp * rayLenM * ms;

    this.needsBufferUpload = true;
    this.map?.triggerRepaint();
  }
}

// ── Anchor circle (standard Mapbox layer) ──────────────────────────────

function ensureCircleLayer(map: MapboxMap, lng: number, lat: number, elevation: number, altitudeDeg: number): void {
  const data: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [lng, lat, elevation] },
    }],
  };

  if (!map.getSource(SUN_RAY_CIRCLE_SOURCE_ID)) {
    map.addSource(SUN_RAY_CIRCLE_SOURCE_ID, { type: 'geojson', data });
  } else {
    (map.getSource(SUN_RAY_CIRCLE_SOURCE_ID) as GeoJSONSource).setData(data);
  }

  if (!map.getLayer(SUN_RAY_CIRCLE_LAYER_ID)) {
    map.addLayer({
      id: SUN_RAY_CIRCLE_LAYER_ID,
      type: 'circle',
      source: SUN_RAY_CIRCLE_SOURCE_ID,
      paint: {
        'circle-radius': 12,
        'circle-color': 'rgba(255, 255, 240, 0.15)',
        'circle-stroke-color': sunRayCircleColor(altitudeDeg),
        'circle-stroke-width': 2.5,
        'circle-stroke-opacity': 0.95,
        'circle-emissive-strength': 1,
      },
    } as never);
  } else {
    try {
      map.setPaintProperty(SUN_RAY_CIRCLE_LAYER_ID, 'circle-stroke-color', sunRayCircleColor(altitudeDeg));
    } catch { /* */ }
  }
}

function removeCircleLayer(map: MapboxMap): void {
  try { if (map.getLayer(SUN_RAY_CIRCLE_LAYER_ID)) map.removeLayer(SUN_RAY_CIRCLE_LAYER_ID); } catch { /* */ }
  try { if (map.getSource(SUN_RAY_CIRCLE_SOURCE_ID)) map.removeSource(SUN_RAY_CIRCLE_SOURCE_ID); } catch { /* */ }
}

// ── Module-level singleton + public API ────────────────────────────────

let sunRayInstance: SunRayLayer | null = null;
let currentMap: MapboxMap | null = null;

export function addSunRayLayer(map: MapboxMap): void {
  currentMap = map;
  if (sunRayInstance && map.getLayer(SUN_RAY_LAYER_ID)) return;
  if (sunRayInstance) sunRayInstance = null;
  if (map.getLayer(SUN_RAY_LAYER_ID)) {
    try { map.removeLayer(SUN_RAY_LAYER_ID); } catch { /* */ }
  }
  sunRayInstance = new SunRayLayer();
  map.addLayer(sunRayInstance as unknown as mapboxgl.LayerSpecification);
}

export function removeSunRayLayer(map: MapboxMap): void {
  removeCircleLayer(map);
  if (map.getLayer(SUN_RAY_LAYER_ID)) {
    try { map.removeLayer(SUN_RAY_LAYER_ID); } catch { /* */ }
  }
  sunRayInstance = null;
  currentMap = null;
}

export function updateSunRayPosition(
  azimuthDeg: number,
  altitudeDeg: number,
  lng: number,
  lat: number,
  elevation: number,
): void {
  if (sunRayInstance) {
    sunRayInstance.updatePosition(azimuthDeg, altitudeDeg, lng, lat, elevation);
  }
  if (currentMap) {
    try {
      ensureCircleLayer(currentMap, lng, lat, elevation, altitudeDeg);
    } catch { /* */ }
  }
}