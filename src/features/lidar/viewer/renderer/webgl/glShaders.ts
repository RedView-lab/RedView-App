// ============================================
// GLSL ES 3.00 shaders of the WebGL 2 backend
// ============================================
//
// Line-for-line ports of the WGSL shaders (../shaders/*): same scene
// uniform block (std140 gives the WGSL `Camera` struct's offsets, so
// `packSceneUniforms` fills both), same overlays, lighting and shading.
// Differences imposed by WebGL 2:
//  - the point shading compute pass is a vertex shader captured by
//    transform feedback (one RGBA8 word per point, rasterisation off);
//  - per-node parameters are a uniform block bound per draw at the node's
//    slot (`bindBufferRange`, the WebGPU dynamic offset), the child mask
//    lives in it instead of a storage buffer;
//  - depth is conventional ([0, 1], cleared to 1, `LESS`) with a finite
//    projection: WebGL has no standard clip control (Firefox lacks
//    EXT_clip_control), so reversed-Z would gain nothing. The EDL pass
//    linearises it with the frame's near/far;
//  - render-target textures are bottom-up, so the passes need no y flip.

/** Texture units of the scene textures (fixed for every program). */
export const SCENE_TEXTURE_UNITS = {
  heightTex: 0,
  snowTex: 1,
  slopeTex: 2,
  altitudeTex: 3,
  shadowTex: 4,
  sunlightMapTex: 5,
} as const;
/** Texture units of the full-screen passes' inputs. */
export const PASS_TEXTURE_UNITS = { colorTex: 6, depthTex: 7, accumTex: 6 } as const;

/** Uniform block bindings. */
export const UBO_BINDING = { scene: 0, node: 1, pointParams: 2 } as const;

const HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

const SCENE_BLOCK = /* glsl */ `
layout(std140) uniform Scene {
  mat4 viewProj;
  vec4 right;
  vec4 up;
  vec4 cameraPos;
  float pointSize;
  float unused0;
  float viewportWidth;
  float viewportHeight;
  vec4 sunDir;
  float hmOriginX;
  float hmOriginZ;
  float hmScaleX;
  float hmScaleZ;
  float density;
  float centerAltitude;
  float maxAltitude;
  float colorMode;
  float snowMode;
  float snowOriginX;
  float snowOriginZ;
  float snowScaleX;
  float snowScaleZ;
  float slopeEnabled;
  float slopeOpacity;
  float altitudeEnabled;
  float altitudeOpacity;
  float sunlightEnabled;
  float shadowEnabled;
  float shadowOpacity;
  float sunlightMapEnabled;
  float sunlightMapOpacity;
  float sunIntensity;
  float exposure;
  vec4 sunColor;
  vec4 skyColor;
  vec3 sunDiscPos;
  float sunDiscRadius;
  float pointFilterEnabled;
  float padFilter1;
  float padFilter2;
  float padFilter3;
  uvec4 pointFilterMask;
} camera;
`;

const SCENE_TEXTURES = /* glsl */ `
uniform sampler2D heightTex;
uniform sampler2D snowTex;
uniform sampler2D slopeTex;
uniform sampler2D altitudeTex;
uniform sampler2D shadowTex;
uniform sampler2D sunlightMapTex;
`;

/** Per-node record (32 bytes, one slot per resident node). */
const NODE_BLOCK = /* glsl */ `
layout(std140) uniform NodeParams {
  vec3 origin;
  float size;
  /** Spacing (m) the points grow to where no child is drawn; 0 for leaves. */
  float adaptiveSpacing;
  uint count;
  /** Octants (x | y << 1 | z << 2, CRS axes) covered by a drawn child this frame. */
  uint childMask;
  float pad0;
} node;
`;

const POINT_PARAMS_BLOCK = /* glsl */ `
layout(std140) uniform PointParams {
  float minPx;
  float maxPx;
  float fixedPx;
  float focalPx;
  float viewportW;
  float viewportH;
  float antialias;
  float worldSize;
  float adaptiveScale;
  float pad0;
  float pad1;
  float pad2;
} params;
`;

