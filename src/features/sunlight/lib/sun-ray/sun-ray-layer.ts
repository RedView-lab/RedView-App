/**
 * Rayon de soleil — vraie ligne 3D rendue via CustomLayerInterface.
 *
 * Utilise la matrice de projection de Mapbox (`renderingMode: '3d'`) pour
 * tracer une ligne depuis un point d'ancrage fixe sur le terrain jusque dans
 * le ciel, dans la direction du soleil. Les sommets sont stockés en
 * coordonnées Mercator et ne changent que quand la position du soleil
 * (date / heure) est mise à jour — PAS lors des mouvements de caméra. Le rayon
 * est donc 100 % immobile pendant les déplacements, rotations et zooms.
 *
 * L'anneau d'ancrage est rendu dans la même couche personnalisée pour que le
 * point et la ligne restent parfaitement solidaires pendant les mouvements de
 * caméra.
 */
import type { CustomLayerInterface, Map as MapboxMap } from 'mapbox-gl';
import mapboxgl from 'mapbox-gl';

export const SUN_RAY_LAYER_ID = 'sun-ray';
const SUN_RAY_ANCHOR_LIFT_METERS = 1.5;
const SUN_RAY_ELEVATION_RESYNC_THRESHOLD_METERS = 0.25;
const SUN_RAY_POINT_SIZE_PX = 24;
const SUN_RAY_POINT_STROKE_PX = 2.5;

function hasStyleLayer(map: MapboxMap, layerId: string): boolean {
  try {
    return Boolean(map.getLayer(layerId));
  } catch {
    return false;
  }
}

// ── Aides de couleur ───────────────────────────────────────────────────

function sunRayColor(altitudeDeg: number): [number, number, number] {
  if (altitudeDeg <= 6) return [1.0, 0.88, 0.70];
  if (altitudeDeg <= 22) return [1.0, 0.96, 0.82];
  return [1.0, 1.0, 0.98];
}

function sunRayCircleColor(altitudeDeg: number): [number, number, number] {
  if (altitudeDeg <= 6) return [1.0, 0.92, 0.78];
  if (altitudeDeg <= 22) return [1.0, 0.97, 0.88];
  return [1.0, 1.0, 0.99];
}

// ── Shaders GLSL ───────────────────────────────────────────────────────

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

const POINT_VERT = `
precision highp float;
attribute vec3 a_pos;
uniform mat4 u_matrix;
uniform float u_size;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 1.0);
  gl_PointSize = u_size;
}
`;

const POINT_FRAG = `
precision highp float;
uniform vec4 u_strokeColor;
uniform vec4 u_fillColor;
uniform float u_strokeWidth;
uniform float u_size;
void main() {
  vec2 centered = gl_PointCoord - vec2(0.5);
  float dist = length(centered);
  float radius = 0.5;
  float aa = max(0.5 / max(u_size, 1.0), 0.002);
  float outerMask = 1.0 - smoothstep(radius - aa, radius + aa, dist);
  if (outerMask <= 0.0) {
    discard;
  }

  float innerRadius = max(0.0, radius - u_strokeWidth);
  float fillMask = 1.0 - smoothstep(innerRadius - aa, innerRadius + aa, dist);
  vec4 color = mix(u_strokeColor, u_fillColor, fillMask);
  color.a *= outerMask;
  gl_FragColor = color;
}
`;

// ── Aide de compilation des shaders ────────────────────────────────────

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

function createProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
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

  return program;
}

// ── Custom 3D Layer ────────────────────────────────────────────────────

class SunRayLayer implements CustomLayerInterface {
  readonly id = SUN_RAY_LAYER_ID;
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const; // participate in 3D depth

  private map: MapboxMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private lineProgram: WebGLProgram | null = null;
  private pointProgram: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private lineAPos = -1;
  private lineUMatrix: WebGLUniformLocation | null = null;
  private lineUColor: WebGLUniformLocation | null = null;
  private pointAPos = -1;
  private pointUMatrix: WebGLUniformLocation | null = null;
  private pointUSize: WebGLUniformLocation | null = null;
  private pointUStrokeColor: WebGLUniformLocation | null = null;
  private pointUFillColor: WebGLUniformLocation | null = null;
  private pointUStrokeWidth: WebGLUniformLocation | null = null;

  /** Sommets Mercator précalculés : [anchorX, anchorY, anchorZ, srcX, srcY, srcZ] */
  private vertices = new Float32Array(6);
  private anchorLng: number | null = null;
  private anchorLat: number | null = null;
  private anchorElevation = 0;
  private azimuthDeg = 180;
  private altitudeDeg = 45;
  private needsBufferUpload = true;

