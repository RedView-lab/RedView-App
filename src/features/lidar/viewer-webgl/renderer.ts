import { updateSlopeRampTexture } from './slopeRamp';
import { updateAltitudeRampTexture, DEFAULT_MAX_ALTITUDE_M } from './altitudeRamp';
import type { ViewerSlopeState, ViewerAltitudeState } from '../viewer/rightPanel/types';
import type { SolarRenderState } from './sunlightController';

// ============================================
// LiDAR HD — WebGL2 fallback renderer
// ============================================
// Custom WebGL2 engine mirroring the WebGPU terrain pipeline. Renders a
// single textured + lit heightmap mesh with support for real-time astronomical
// sun lighting, horizon-sweep cast shadows, cumulative sunlight map,
// slope ramp, altitude ramp, and 3D celestial sun trajectory.

const VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;

uniform mat4 u_viewProj;
uniform float u_elevationExaggeration;

out vec3 v_normal;
out vec2 v_uv;
out vec3 v_worldPos;

void main() {
  v_normal = normalize(vec3(a_normal.x, a_normal.y / max(u_elevationExaggeration, 0.001), a_normal.z));
  v_uv = a_uv;
  vec3 pos = vec3(a_pos.x, a_pos.y * u_elevationExaggeration, a_pos.z);
  v_worldPos = pos;
  gl_Position = u_viewProj * vec4(pos, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

in vec3 v_normal;
in vec2 v_uv;
in vec3 v_worldPos;

uniform sampler2D u_ortho;
uniform sampler2D u_snow;          // R32F snow depth in cm (NEAREST sampling)
uniform sampler2D u_slopeRamp;     // 1D/2D LUT (256x1 RGBA) for slope colorization
uniform sampler2D u_altitudeRamp;  // 1D/2D LUT (512x1 RGBA) for altitude colorization
uniform sampler2D u_shadowMap;     // R8 (0 = lit, 255 = cast shadow)
uniform sampler2D u_sunlightMap;   // RGBA (cumulative sunshine map)

uniform vec3 u_sunDir;             // already normalised, points FROM surface TO sun
uniform vec3 u_sunColor;           // physical sun color from solar altitude
uniform float u_sunIntensity;      // 0.0 (night) to 1.0 (noon)
uniform vec3 u_skyColor;           // ambient sky tint
uniform float u_exposure;
uniform int u_sunlightEnabled;     // 0=off, 1=on

uniform int u_shadowEnabled;       // 0=off, 1=on
uniform float u_shadowOpacity;     // 0.0 to 1.0
uniform int u_sunlightMapEnabled;  // 0=off, 1=on
uniform float u_sunlightMapOpacity;// 0.0 to 1.0

uniform int u_snowMode;            // 0=off, 1=cover, 2=thickness
uniform vec2 u_snowOrigin;         // (originX, originZ) in renderer space
uniform vec2 u_snowScale;          // (scaleX,  scaleZ)  in renderer space
uniform vec2 u_terrainOrigin;      // (originX, originZ) for grid-aligned maps
uniform vec2 u_terrainScale;       // (scaleX,  scaleZ)  for grid-aligned maps

uniform int u_slopeEnabled;        // 0=off, 1=on
uniform float u_slopeOpacity;      // 0.0 to 1.0
uniform int u_altitudeEnabled;     // 0=off, 1=on
uniform float u_altitudeOpacity;   // 0.0 to 1.0
uniform float u_centerAltitude;    // center elevation in meters
uniform float u_maxAltitude;       // max elevation scale (default 5000.0)
uniform float u_elevationExaggeration;

out vec4 fragColor;

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
}

float sampleSnowDepthCm() {
  if (u_snowMode == 0) return 0.0;
  vec2 uv = (v_worldPos.xz - u_snowOrigin) / u_snowScale;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
  ivec2 dims = textureSize(u_snow, 0);
  ivec2 px = clamp(ivec2(uv * vec2(dims)), ivec2(0), dims - ivec2(1));
  return texelFetch(u_snow, px, 0).r;
}

vec3 snowThicknessColor(float depthCm) {
  float t = clamp(depthCm / 200.0, 0.0, 1.0);
  float r = clamp(1.6 * t - 0.4, 0.0, 1.0);
  float g = clamp(1.0 - abs(t - 0.55) * 2.2, 0.0, 1.0);
  float b = clamp(1.0 - t * 1.4 + 0.15, 0.0, 1.0);
  return vec3(r, g, b);
}

vec3 applySnow(vec3 baseSrgb) {
  if (u_snowMode == 0) return baseSrgb;
  float depth = sampleSnowDepthCm();
  if (u_snowMode == 2) {
    if (depth <= 0.5) return baseSrgb * 0.35;
    return snowThicknessColor(depth);
  }
  // cover
  float t = smoothstep(0.0, 30.0, depth) * 0.93;
  return mix(baseSrgb, vec3(0.97, 0.98, 1.0), t);
}

void main() {
  vec3 base = texture(u_ortho, v_uv).rgb;
  vec3 tinted = applySnow(base);

  vec3 N = normalize(v_normal);

  // Surface slope angle in degrees
  if (u_slopeEnabled == 1 && u_slopeOpacity > 0.0) {
    float cosSlope = clamp(N.y, 0.0, 1.0);
    float slopeDeg = acos(cosSlope) * 57.29577951308232;
    float slopeU = clamp(slopeDeg / 90.0, 0.0, 1.0);
    vec4 slopeSample = texture(u_slopeRamp, vec2(slopeU, 0.5));
    if (slopeSample.a > 0.0) {
      tinted = mix(tinted, slopeSample.rgb, slopeSample.a * u_slopeOpacity);
    }
  }

  // Altitude colorization
  if (u_altitudeEnabled == 1 && u_altitudeOpacity > 0.0) {
    float realAltitude = (v_worldPos.y / max(u_elevationExaggeration, 0.001)) + u_centerAltitude;
    float altU = clamp(realAltitude / u_maxAltitude, 0.0, 1.0);
    vec4 altSample = texture(u_altitudeRamp, vec2(altU, 0.5));
    if (altSample.a > 0.0) {
      tinted = mix(tinted, altSample.rgb, altSample.a * u_altitudeOpacity);
    }
  }

  // Cumulative sunlight map (insolation) overlay
  vec2 gridUV = (v_worldPos.xz - u_terrainOrigin) / u_terrainScale;
  if (u_sunlightEnabled == 1 && u_sunlightMapEnabled == 1 && u_sunlightMapOpacity > 0.0) {
    if (all(greaterThanEqual(gridUV, vec2(0.0))) && all(lessThanEqual(gridUV, vec2(1.0)))) {
      vec4 smSample = texture(u_sunlightMap, gridUV);
      if (smSample.a > 0.0) {
        tinted = mix(tinted, smSample.rgb, smSample.a * u_sunlightMapOpacity);
      }
    }
  }

  vec3 baseLin = srgbToLinear(tinted);

  float ndotl = clamp(dot(N, u_sunDir), 0.0, 1.0);

  // Cast shadow sampling
  float castShadow = 0.0;
  if (u_sunlightEnabled == 1 && u_shadowEnabled == 1 && u_shadowOpacity > 0.0) {
    if (all(greaterThanEqual(gridUV, vec2(0.0))) && all(lessThanEqual(gridUV, vec2(1.0)))) {
      castShadow = texture(u_shadowMap, gridUV).r;
    }
  }

  if (u_sunlightEnabled == 1) {
    // Physical Sun Lighting
    // Direct sunlight factor: self-shadow (ndotl) + cast shadow
    float directLit = ndotl * (1.0 - castShadow) * u_sunIntensity;

    // At shadowOpacity = 100% (1.0), all light (direct + ambient) in shadowed areas is fully extinguished to pure black (noir noir)
    float shadowDarkness = u_shadowOpacity;
    float shadowMask = clamp(1.0 - (1.0 - directLit) * shadowDarkness, 0.0, 1.0);

    vec3 directSun = baseLin * u_sunColor * directLit;
    float upFacing = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 ambientBase = baseLin * u_skyColor * (0.18 + 0.22 * upFacing);

    vec3 lit = (directSun + ambientBase * shadowMask) * u_exposure;
    fragColor = vec4(linearToSrgb(lit), 1.0);
  } else {

    // Default studio directional lighting
    float wrap = ndotl * 0.5 + 0.5;
    vec3 sunLight = baseLin * wrap;

    float upFacing = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 ambient = baseLin * u_skyColor * (0.18 + 0.22 * upFacing);

    vec3 lit = (sunLight * 0.85 + ambient) * u_exposure;
    fragColor = vec4(linearToSrgb(lit), 1.0);
  }
}
`;

const PREVIEW_VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec4 a_color;

uniform mat4 u_viewProj;
uniform float u_elevationExaggeration;

out vec3 v_normal;
out vec4 v_color;

void main() {
  v_normal = normalize(vec3(a_normal.x, a_normal.y / max(u_elevationExaggeration, 0.001), a_normal.z));
  v_color = a_color;
  vec3 pos = vec3(a_pos.x, a_pos.y * u_elevationExaggeration, a_pos.z);
  gl_Position = u_viewProj * vec4(pos, 1.0);
}
`;

const PREVIEW_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec3 v_normal;
in vec4 v_color;

uniform vec3 u_sunDir;
out vec4 fragColor;

void main() {
  float diff = max(dot(v_normal, u_sunDir), 0.0);
  float light = 0.6 + 0.4 * diff;
  fragColor = vec4(v_color.rgb * light, v_color.a);
}
`;

const TRAJECTORY_VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec4 a_color;

uniform mat4 u_viewProj;
out vec4 v_color;

void main() {
  v_color = a_color;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}
`;

const TRAJECTORY_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec4 v_color;
out vec4 fragColor;

void main() {
  fragColor = v_color;
}
`;

const ROUTE_VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec4 a_color;

uniform mat4 u_viewProj;
out vec4 v_color;

void main() {
  v_color = a_color;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}
`;

const ROUTE_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec4 v_color;
out vec4 fragColor;

void main() {
  fragColor = v_color;
}
`;

const SUN_DISC_VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_quadPos;

uniform mat4 u_viewProj;
uniform vec3 u_sunDiscPos;
uniform float u_sunDiscRadius;
uniform vec3 u_camRight;
uniform vec3 u_camUp;

out vec2 v_localPos;

void main() {
  v_localPos = a_quadPos;
  vec3 worldPos = u_sunDiscPos + (a_quadPos.x * u_camRight + a_quadPos.y * u_camUp) * u_sunDiscRadius;
  gl_Position = u_viewProj * vec4(worldPos, 1.0);
}
`;

const SUN_DISC_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_localPos;
uniform vec3 u_sunColor;
uniform float u_sunIntensity;

out vec4 fragColor;

void main() {
  float dist = length(v_localPos);
  if (dist > 1.0) discard;

  float core = smoothstep(0.35, 0.05, dist);
  float corona = exp(-dist * 4.5) * 0.75;
  float glow = exp(-dist * 2.0) * 0.35;
  float brightness = clamp(core + corona + glow, 0.0, 1.0) * max(u_sunIntensity, 0.15);

  vec3 white = vec3(1.0, 1.0, 0.98);
  vec3 col = mix(u_sunColor, white, core);
  fragColor = vec4(col * brightness, brightness);
}
`;

export interface TerrainGPUData {
  vertices: Float32Array;   // interleaved pos.xyz | normal.xyz | uv.xy
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
}

export class WebGLTerrainRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly maxTextureSize: number;
  readonly rendererInfo: string;

  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private vbo!: WebGLBuffer;
  private ibo!: WebGLBuffer;
  private texture: WebGLTexture | null = null;
  private snowTexture: WebGLTexture | null = null;
  private snowOriginX = 0;
  private snowOriginZ = 0;
  private snowScaleX = 1;
  private snowScaleZ = 1;
  private terrainOriginX = 0;
  private terrainOriginZ = 0;
  private terrainScaleX = 1;
  private terrainScaleZ = 1;
  private snowMode: 0 | 1 | 2 = 0;

  private slopeTexture: WebGLTexture | null = null;
  private slopeEnabled = 0;
  private slopeOpacity = 0.2;

  private altitudeTexture: WebGLTexture | null = null;
  private altitudeEnabled = 0;
  private altitudeOpacity = 0.2;
  private centerAltitude = 0;
  private maxAltitude = DEFAULT_MAX_ALTITUDE_M;

  // Sunlight & Shadow state
  private shadowTexture: WebGLTexture | null = null;
  private shadowEnabled = 0;
  private shadowOpacity = 0.5;
  private sunlightMapTexture: WebGLTexture | null = null;
  private sunlightMapEnabled = 0;
  private sunlightMapOpacity = 0.5;
  private sunlightEnabled = 0;
  private sunColor: [number, number, number] = [1.0, 0.98, 0.95];
  private sunIntensity = 1.0;

  // Trajectory & Sun Disc
  private trajectoryProgram!: WebGLProgram;
  private trajectoryVao: WebGLVertexArrayObject | null = null;
  private trajectoryVbo: WebGLBuffer | null = null;
  private trajectoryVertexCount = 0;
  private uTrajectoryViewProj!: WebGLUniformLocation;

  private sunDiscProgram!: WebGLProgram;
  private sunDiscVao: WebGLVertexArrayObject | null = null;
  private sunDiscVbo: WebGLBuffer | null = null;
  private uSunDiscViewProj!: WebGLUniformLocation;
  private uSunDiscPos!: WebGLUniformLocation;
  private uSunDiscRadius!: WebGLUniformLocation;
  private uSunDiscCamRight!: WebGLUniformLocation;
  private uSunDiscCamUp!: WebGLUniformLocation;
  private uSunDiscColor!: WebGLUniformLocation;
  private uSunDiscIntensity!: WebGLUniformLocation;

  private sunDiscPos: [number, number, number] | null = null;
  private sunDiscRadius = 15;
  private trajectoryEnabled = false;

  // 3D GPX Route Ribbon
  private routeProgram!: WebGLProgram;
  private routeVao: WebGLVertexArrayObject | null = null;
  private routeVboPos: WebGLBuffer | null = null;
  private routeVboCol: WebGLBuffer | null = null;
  private routeIbo: WebGLBuffer | null = null;
  private routeIndexCount = 0;
  private uRouteViewProj!: WebGLUniformLocation;

  private uViewProj!: WebGLUniformLocation;
  private uElevationExaggeration!: WebGLUniformLocation;
  private uOrtho!: WebGLUniformLocation;
  private uSnow!: WebGLUniformLocation;
  private uSlopeRamp!: WebGLUniformLocation;
  private uSlopeEnabled!: WebGLUniformLocation;
  private uSlopeOpacity!: WebGLUniformLocation;
  private uAltitudeRamp!: WebGLUniformLocation;
  private uAltitudeEnabled!: WebGLUniformLocation;
  private uAltitudeOpacity!: WebGLUniformLocation;
  private uShadowMap!: WebGLUniformLocation;
  private uSunlightMap!: WebGLUniformLocation;
  private uSunlightEnabled!: WebGLUniformLocation;
  private uSunColor!: WebGLUniformLocation;
  private uSunIntensity!: WebGLUniformLocation;
  private uShadowEnabled!: WebGLUniformLocation;
  private uShadowOpacity!: WebGLUniformLocation;
  private uSunlightMapEnabled!: WebGLUniformLocation;
  private uSunlightMapOpacity!: WebGLUniformLocation;
  private uTerrainOrigin!: WebGLUniformLocation;
  private uTerrainScale!: WebGLUniformLocation;
  private uCenterAltitude!: WebGLUniformLocation;
  private uMaxAltitude!: WebGLUniformLocation;
  private uSunDir!: WebGLUniformLocation;
  private uSkyColor!: WebGLUniformLocation;
  private uExposure!: WebGLUniformLocation;
  private uSnowMode!: WebGLUniformLocation;
  private uSnowOrigin!: WebGLUniformLocation;
  private uSnowScale!: WebGLUniformLocation;

  private previewProgram!: WebGLProgram;
  private previewVao: WebGLVertexArrayObject | null = null;
  private previewVbo: WebGLBuffer | null = null;
  private previewCbo: WebGLBuffer | null = null;
  private previewIbo: WebGLBuffer | null = null;
  private previewIndexCount = 0;
  private uPreviewViewProj!: WebGLUniformLocation;
  private uPreviewElevationExaggeration!: WebGLUniformLocation;
  private uPreviewSunDir!: WebGLUniformLocation;

  private indexCount = 0;
  private uses32BitIndex = true;

  elevationExaggeration = 1.0;
  exposure = 1.05;
  sunDir: [number, number, number] = normalize3(0.42, 0.78, 0.55);
  skyColor: [number, number, number] = [0.55, 0.65, 0.85];

  constructor(canvas: HTMLCanvasElement, opts: { lowPower?: boolean } = {}) {
    const attempts: WebGLContextAttributes[] = opts.lowPower
      ? [
          { antialias: false, alpha: false, premultipliedAlpha: true, powerPreference: 'low-power', failIfMajorPerformanceCaveat: false, depth: true, stencil: false },
          { antialias: false, alpha: false, failIfMajorPerformanceCaveat: false },
          {},
        ]
      : [
          { antialias: true,  alpha: false, premultipliedAlpha: true, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false, depth: true, stencil: false },
          { antialias: true,  alpha: false, failIfMajorPerformanceCaveat: false },
          { antialias: false, alpha: false, failIfMajorPerformanceCaveat: false },
          {},
        ];

    let gl: WebGL2RenderingContext | null = null;
    for (const attr of attempts) {
      gl = canvas.getContext('webgl2', attr) as WebGL2RenderingContext | null;
      if (gl) break;
    }
    if (!gl) throw new Error('WebGL2 indisponible');
    this.gl = gl;

    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.rendererInfo = dbg
      ? `${gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)} | ${gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)}`
      : 'WebGL2';

    this.uses32BitIndex = true;

    this.compileProgram();
    this.compileAuxPrograms();
    this.createBuffers();
    this.configureGLState();
  }

  private compileProgram() {
    const gl = this.gl;
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const prog = gl.createProgram();
    if (!prog) throw new Error('createProgram failed');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) || '';
      gl.deleteProgram(prog);
      throw new Error(`Program link failed: ${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = prog;

    this.uViewProj   = mustLoc(gl, prog, 'u_viewProj');
    this.uElevationExaggeration = mustLoc(gl, prog, 'u_elevationExaggeration');
    this.uOrtho      = mustLoc(gl, prog, 'u_ortho');
    this.uSnow       = mustLoc(gl, prog, 'u_snow');
    this.uSlopeRamp  = mustLoc(gl, prog, 'u_slopeRamp');
    this.uSlopeEnabled = mustLoc(gl, prog, 'u_slopeEnabled');
    this.uSlopeOpacity = mustLoc(gl, prog, 'u_slopeOpacity');
    this.uAltitudeRamp = mustLoc(gl, prog, 'u_altitudeRamp');
    this.uAltitudeEnabled = mustLoc(gl, prog, 'u_altitudeEnabled');
    this.uAltitudeOpacity = mustLoc(gl, prog, 'u_altitudeOpacity');
    this.uShadowMap  = mustLoc(gl, prog, 'u_shadowMap');
    this.uSunlightMap = mustLoc(gl, prog, 'u_sunlightMap');
    this.uSunlightEnabled = mustLoc(gl, prog, 'u_sunlightEnabled');
    this.uSunColor   = mustLoc(gl, prog, 'u_sunColor');
    this.uSunIntensity = mustLoc(gl, prog, 'u_sunIntensity');
    this.uShadowEnabled = mustLoc(gl, prog, 'u_shadowEnabled');
    this.uShadowOpacity = mustLoc(gl, prog, 'u_shadowOpacity');
    this.uSunlightMapEnabled = mustLoc(gl, prog, 'u_sunlightMapEnabled');
    this.uSunlightMapOpacity = mustLoc(gl, prog, 'u_sunlightMapOpacity');
    this.uTerrainOrigin = mustLoc(gl, prog, 'u_terrainOrigin');
    this.uTerrainScale  = mustLoc(gl, prog, 'u_terrainScale');
    this.uCenterAltitude  = mustLoc(gl, prog, 'u_centerAltitude');
    this.uMaxAltitude     = mustLoc(gl, prog, 'u_maxAltitude');
    this.uSunDir     = mustLoc(gl, prog, 'u_sunDir');
    this.uSkyColor   = mustLoc(gl, prog, 'u_skyColor');
    this.uExposure   = mustLoc(gl, prog, 'u_exposure');
    this.uSnowMode   = mustLoc(gl, prog, 'u_snowMode');
    this.uSnowOrigin = mustLoc(gl, prog, 'u_snowOrigin');
    this.uSnowScale  = mustLoc(gl, prog, 'u_snowScale');

    // 1×1 placeholder snow texture
    this.snowTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.snowTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // 1×1 placeholder slope ramp texture
    this.slopeTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.slopeTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // 1×1 placeholder altitude ramp texture
    this.altitudeTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.altitudeTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // 1×1 placeholder shadow map texture (0 = lit)
    this.shadowTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // 1×1 placeholder sunlight map texture
    this.sunlightMapTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sunlightMapTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private compileAuxPrograms() {
    const gl = this.gl;

    // Compile preview program
    const pvs = compile(gl, gl.VERTEX_SHADER, PREVIEW_VERTEX_SHADER);
    const pfs = compile(gl, gl.FRAGMENT_SHADER, PREVIEW_FRAGMENT_SHADER);
    const pprog = gl.createProgram();
    if (!pprog) throw new Error('createProgram for preview failed');
    gl.attachShader(pprog, pvs);
    gl.attachShader(pprog, pfs);
    gl.linkProgram(pprog);
    gl.deleteShader(pvs);
    gl.deleteShader(pfs);
    this.previewProgram = pprog;
    this.uPreviewViewProj = mustLoc(gl, pprog, 'u_viewProj');
    this.uPreviewElevationExaggeration = mustLoc(gl, pprog, 'u_elevationExaggeration');
    this.uPreviewSunDir = mustLoc(gl, pprog, 'u_sunDir');

    // Compile trajectory program
    const tvs = compile(gl, gl.VERTEX_SHADER, TRAJECTORY_VERTEX_SHADER);
    const tfs = compile(gl, gl.FRAGMENT_SHADER, TRAJECTORY_FRAGMENT_SHADER);
    const tprog = gl.createProgram();
    if (!tprog) throw new Error('createProgram for trajectory failed');
    gl.attachShader(tprog, tvs);
    gl.attachShader(tprog, tfs);
    gl.linkProgram(tprog);
    gl.deleteShader(tvs);
    gl.deleteShader(tfs);
    this.trajectoryProgram = tprog;
    this.uTrajectoryViewProj = mustLoc(gl, tprog, 'u_viewProj');

    // Compile sun disc program
    const dvs = compile(gl, gl.VERTEX_SHADER, SUN_DISC_VERTEX_SHADER);
    const dfs = compile(gl, gl.FRAGMENT_SHADER, SUN_DISC_FRAGMENT_SHADER);
    const dprog = gl.createProgram();
    if (!dprog) throw new Error('createProgram for sun disc failed');
    gl.attachShader(dprog, dvs);
    gl.attachShader(dprog, dfs);
    gl.linkProgram(dprog);
    gl.deleteShader(dvs);
    gl.deleteShader(dfs);
    this.sunDiscProgram = dprog;
    this.uSunDiscViewProj = mustLoc(gl, dprog, 'u_viewProj');
    this.uSunDiscPos = mustLoc(gl, dprog, 'u_sunDiscPos');
    this.uSunDiscRadius = mustLoc(gl, dprog, 'u_sunDiscRadius');
    this.uSunDiscCamRight = mustLoc(gl, dprog, 'u_camRight');
    this.uSunDiscCamUp = mustLoc(gl, dprog, 'u_camUp');
    this.uSunDiscColor = mustLoc(gl, dprog, 'u_sunColor');
    this.uSunDiscIntensity = mustLoc(gl, dprog, 'u_sunIntensity');

    // Compile route program
    const rvs = compile(gl, gl.VERTEX_SHADER, ROUTE_VERTEX_SHADER);
    const rfs = compile(gl, gl.FRAGMENT_SHADER, ROUTE_FRAGMENT_SHADER);
    const rprog = gl.createProgram();
    if (!rprog) throw new Error('createProgram for route failed');
    gl.attachShader(rprog, rvs);
    gl.attachShader(rprog, rfs);
    gl.linkProgram(rprog);
    gl.deleteShader(rvs);
    gl.deleteShader(rfs);
    this.routeProgram = rprog;
    this.uRouteViewProj = mustLoc(gl, rprog, 'u_viewProj');

    // Create quad buffer for sun disc billboard
    this.sunDiscVao = gl.createVertexArray();
    this.sunDiscVbo = gl.createBuffer();
    gl.bindVertexArray(this.sunDiscVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sunDiscVbo);
    const quadVerts = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private createBuffers() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    const ibo = gl.createBuffer();
    if (!vao || !vbo || !ibo) throw new Error('GL buffer alloc failed');
    this.vao = vao;
    this.vbo = vbo;
    this.ibo = ibo;

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const stride = 8 * 4; // 8 floats × 4 bytes
    // pos
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    // normal
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
    // uv
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 6 * 4);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bindVertexArray(null);
  }

  private configureGLState() {
    const gl = this.gl;
    gl.clearColor(0.04, 0.05, 0.08, 1.0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.CULL_FACE);
  }

  uploadMesh(data: TerrainGPUData): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.indexCount = data.indexCount;
  }

  uploadOrtho(bitmap: ImageBitmap): void {
    const gl = this.gl;
    if (!this.texture) this.texture = gl.createTexture();
    if (!this.texture) throw new Error('createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8,
      bitmap.width, bitmap.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, bitmap as unknown as TexImageSource,
    );
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic')
      || gl.getExtension('MOZ_EXT_texture_filter_anisotropic')
      || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
    if (aniso) {
      const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
      gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, max));
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  resize(w: number, h: number): void {
    const gl = this.gl;
    if (gl.canvas.width !== w || gl.canvas.height !== h) {
      gl.canvas.width = w;
      gl.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
  }

  static multiplyMat4(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += b[k * 4 + r] * a[c * 4 + k];
        out[c * 4 + r] = s;
      }
    }
    return out;
  }

  render(viewProj: Float32Array, viewMatrix?: Float32Array): void {
    const gl = this.gl;
    if (!this.indexCount) return;

    const clearR = this.sunlightEnabled ? this.skyColor[0] : 0.76;
    const clearG = this.sunlightEnabled ? this.skyColor[1] : 0.87;
    const clearB = this.sunlightEnabled ? this.skyColor[2] : 0.96;
    gl.clearColor(clearR, clearG, clearB, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uViewProj, false, viewProj);
    gl.uniform1f(this.uElevationExaggeration, this.elevationExaggeration);
    gl.uniform3f(this.uSunDir, this.sunDir[0], this.sunDir[1], this.sunDir[2]);
    gl.uniform3f(this.uSunColor, this.sunColor[0], this.sunColor[1], this.sunColor[2]);
    gl.uniform1f(this.uSunIntensity, this.sunIntensity);
    gl.uniform3f(this.uSkyColor, this.skyColor[0], this.skyColor[1], this.skyColor[2]);
    gl.uniform1f(this.uExposure, this.exposure);
    gl.uniform1i(this.uSunlightEnabled, this.sunlightEnabled);

    if (this.texture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(this.uOrtho, 0);
    }
    if (this.snowTexture) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.snowTexture);
      gl.uniform1i(this.uSnow, 1);
    }
    if (this.slopeTexture) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.slopeTexture);
      gl.uniform1i(this.uSlopeRamp, 2);
    }
    if (this.altitudeTexture) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.altitudeTexture);
      gl.uniform1i(this.uAltitudeRamp, 3);
    }
    if (this.shadowTexture) {
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
      gl.uniform1i(this.uShadowMap, 4);
    }
    if (this.sunlightMapTexture) {
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, this.sunlightMapTexture);
      gl.uniform1i(this.uSunlightMap, 5);
    }

    gl.uniform1i(this.uShadowEnabled, this.shadowEnabled);
    gl.uniform1f(this.uShadowOpacity, this.shadowOpacity);
    gl.uniform1i(this.uSunlightMapEnabled, this.sunlightMapEnabled);
    gl.uniform1f(this.uSunlightMapOpacity, this.sunlightMapOpacity);

    gl.uniform1i(this.uSnowMode, this.snowMode);
    gl.uniform2f(this.uSnowOrigin, this.snowOriginX, this.snowOriginZ);
    gl.uniform2f(this.uSnowScale, this.snowScaleX, this.snowScaleZ);
    gl.uniform2f(this.uTerrainOrigin, this.terrainOriginX, this.terrainOriginZ);
    gl.uniform2f(this.uTerrainScale, this.terrainScaleX, this.terrainScaleZ);

    gl.uniform1i(this.uSlopeEnabled, this.slopeEnabled);
    gl.uniform1f(this.uSlopeOpacity, this.slopeOpacity);
    gl.uniform1i(this.uAltitudeEnabled, this.altitudeEnabled);
    gl.uniform1f(this.uAltitudeOpacity, this.altitudeOpacity);
    gl.uniform1f(this.uCenterAltitude, this.centerAltitude);
    gl.uniform1f(this.uMaxAltitude, this.maxAltitude);

    gl.bindVertexArray(this.vao);
    gl.drawElements(
      gl.TRIANGLES,
      this.indexCount,
      this.uses32BitIndex ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      0,
    );
    gl.bindVertexArray(null);

    // Draw preview mesh box (if active)
    if (this.previewIndexCount > 0 && this.previewVao) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.previewProgram);
      gl.uniformMatrix4fv(this.uPreviewViewProj, false, viewProj);
      gl.uniform1f(this.uPreviewElevationExaggeration, this.elevationExaggeration);
      gl.uniform3f(this.uPreviewSunDir, this.sunDir[0], this.sunDir[1], this.sunDir[2]);

      gl.bindVertexArray(this.previewVao);
      gl.drawElements(gl.TRIANGLES, this.previewIndexCount, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }

    // Draw 3D Sun Trajectory Arc (if active)
    if (this.trajectoryEnabled && this.trajectoryVertexCount > 1 && this.trajectoryVao) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive glow
      gl.useProgram(this.trajectoryProgram);
      gl.uniformMatrix4fv(this.uTrajectoryViewProj, false, viewProj);

      gl.bindVertexArray(this.trajectoryVao);
      gl.lineWidth(2.5);
      gl.drawArrays(gl.LINE_STRIP, 0, this.trajectoryVertexCount);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }

    // Draw 3D Celestial Sun Disc Billboard (if active)
    if (this.trajectoryEnabled && this.sunDiscPos && this.sunDiscVao && viewMatrix) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive glow
      gl.disable(gl.DEPTH_TEST);

      gl.useProgram(this.sunDiscProgram);
      gl.uniformMatrix4fv(this.uSunDiscViewProj, false, viewProj);
      gl.uniform3f(this.uSunDiscPos, this.sunDiscPos[0], this.sunDiscPos[1], this.sunDiscPos[2]);
      gl.uniform1f(this.uSunDiscRadius, this.sunDiscRadius);

      // Extract camera right & up from view matrix
      gl.uniform3f(this.uSunDiscCamRight, viewMatrix[0], viewMatrix[4], viewMatrix[8]);
      gl.uniform3f(this.uSunDiscCamUp, viewMatrix[1], viewMatrix[5], viewMatrix[9]);

      gl.uniform3f(this.uSunDiscColor, this.sunColor[0], this.sunColor[1], this.sunColor[2]);
      gl.uniform1f(this.uSunDiscIntensity, this.sunIntensity);

      gl.bindVertexArray(this.sunDiscVao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);

      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
    }

    // Draw 3D GPX Route Ribbon (if active)
    if (this.routeIndexCount > 0 && this.routeVao) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.routeProgram);
      gl.uniformMatrix4fv(this.uRouteViewProj, false, viewProj);

      gl.bindVertexArray(this.routeVao);
      gl.drawElements(gl.TRIANGLES, this.routeIndexCount, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }
  }

  setTerrainBounds(bounds: {
    originX: number;
    originZ: number;
    scaleX: number;
    scaleZ: number;
  }): void {
    this.terrainOriginX = bounds.originX;
    this.terrainOriginZ = bounds.originZ;
    this.terrainScaleX = bounds.scaleX;
    this.terrainScaleZ = bounds.scaleZ;
  }

  setSlopeState(state: ViewerSlopeState): void {
    this.slopeEnabled = state.enabled ? 1 : 0;
    this.slopeOpacity = (state.opacity ?? 50) / 100;
    if (state.bands && state.bands.length > 0) {
      this.slopeTexture = updateSlopeRampTexture(
        this.gl,
        this.slopeTexture,
        state.bands,
        state.colorization as any,
      );
    }
  }

  setAltitudeState(state: ViewerAltitudeState): void {
    this.altitudeEnabled = state.enabled ? 1 : 0;
    this.altitudeOpacity = (state.opacity ?? 50) / 100;
    if (state.bands && state.bands.length > 0) {
      this.altitudeTexture = updateAltitudeRampTexture(
        this.gl,
        this.altitudeTexture,
        state.bands,
        state.colorization as any,
        this.maxAltitude || DEFAULT_MAX_ALTITUDE_M,
      );
    }
  }

  setSunlightRenderState(state: SolarRenderState): void {

    const gl = this.gl;
    this.sunlightEnabled = state.enabled ? 1 : 0;
    this.sunDir = state.sunDir;
    this.sunColor = state.sunColor;
    this.sunIntensity = state.sunIntensity;
    this.skyColor = state.skyColor;
    this.exposure = state.exposure;

    this.shadowEnabled = (state.enabled && state.shadowEnabled) ? 1 : 0;
    this.shadowOpacity = state.shadowOpacity;

    if (state.shadowMapData && state.shadowMapWidth > 0 && state.shadowMapHeight > 0) {
      if (!this.shadowTexture) this.shadowTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.R8,
        state.shadowMapWidth, state.shadowMapHeight, 0,
        gl.RED, gl.UNSIGNED_BYTE, state.shadowMapData,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    this.sunlightMapEnabled = (state.enabled && state.sunlightMapEnabled) ? 1 : 0;
    this.sunlightMapOpacity = state.sunlightMapOpacity;

    if (state.sunlightMapRgba && state.sunlightMapWidth > 0 && state.sunlightMapHeight > 0) {
      if (!this.sunlightMapTexture) this.sunlightMapTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.sunlightMapTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA8,
        state.sunlightMapWidth, state.sunlightMapHeight, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, state.sunlightMapRgba,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    this.trajectoryEnabled = state.trajectoryEnabled && state.enabled;
    this.sunDiscPos = state.sunDiscPos;
    this.sunDiscRadius = state.sunDiscRadius;

    if (state.trajectoryVertices && state.trajectoryVertexCount > 0) {
      if (!this.trajectoryVao) {
        this.trajectoryVao = gl.createVertexArray();
        this.trajectoryVbo = gl.createBuffer();
      }
      gl.bindVertexArray(this.trajectoryVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.trajectoryVbo);
      gl.bufferData(gl.ARRAY_BUFFER, state.trajectoryVertices, gl.DYNAMIC_DRAW);

      const stride = 7 * 4; // pos.xyz (3) + col.rgba (4)
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 3 * 4);
      gl.bindVertexArray(null);
      this.trajectoryVertexCount = state.trajectoryVertexCount;
    } else {
      this.trajectoryVertexCount = 0;
    }
  }

  setPreviewMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array): void {
    const gl = this.gl;
    if (indices.length === 0) {
      this.clearPreviewMesh();
      return;
    }
    if (!this.previewVao) {
      this.previewVao = gl.createVertexArray();
      this.previewVbo = gl.createBuffer();
      this.previewCbo = gl.createBuffer();
      this.previewIbo = gl.createBuffer();
    }
    gl.bindVertexArray(this.previewVao);

    // vertices: stride 6 floats (pos: 3, normal: 3)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.previewVbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 6 * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 6 * 4, 3 * 4);

    // colors: stride 4 bytes (RGBA unorm)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.previewCbo);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    // indices
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.previewIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);

    gl.bindVertexArray(null);
    this.previewIndexCount = indices.length;
  }

  clearPreviewMesh(): void {
    this.previewIndexCount = 0;
  }

  setRouteMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array, count?: number): void {
    const gl = this.gl;
    if (indices.length === 0 || vertices.length === 0) {
      this.clearRouteMesh();
      return;
    }
    if (!this.routeVao) {
      this.routeVao = gl.createVertexArray();
      this.routeVboPos = gl.createBuffer();
      this.routeVboCol = gl.createBuffer();
      this.routeIbo = gl.createBuffer();
    }
    gl.bindVertexArray(this.routeVao);

    // Positions (Location 0: vec3 float)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.routeVboPos);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    // Colors (Location 1: vec4 unsigned byte normalized)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.routeVboCol);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    // Indices
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.routeIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);

    gl.bindVertexArray(null);
    this.routeIndexCount = count ?? indices.length;
  }

  clearRouteMesh(): void {
    this.routeIndexCount = 0;
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
    gl.deleteVertexArray(this.vao);
    if (this.previewVbo) gl.deleteBuffer(this.previewVbo);
    if (this.previewCbo) gl.deleteBuffer(this.previewCbo);
    if (this.previewIbo) gl.deleteBuffer(this.previewIbo);
    if (this.previewVao) gl.deleteVertexArray(this.previewVao);
    if (this.trajectoryVbo) gl.deleteBuffer(this.trajectoryVbo);
    if (this.trajectoryVao) gl.deleteVertexArray(this.trajectoryVao);
    if (this.sunDiscVbo) gl.deleteBuffer(this.sunDiscVbo);
    if (this.sunDiscVao) gl.deleteVertexArray(this.sunDiscVao);
    if (this.routeVboPos) gl.deleteBuffer(this.routeVboPos);
    if (this.routeVboCol) gl.deleteBuffer(this.routeVboCol);
    if (this.routeIbo) gl.deleteBuffer(this.routeIbo);
    if (this.routeVao) gl.deleteVertexArray(this.routeVao);
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.snowTexture) gl.deleteTexture(this.snowTexture);
    if (this.slopeTexture) gl.deleteTexture(this.slopeTexture);
    if (this.altitudeTexture) gl.deleteTexture(this.altitudeTexture);
    if (this.shadowTexture) gl.deleteTexture(this.shadowTexture);
    if (this.sunlightMapTexture) gl.deleteTexture(this.sunlightMapTexture);
    gl.deleteProgram(this.program);
    if (this.previewProgram) gl.deleteProgram(this.previewProgram);
    if (this.trajectoryProgram) gl.deleteProgram(this.trajectoryProgram);
    if (this.sunDiscProgram) gl.deleteProgram(this.sunDiscProgram);
    if (this.routeProgram) gl.deleteProgram(this.routeProgram);
  }

  setCenterAltitude(centerAltitude: number, maxAltitude = DEFAULT_MAX_ALTITUDE_M): void {
    this.centerAltitude = centerAltitude;
    this.maxAltitude = maxAltitude;
  }

  setSnow(params: {
    data: Float32Array;
    width: number;
    height: number;
    originX: number;
    originZ: number;
    scaleX: number;
    scaleZ: number;
  }): void {
    const gl = this.gl;
    if (!this.snowTexture) this.snowTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.snowTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R32F,
      params.width, params.height, 0,
      gl.RED, gl.FLOAT, params.data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.snowOriginX = params.originX;
    this.snowOriginZ = params.originZ;
    this.snowScaleX = params.scaleX;
    this.snowScaleZ = params.scaleZ;
  }

  setSnowMode(mode: 0 | 1 | 2): void {
    this.snowMode = mode;
  }

  setElevationExaggeration(val: number): void {
    this.elevationExaggeration = Math.max(0.1, Math.min(10.0, val));
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || '';
    gl.deleteShader(sh);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return sh;
}

function mustLoc(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string): WebGLUniformLocation {
  const loc = gl.getUniformLocation(prog, name);
  if (!loc) throw new Error(`Uniform ${name} not found`);
  return loc;
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}