const COLOR_HELPERS = /* glsl */ `
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), greaterThan(c, vec3(0.04045)));
}

vec3 linearToSrgb(vec3 c) {
  vec3 x = clamp(c, vec3(0.0), vec3(1.0));
  return mix(x * 12.92, 1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055, greaterThan(x, vec3(0.0031308)));
}

bool isPointClassVisible(uint cls) {
  if (camera.pointFilterEnabled < 0.5) { return true; }
  if (cls < 32u) { return ((camera.pointFilterMask.x >> cls) & 1u) != 0u; }
  if (cls < 64u) { return ((camera.pointFilterMask.y >> (cls - 32u)) & 1u) != 0u; }
  if (cls < 96u) { return ((camera.pointFilterMask.z >> (cls - 64u)) & 1u) != 0u; }
  if (cls < 128u) { return ((camera.pointFilterMask.w >> (cls - 96u)) & 1u) != 0u; }
  return true;
}
`;

const OVERLAY_HELPERS = /* glsl */ `
/** Nearest node of a grid whose nodes span the scene bounds edge to edge. */
ivec2 gridNode(float u, float v, ivec2 dims) {
  vec2 maxNode = vec2(dims) - vec2(1.0);
  return ivec2(roundEven(clamp(vec2(u, v), vec2(0.0), vec2(1.0)) * maxNode));
}

float sampleSnowDepthCm(vec3 worldPos) {
  if (camera.snowMode < 0.5) { return 0.0; }
  float u = (worldPos.x - camera.snowOriginX) / camera.snowScaleX;
  float v = (worldPos.z - camera.snowOriginZ) / camera.snowScaleZ;
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) { return 0.0; }
  ivec2 dims = textureSize(snowTex, 0);
  vec2 dimsF = vec2(dims);
  int px = clamp(int(u * dimsF.x), 0, dims.x - 1);
  int py = clamp(int(v * dimsF.y), 0, dims.y - 1);
  return texelFetch(snowTex, ivec2(px, py), 0).r;
}

vec3 snowThicknessColor(float depthCm) {
  float t = clamp(depthCm / 200.0, 0.0, 1.0);
  float r = clamp(1.6 * t - 0.4, 0.0, 1.0);
  float g = clamp(1.0 - abs(t - 0.55) * 2.2, 0.0, 1.0);
  float b = clamp(1.0 - t * 1.4 + 0.15, 0.0, 1.0);
  return vec3(r, g, b);
}

vec3 applySnow(vec3 baseSrgb, vec3 worldPos) {
  if (camera.snowMode < 0.5) { return baseSrgb; }
  float depth = sampleSnowDepthCm(worldPos);
  if (camera.snowMode > 1.5) {
    if (depth <= 0.5) { return baseSrgb * 0.35; }
    return snowThicknessColor(depth);
  }
  float t = smoothstep(0.0, 30.0, depth) * 0.93;
  return mix(baseSrgb, vec3(0.97, 0.98, 1.0), t);
}

vec3 applySlope(vec3 baseSrgb, vec3 normal) {
  if (camera.slopeEnabled < 0.5 || camera.slopeOpacity <= 0.001) { return baseSrgb; }
  vec3 N = normalize(normal);
  float cosSlope = clamp(N.y, 0.0, 1.0);
  float slopeDeg = acos(cosSlope) * 57.29577951308232;
  float slopeU = clamp(slopeDeg / 90.0, 0.0, 1.0);
  vec4 slopeSample = textureLod(slopeTex, vec2(slopeU, 0.5), 0.0);
  if (slopeSample.a <= 0.0) { return baseSrgb; }
  return mix(baseSrgb, slopeSample.rgb, slopeSample.a * camera.slopeOpacity);
}

vec3 applyAltitude(vec3 baseSrgb, vec3 worldPos) {
  if (camera.altitudeEnabled < 0.5 || camera.altitudeOpacity <= 0.001) { return baseSrgb; }
  float realAltitude = worldPos.y + camera.centerAltitude;
  float altU = clamp(realAltitude / max(camera.maxAltitude, 1.0), 0.0, 1.0);
  vec4 altSample = textureLod(altitudeTex, vec2(altU, 0.5), 0.0);
  if (altSample.a <= 0.0) { return baseSrgb; }
  return mix(baseSrgb, altSample.rgb, altSample.a * camera.altitudeOpacity);
}

vec3 applySunlightMap(vec3 baseSrgb, vec3 worldPos) {
  if (camera.sunlightEnabled < 0.5 || camera.sunlightMapEnabled < 0.5 || camera.sunlightMapOpacity <= 0.001) {
    return baseSrgb;
  }
  float u = (worldPos.x - camera.hmOriginX) / camera.hmScaleX;
  float v = (worldPos.z - camera.hmOriginZ) / camera.hmScaleZ;
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) { return baseSrgb; }
  vec4 smSample = texelFetch(sunlightMapTex, gridNode(u, v, textureSize(sunlightMapTex, 0)), 0);
  if (smSample.a <= 0.0) { return baseSrgb; }
  return mix(baseSrgb, smSample.rgb, smSample.a * camera.sunlightMapOpacity);
}

float sampleCastShadow(vec3 worldPos) {
  if (camera.sunlightEnabled < 0.5 || camera.shadowEnabled < 0.5 || camera.shadowOpacity <= 0.001) { return 0.0; }
  float u = (worldPos.x - camera.hmOriginX) / camera.hmScaleX;
  float v = (worldPos.z - camera.hmOriginZ) / camera.hmScaleZ;
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) { return 0.0; }
  return texelFetch(shadowTex, gridNode(u, v, textureSize(shadowTex, 0)), 0).r;
}
`;