  // ── Lifecycle ──────────────────────────────────────────────────────

  onAdd(map: MapboxMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;

    this.lineProgram = createProgram(gl, VERT, FRAG);
    this.lineAPos = gl.getAttribLocation(this.lineProgram, 'a_pos');
    this.lineUMatrix = gl.getUniformLocation(this.lineProgram, 'u_matrix');
    this.lineUColor = gl.getUniformLocation(this.lineProgram, 'u_color');

    this.pointProgram = createProgram(gl, POINT_VERT, POINT_FRAG);
    this.pointAPos = gl.getAttribLocation(this.pointProgram, 'a_pos');
    this.pointUMatrix = gl.getUniformLocation(this.pointProgram, 'u_matrix');
    this.pointUSize = gl.getUniformLocation(this.pointProgram, 'u_size');
    this.pointUStrokeColor = gl.getUniformLocation(this.pointProgram, 'u_strokeColor');
    this.pointUFillColor = gl.getUniformLocation(this.pointProgram, 'u_fillColor');
    this.pointUStrokeWidth = gl.getUniformLocation(this.pointProgram, 'u_strokeWidth');

    this.buffer = gl.createBuffer();
  }

  render(gl: WebGL2RenderingContext, matrix: number[]): void {
    if (!this.lineProgram || !this.pointProgram || !this.buffer || !this.map) return;
    if (this.altitudeDeg <= -1) return;

    this.syncAnchorElevation();

    // Envoie les sommets au GPU quand ils changent
    if (this.needsBufferUpload) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.vertices, gl.DYNAMIC_DRAW);
      this.needsBufferUpload = false;
    }

    const [r, g, b] = sunRayColor(this.altitudeDeg);
    const alpha = this.altitudeDeg >= 12
      ? 0.92
      : Math.max(0.3, Math.min(0.92, (this.altitudeDeg + 2) / 14));

    // ── Sauvegarde de l'état GL ──────────────────────────────────
    const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM);
    const prevBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    const prevBlend = gl.isEnabled(gl.BLEND);
    const prevDepth = gl.isEnabled(gl.DEPTH_TEST);
    const prevLineWidth = gl.getParameter(gl.LINE_WIDTH);
    const prevLineAttrEnabled = this.lineAPos >= 0
      ? Boolean(gl.getVertexAttrib(this.lineAPos, gl.VERTEX_ATTRIB_ARRAY_ENABLED))
      : false;
    const prevPointAttrEnabled = this.pointAPos >= 0
      ? Boolean(gl.getVertexAttrib(this.pointAPos, gl.VERTEX_ATTRIB_ARRAY_ENABLED))
      : false;

    // ── Draw ─────────────────────────────────────────────────────
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);

    gl.useProgram(this.lineProgram);
    gl.lineWidth(2.0); // le GPU plafonne à sa limite d'implémentation, en général 1 à 10
    gl.uniformMatrix4fv(this.lineUMatrix, false, matrix);
    gl.uniform4f(this.lineUColor, r, g, b, alpha);
    gl.enableVertexAttribArray(this.lineAPos);
    gl.vertexAttribPointer(this.lineAPos, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.LINES, 0, 2);

    const [strokeR, strokeG, strokeB] = sunRayCircleColor(this.altitudeDeg);
    gl.useProgram(this.pointProgram);
    gl.uniformMatrix4fv(this.pointUMatrix, false, matrix);
    gl.uniform1f(this.pointUSize, SUN_RAY_POINT_SIZE_PX);
    gl.uniform4f(this.pointUStrokeColor, strokeR, strokeG, strokeB, 0.95);
    gl.uniform4f(this.pointUFillColor, 1.0, 1.0, 0.94, 0.15);
    gl.uniform1f(this.pointUStrokeWidth, SUN_RAY_POINT_STROKE_PX / SUN_RAY_POINT_SIZE_PX);
    gl.enableVertexAttribArray(this.pointAPos);
    gl.vertexAttribPointer(this.pointAPos, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, 1);

    // ── Restauration de l'état GL ────────────────────────────────
    if (!prevLineAttrEnabled && this.lineAPos >= 0) gl.disableVertexAttribArray(this.lineAPos);
    if (!prevPointAttrEnabled && this.pointAPos >= 0) gl.disableVertexAttribArray(this.pointAPos);
    if (prevBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
    if (prevDepth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
    gl.lineWidth(prevLineWidth);
    gl.bindBuffer(gl.ARRAY_BUFFER, prevBuffer);
    gl.useProgram(prevProgram);
  }

  onRemove(): void {
    if (this.gl && this.lineProgram) {
      this.gl.deleteProgram(this.lineProgram);
      this.lineProgram = null;
    }
    if (this.gl && this.pointProgram) {
      this.gl.deleteProgram(this.pointProgram);
      this.pointProgram = null;
    }
    if (this.gl && this.buffer) {
      this.gl.deleteBuffer(this.buffer);
      this.buffer = null;
    }
    this.map = null;
    this.gl = null;
  }

  // ── Mise à jour publique ───────────────────────────────────────

  updatePosition(
    azimuthDeg: number,
    altitudeDeg: number,
    lng: number,
    lat: number,
    elevation: number,
  ): void {
    this.azimuthDeg = azimuthDeg;
    this.altitudeDeg = altitudeDeg;
    this.anchorLng = lng;
    this.anchorLat = lat;
    this.anchorElevation = elevation;

    this.rebuildVertices();
    this.map?.triggerRepaint();
  }

  private syncAnchorElevation(): void {
    if (!this.map || this.anchorLng == null || this.anchorLat == null) return;

    // Le LOD du terrain peut fluctuer pendant que la caméra bouge, ce qui fait
    // trembler visiblement l'ancrage du rayon pendant les rotations / zooms. On
    // ne rééchantillonne qu'une fois la caméra stable pour que l'indicateur
    // reste visuellement fixe.
    if (this.map.isMoving()) {
      return;
    }

    const liveElevation = this.map.queryTerrainElevation?.([this.anchorLng, this.anchorLat]);
    if (!Number.isFinite(liveElevation)) return;

    if (Math.abs((liveElevation ?? 0) - this.anchorElevation) <= SUN_RAY_ELEVATION_RESYNC_THRESHOLD_METERS) {
      return;
    }

    this.anchorElevation = liveElevation ?? this.anchorElevation;
    this.rebuildVertices();
  }

  private rebuildVertices(): void {
    if (this.anchorLng == null || this.anchorLat == null) return;

    // Ancre : point fixe sur le terrain
    const anchor = mapboxgl.MercatorCoordinate.fromLngLat(
      { lng: this.anchorLng, lat: this.anchorLat },
      this.anchorElevation + SUN_RAY_ANCHOR_LIFT_METERS,
    );

    // Source : point lointain dans le ciel, dans la direction du soleil
    const azRad = (this.azimuthDeg * Math.PI) / 180;
    const altRad = (this.altitudeDeg * Math.PI) / 180;
    const cosAlt = Math.cos(altRad);
    const sunEast = Math.sin(azRad) * cosAlt;
    const sunNorth = Math.cos(azRad) * cosAlt;
    const sunUp = Math.sin(altRad);
    // Longueur du rayon en mètres — assez longue pour toujours sortir de la vue
    const rayLenM = 60000;
    const ms = anchor.meterInMercatorCoordinateUnits();

    this.vertices[0] = anchor.x;
    this.vertices[1] = anchor.y;
    this.vertices[2] = anchor.z;
    this.vertices[3] = anchor.x + sunEast * rayLenM * ms;
    this.vertices[4] = anchor.y - sunNorth * rayLenM * ms; // Y Mercator inversé
    this.vertices[5] = anchor.z + sunUp * rayLenM * ms;

    this.needsBufferUpload = true;
  }
}

// ── Singleton du module + API publique ─────────────────────────────────

let sunRayInstance: SunRayLayer | null = null;

export function addSunRayLayer(map: MapboxMap): void {
  if (sunRayInstance && hasStyleLayer(map, SUN_RAY_LAYER_ID)) return;
  if (sunRayInstance) sunRayInstance = null;
  if (hasStyleLayer(map, SUN_RAY_LAYER_ID)) {
    try { map.removeLayer(SUN_RAY_LAYER_ID); } catch { /* */ }
  }
  sunRayInstance = new SunRayLayer();
  map.addLayer(sunRayInstance as unknown as mapboxgl.LayerSpecification);
}

export function removeSunRayLayer(map: MapboxMap): void {
  try {
    if (hasStyleLayer(map, SUN_RAY_LAYER_ID)) {
      map.removeLayer(SUN_RAY_LAYER_ID);
    }
  } catch {
    /* la carte est peut-être en cours de destruction */
  }
  sunRayInstance = null;
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
}