const HEIGHT_HELPERS = /* glsl */ `
ivec2 heightmapTexel(vec3 worldPos) {
  float u = (worldPos.x - camera.hmOriginX) / camera.hmScaleX;
  float v = (worldPos.z - camera.hmOriginZ) / camera.hmScaleZ;
  return gridNode(u, v, textureSize(heightTex, 0));
}

/** Ground (DTM) height under a point, in the centred render frame. */
float sampleGroundHeight(vec3 worldPos) {
  return texelFetch(heightTex, heightmapTexel(worldPos), 0).r;
}

/** DTM normal under a point (central differences on the ground heightmap). */
vec3 computeSobelNormal(vec3 worldPos) {
  ivec2 dimsI = textureSize(heightTex, 0);
  vec2 dims = vec2(dimsI);
  ivec2 maxCoord = dimsI - ivec2(1);
  ivec2 center = heightmapTexel(worldPos);

  int xR = clamp(center.x + 1, 0, maxCoord.x);
  int xL = clamp(center.x - 1, 0, maxCoord.x);
  int yS = clamp(center.y + 1, 0, maxCoord.y);
  int yN = clamp(center.y - 1, 0, maxCoord.y);

  float hR = texelFetch(heightTex, ivec2(xR, center.y), 0).r;
  float hL = texelFetch(heightTex, ivec2(xL, center.y), 0).r;
  float hS = texelFetch(heightTex, ivec2(center.x, yS), 0).r;
  float hN = texelFetch(heightTex, ivec2(center.x, yN), 0).r;

  float cellWorldX = camera.hmScaleX / max(dims.x - 1.0, 1.0);
  float cellWorldZ = camera.hmScaleZ / max(dims.y - 1.0, 1.0);

  float dzdx = (hR - hL) / (2.0 * cellWorldX);
  float dzdz = (hS - hN) / (2.0 * cellWorldZ);

  return normalize(vec3(-dzdx, 1.0, -dzdz));
}
`;

const LIGHTING_HELPERS = /* glsl */ `
vec3 shadeSurface(vec3 N, vec3 baseColorSrgb, vec3 worldPos) {
  vec3 baseColor = srgbToLinear(baseColorSrgb);
  vec3 L = normalize(camera.sunDir.xyz);
  float ndotl = clamp(dot(N, L), 0.0, 1.0);

  if (camera.sunlightEnabled > 0.5) {
    float castShadow = sampleCastShadow(worldPos);
    float directLit = ndotl * (1.0 - castShadow) * camera.sunIntensity;
    float shadowDarkness = camera.shadowOpacity;
    float shadowMask = clamp(1.0 - (1.0 - directLit) * shadowDarkness, 0.0, 1.0);
    vec3 directSun = baseColor * camera.sunColor.rgb * directLit;
    float upFacing = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 ambientBase = baseColor * camera.skyColor.rgb * (0.18 + 0.22 * upFacing);
    vec3 lit = (directSun + ambientBase * shadowMask) * camera.exposure;
    return linearToSrgb(lit);
  }

  float diffuse = dot(N, L) * 0.5 + 0.5;
  float lighting = 0.15 + 0.85 * diffuse;
  return linearToSrgb(baseColor * lighting);
}
`;

// ── Points ────────────────────────────────────────────────────────────────

export const POINT_VS = `${HEADER}${SCENE_BLOCK}${NODE_BLOCK}${POINT_PARAMS_BLOCK}${COLOR_HELPERS}
// Packed record: u16×3 quantized position (+ class|intensity), see lodTile.ts.
layout(location = 0) in vec4 a_q;
// Pre-shaded colour written by the shading pass (a = class / 255).
layout(location = 1) in vec4 a_col;

flat out vec3 v_color;
out vec2 v_uv;
flat out float v_px;

void main() {
  uint cls = uint(a_col.a * 255.0 + 0.5);
  vec2 uv = vec2((gl_VertexID & 1) != 0 ? 1.0 : -1.0, (gl_VertexID & 2) != 0 ? 1.0 : -1.0);
  // Quantized CRS axes (east, north, up) → render frame (east, up, −north).
  vec3 pos = node.origin + vec3(a_q.x, a_q.z, -a_q.y) * node.size;
  vec4 clip = camera.viewProj * vec4(pos, 1.0);

  float px = params.fixedPx;
  if (px <= 0.0) {
    float worldSize = params.worldSize;
    uint octant = (a_q.x >= 0.5 ? 1u : 0u) | (a_q.y >= 0.5 ? 2u : 0u) | (a_q.z >= 0.5 ? 4u : 0u);
    if (((node.childMask >> octant) & 1u) == 0u) {
      worldSize = max(worldSize, node.adaptiveSpacing * params.adaptiveScale);
    }
    px = worldSize * params.focalPx / max(clip.w, 1e-4);
  }
  px = clamp(px, params.minPx, params.maxPx);
  float shown = isPointClassVisible(cls) ? px : 0.0;
  vec2 halfNdc = shown / vec2(params.viewportW, params.viewportH);

  gl_Position = vec4(clip.xy + uv * halfNdc * clip.w, clip.z, clip.w);
  v_color = a_col.rgb;
  v_uv = uv;
  v_px = px;
}
`;

export const POINT_FS = `${HEADER}${POINT_PARAMS_BLOCK}
flat in vec3 v_color;
in vec2 v_uv;
flat in float v_px;
out vec4 fragColor;

void main() {
  float r = length(v_uv);
  // Below ~2.5 px a disc would lose its only covered pixel: draw a square.
  if (v_px > 2.5 && r > 1.0) { discard; }
  float alpha = 1.0;
  if (params.antialias > 0.5 && v_px > 2.5) {
    // About one pixel of soft edge, resolved by alpha-to-coverage (MSAA).
    alpha = clamp((1.0 - r) * v_px * 0.5 + 0.5, 0.0, 1.0);
  }
  fragColor = vec4(v_color, alpha);
}
`;

/** While the camera moves: plain squares, no discard, so depth is tested before shading. */
export const POINT_SQUARE_FS = `${HEADER}
flat in vec3 v_color;
in vec2 v_uv;
flat in float v_px;
out vec4 fragColor;

void main() {
  fragColor = vec4(v_color, 1.0);
}
`;

/** Transform-feedback output of the shading pass. */
export const SHADING_VARYINGS = ['v_shaded'];

/**
 * Point shading (the WGSL compute pass `shade_main`): one pre-shaded RGBA8
 * word per point, rgb = final colour, a = classification. See
 * POINT_SHADING_SHADER for the rules (ground lighting, cell-filtered
 * colours where no child is drawn).
 */
export const SHADING_VS = `${HEADER}${SCENE_BLOCK}${SCENE_TEXTURES}${NODE_BLOCK}${COLOR_HELPERS}${OVERLAY_HELPERS}${HEIGHT_HELPERS}${LIGHTING_HELPERS}
// Words: x|y, z|class|intensity, rgb|filtered intensity, filtered rgb.
layout(location = 0) in uvec4 a_words;
flat out uint v_shaded;

bool isGroundPoint(uint cls, vec3 p) {
  if (cls == 2u || cls == 9u) { return true; }
  if (cls <= 1u) { return abs(p.y - sampleGroundHeight(p)) < 0.5; }
  return false;
}

/** ASPRS / IGN LiDAR HD classes. */
vec3 classificationColor(uint cls) {
  if (cls == 2u) { return vec3(0.70, 0.56, 0.38); }
  if (cls == 3u) { return vec3(0.62, 0.82, 0.38); }
  if (cls == 4u) { return vec3(0.33, 0.68, 0.27); }
  if (cls == 5u) { return vec3(0.13, 0.47, 0.17); }
  if (cls == 6u) { return vec3(0.86, 0.31, 0.24); }
  if (cls == 7u || cls == 18u) { return vec3(0.92, 0.25, 0.86); }
  if (cls == 9u) { return vec3(0.20, 0.47, 0.88); }
  if (cls == 17u) { return vec3(0.62, 0.62, 0.68); }
  if (cls == 64u) { return vec3(0.95, 0.66, 0.22); }
  if (cls == 65u) { return vec3(0.55, 0.20, 0.55); }
  if (cls == 66u) { return vec3(0.45, 0.80, 0.85); }
  if (cls == 67u) { return vec3(0.80, 0.80, 0.40); }
  return vec3(0.78, 0.78, 0.78);
}

vec3 unpackRgb(uint w) {
  return vec3(float(w & 255u), float((w >> 8u) & 255u), float((w >> 16u) & 255u)) / 255.0;
}

/** WGSL pack4x8unorm: x in the low byte. */
uint packUnorm8x4(vec4 v) {
  uvec4 b = uvec4(floor(clamp(v, vec4(0.0), vec4(1.0)) * 255.0 + 0.5));
  return b.x | (b.y << 8u) | (b.z << 16u) | (b.w << 24u);
}

void main() {
  uint w0 = a_words.x;
  uint w1 = a_words.y;
  uint w2 = a_words.z;
  uint w3 = a_words.w;
  vec3 q = vec3(float(w0 & 0xffffu), float(w0 >> 16u), float(w1 & 0xffffu)) / 65535.0;
  vec3 p = node.origin + vec3(q.x, q.z, -q.y) * node.size;
  uint cls = (w1 >> 16u) & 0xffu;
  uint octant = (q.x >= 0.5 ? 1u : 0u) | (q.y >= 0.5 ? 2u : 0u) | (q.z >= 0.5 ? 4u : 0u);
  bool finest = ((node.childMask >> octant) & 1u) == 0u;
  float intensity = float(finest ? (w2 >> 24u) : (w1 >> 24u)) / 255.0;

  vec3 base = unpackRgb(finest ? w3 : w2);
  if (camera.colorMode > 2.5) {
    // Uniform grey: only the lighting and EDL draw the relief.
    base = vec3(0.8);
  } else if (camera.colorMode > 1.5) {
    base = classificationColor(cls);
  } else if (camera.colorMode > 0.5) {
    base = vec3(pow(intensity, 0.8));
  }

  vec3 terrainNormal = computeSobelNormal(p);
  vec3 c = applySnow(base, p);
  c = applySlope(c, terrainNormal);
  c = applyAltitude(c, p);
  c = applySunlightMap(c, p);

  vec3 N = isGroundPoint(cls, p) ? terrainNormal : vec3(0.0, 1.0, 0.0);
  vec3 lit = shadeSurface(N, c, p);
  v_shaded = packUnorm8x4(vec4(lit, float(cls) / 255.0));
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
}
`;

/** Rasterisation is off during the shading pass; a program still needs a fragment stage. */
export const SHADING_FS = `${HEADER}
out vec4 fragColor;
void main() {
  fragColor = vec4(0.0);
}
`;

// ── Terrain and meshes ────────────────────────────────────────────────────

/**
 * Terrain (chunked LOD and the tile preview): `u_pushBack` moves the chunk
 * away from the eye along the view rays by its height error (0 for the
 * preview), see terrainLodCore.ts.
 */
export const TERRAIN_VS = `${HEADER}${SCENE_BLOCK}
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec4 a_color;
uniform float u_pushBack;

out vec4 v_color;
out vec3 v_normal;
out vec3 v_worldPos;

void main() {
  vec3 toVertex = a_position - camera.cameraPos.xyz;
  vec3 pushed = a_position + toVertex * (u_pushBack / max(length(toVertex), 1e-3));
  gl_Position = camera.viewProj * vec4(pushed, 1.0);
  v_color = a_color;
  v_normal = a_normal;
  v_worldPos = a_position;
}
`;

/** Lit exactly like the ground points (same shadeSurface). */
export const TERRAIN_FS = `${HEADER}${SCENE_BLOCK}${SCENE_TEXTURES}${COLOR_HELPERS}${OVERLAY_HELPERS}${LIGHTING_HELPERS}
in vec4 v_color;
in vec3 v_normal;
in vec3 v_worldPos;
out vec4 fragColor;

void main() {
  vec3 snowed = applySnow(v_color.rgb, v_worldPos);
  vec3 sloped = applySlope(snowed, v_normal);
  vec3 altituded = applyAltitude(sloped, v_worldPos);
  vec3 colored = applySunlightMap(altituded, v_worldPos);
  fragColor = vec4(shadeSurface(normalize(v_normal), colored, v_worldPos), v_color.a);
}
`;

/** Route ribbon, analysis zones and the sun trajectory: position + colour, drawn as is. */
export const COLOR_MESH_VS = `${HEADER}${SCENE_BLOCK}
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color;
out vec4 v_color;

void main() {
  gl_Position = camera.viewProj * vec4(a_position, 1.0);
  v_color = a_color;
}
`;

export const COLOR_MESH_FS = `${HEADER}
in vec4 v_color;
out vec4 fragColor;

void main() {
  fragColor = v_color;
}
`;

export const SUN_DISC_VS = `${HEADER}${SCENE_BLOCK}
out vec2 v_localUV;

void main() {
  int vi = gl_VertexID;
  vec2 uv = vec2(-1.0, -1.0);
  if (vi == 1 || vi == 4) {
    uv = vec2(1.0, -1.0);
  } else if (vi == 2 || vi == 3) {
    uv = vec2(-1.0, 1.0);
  } else if (vi == 5) {
    uv = vec2(1.0, 1.0);
  }
  v_localUV = uv;
  vec3 worldPos = camera.sunDiscPos + (uv.x * camera.right.xyz + uv.y * camera.up.xyz) * camera.sunDiscRadius;
  gl_Position = camera.viewProj * vec4(worldPos, 1.0);
}
`;

export const SUN_DISC_FS = `${HEADER}${SCENE_BLOCK}
in vec2 v_localUV;
out vec4 fragColor;

void main() {
  float dist = length(v_localUV);
  if (dist > 1.0) { discard; }
  // The WGSL steps from 0.35 down to 0.05; GLSL leaves reversed edges undefined.
  float core = 1.0 - smoothstep(0.05, 0.35, dist);
  float corona = exp(-dist * 4.5) * 0.75;
  float glow = exp(-dist * 2.0) * 0.35;
  float brightness = clamp(core + corona + glow, 0.0, 1.0) * max(camera.sunIntensity, 0.15);
  vec3 white = vec3(1.0, 1.0, 0.98);
  vec3 col = mix(camera.sunColor.rgb, white, core);
  fragColor = vec4(col * brightness, brightness);
}
`;

// ── Full-screen passes ────────────────────────────────────────────────────

/** One triangle covering the target; `v_uv` = texture coordinates (bottom-up, as GL targets). */
export const FULLSCREEN_VS = `${HEADER}
out vec2 v_uv;

void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Upscales a scene rendered below the canvas resolution (or copies it 1:1). */
export const BLIT_FS = `${HEADER}
uniform sampler2D colorTex;
in vec2 v_uv;
out vec4 fragColor;

void main() {
  fragColor = vec4(textureLod(colorTex, v_uv, 0.0).rgb, 1.0);
}
`;

/**
 * Eye-Dome Lighting (see ../shaders/edlShader.ts). The log of the eye
 * distance is rebuilt from the conventional depth with the frame's near/far.
 * `u_edl` = (strength, radius px, enabled, scene target / canvas scale).
 */
const EDL_COMMON = /* glsl */ `
uniform sampler2D colorTex;
uniform sampler2D depthTex;
uniform vec4 u_edl;
uniform vec2 u_depthRange;

float viewDistance(float d) {
  float zNdc = d * 2.0 - 1.0;
  float n = u_depthRange.x;
  float f = u_depthRange.y;
  return 2.0 * n * f / (f + n - zNdc * (f - n));
}

vec3 edlColor(vec2 fragCoord) {
  ivec2 dims = textureSize(colorTex, 0);
  ivec2 c = min(ivec2(fragCoord * u_edl.w), dims - ivec2(1));
  vec3 color = texelFetch(colorTex, c, 0).rgb;
  if (u_edl.z < 0.5) { return color; }
  float d = texelFetch(depthTex, c, 0).r;
  if (d >= 1.0) { return color; }
  float centerLog = log2(viewDistance(d));
  float sum = 0.0;
  for (int k = 0; k < 8; k++) {
    float angle = float(k) * 0.7853981633974483;
    ivec2 offset = ivec2(roundEven(vec2(cos(angle), sin(angle)) * u_edl.y));
    float nd = texelFetch(depthTex, clamp(c + offset, ivec2(0), dims - ivec2(1)), 0).r;
    if (nd < 1.0) {
      sum += max(0.0, centerLog - log2(viewDistance(nd)));
    }
  }
  float response = sum / 8.0;
  float shade = exp(-response * 300.0 * u_edl.x);
  return color * shade;
}
`;

export const EDL_FS = `${HEADER}${EDL_COMMON}
out vec4 fragColor;

void main() {
  fragColor = vec4(edlColor(gl_FragCoord.xy), 1.0);
}
`;

/** EDL (or a plain copy) of a still frame in linear light, blended into the running mean. */
export const EDL_ACCUMULATE_FS = `${HEADER}${EDL_COMMON}
out vec4 fragColor;

void main() {
  vec3 c = clamp(edlColor(gl_FragCoord.xy), vec3(0.0), vec3(1.0));
  vec3 linear = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), greaterThan(c, vec3(0.04045)));
  fragColor = vec4(linear, 1.0);
}
`;

/** Strength of the sharpening of accumulated still frames (as PRESENT_SHADER). */
const PRESENT_SHARPNESS = 0.3;

/** Accumulation target (linear running mean) → canvas, with the light contrast-adaptive sharpening. */
export const PRESENT_FS = `${HEADER}
uniform sampler2D accumTex;
out vec4 fragColor;

vec3 accumAt(ivec2 p, ivec2 maxCoord) {
  return clamp(texelFetch(accumTex, clamp(p, ivec2(0), maxCoord), 0).rgb, vec3(0.0), vec3(1.0));
}

void main() {
  ivec2 maxCoord = textureSize(accumTex, 0) - ivec2(1);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c = accumAt(p, maxCoord);
  vec3 n = accumAt(p + ivec2(0, -1), maxCoord);
  vec3 s = accumAt(p + ivec2(0, 1), maxCoord);
  vec3 e = accumAt(p + ivec2(1, 0), maxCoord);
  vec3 w = accumAt(p + ivec2(-1, 0), maxCoord);
  vec3 lo = min(c, min(min(n, s), min(e, w)));
  vec3 hi = max(c, max(max(n, s), max(e, w)));
  vec3 amount = sqrt(clamp(min(lo, vec3(1.0) - hi) / max(hi, vec3(1e-4)), vec3(0.0), vec3(1.0)));
  vec3 weight = amount * (-1.0 / mix(8.0, 5.0, ${PRESENT_SHARPNESS.toFixed(2)}));
  vec3 sharp = clamp((c + (n + s + e + w) * weight) / (vec3(1.0) + 4.0 * weight), vec3(0.0), vec3(1.0));
  vec3 srgb = mix(sharp * 12.92, 1.055 * pow(sharp, vec3(1.0 / 2.4)) - 0.055, greaterThan(sharp, vec3(0.0031308)));
  fragColor = vec4(srgb, 1.0);
}
`;
