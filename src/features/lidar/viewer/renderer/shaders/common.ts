// ============================================
// WGSL Shader Components — Common Types & Functions
// ============================================

export const WGSL_CAMERA_STRUCT = /* wgsl */ `
struct Camera {
  viewProj: mat4x4<f32>,
  right: vec4<f32>,
  up: vec4<f32>,
  cameraPos: vec4<f32>,
  pointSize: f32,
  _unused0: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  sunDir: vec4<f32>,
  hmOriginX: f32,
  hmOriginZ: f32,
  hmScaleX: f32,
  hmScaleZ: f32,
  density: f32,
  centerAltitude: f32,
  maxAltitude: f32,
  colorMode: f32,
  snowMode: f32,
  snowOriginX: f32,
  snowOriginZ: f32,
  snowScaleX: f32,
  snowScaleZ: f32,
  slopeEnabled: f32,
  slopeOpacity: f32,
  altitudeEnabled: f32,
  altitudeOpacity: f32,
  sunlightEnabled: f32,
  shadowEnabled: f32,
  shadowOpacity: f32,
  sunlightMapEnabled: f32,
  sunlightMapOpacity: f32,
  sunIntensity: f32,
  exposure: f32,
  sunColor: vec4<f32>,
  skyColor: vec4<f32>,
  sunDiscPos: vec3<f32>,
  sunDiscRadius: f32,
  pointFilterEnabled: f32,
  _padFilter1: f32,
  _padFilter2: f32,
  _padFilter3: f32,
  pointFilterMask: vec4<u32>,
};
`;

/**
 * Group 0, shared by every scene pipeline (terrain, points, overlays) and by
 * the point shading compute pass. Shaders declare only what they use.
 */
export const WGSL_SCENE_BINDINGS = /* wgsl */ `
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(3) var snowTex: texture_2d<f32>;
@group(0) @binding(4) var slopeTex: texture_2d<f32>;
@group(0) @binding(5) var slopeSamp: sampler;
@group(0) @binding(6) var altitudeTex: texture_2d<f32>;
@group(0) @binding(7) var altitudeSamp: sampler;
@group(0) @binding(8) var shadowTex: texture_2d<f32>;
@group(0) @binding(9) var sunlightMapTex: texture_2d<f32>;
`;

export const WGSL_CAMERA_BINDING = /* wgsl */ `
@group(0) @binding(0) var<uniform> camera: Camera;
`;

export const WGSL_COLOR_HELPERS = /* wgsl */ `
fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
  return select(c / 12.92, pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c > vec3<f32>(0.04045));
}

fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
  let x = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  return select(x * 12.92, 1.055 * pow(x, vec3<f32>(1.0 / 2.4)) - 0.055, x > vec3<f32>(0.0031308));
}

fn isPointClassVisible(cls: u32) -> bool {
  if (camera.pointFilterEnabled < 0.5) {
    return true;
  }
  if (cls < 32u) {
    return ((camera.pointFilterMask.x >> cls) & 1u) != 0u;
  }
  if (cls < 64u) {
    return ((camera.pointFilterMask.y >> (cls - 32u)) & 1u) != 0u;
  }
  if (cls < 96u) {
    return ((camera.pointFilterMask.z >> (cls - 64u)) & 1u) != 0u;
  }
  if (cls < 128u) {
    return ((camera.pointFilterMask.w >> (cls - 96u)) & 1u) != 0u;
  }
  return true;
}
`;

export const WGSL_OVERLAY_HELPERS = /* wgsl */ `
/** Nearest node of a grid whose nodes span the scene bounds edge to edge
 *  (heightmap, cast-shadow and sunlight maps): u = 0 → node 0, u = 1 → node n − 1. */
fn gridNode(u: f32, v: f32, dims: vec2<u32>) -> vec2<i32> {
  let maxNode = vec2<f32>(dims) - vec2<f32>(1.0);
  return vec2<i32>(round(clamp(vec2<f32>(u, v), vec2<f32>(0.0), vec2<f32>(1.0)) * maxNode));
}

fn sampleSnowDepthCm(worldPos: vec3<f32>) -> f32 {
  if (camera.snowMode < 0.5) { return 0.0; }
  let u = (worldPos.x - camera.snowOriginX) / camera.snowScaleX;
  let v = (worldPos.z - camera.snowOriginZ) / camera.snowScaleZ;
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) { return 0.0; }
  let dims = textureDimensions(snowTex, 0);
  let dimsF = vec2<f32>(dims);
  let px = clamp(i32(u * dimsF.x), 0, i32(dims.x) - 1);
  let py = clamp(i32(v * dimsF.y), 0, i32(dims.y) - 1);
  return textureLoad(snowTex, vec2<i32>(px, py), 0).r;
}

fn snowThicknessColor(depthCm: f32) -> vec3<f32> {
  let t = clamp(depthCm / 200.0, 0.0, 1.0);
  let r = clamp(1.6 * t - 0.4, 0.0, 1.0);
  let g = clamp(1.0 - abs(t - 0.55) * 2.2, 0.0, 1.0);
  let b = clamp(1.0 - t * 1.4 + 0.15, 0.0, 1.0);
  return vec3<f32>(r, g, b);
}

fn applySnow(baseSrgb: vec3<f32>, worldPos: vec3<f32>) -> vec3<f32> {
  if (camera.snowMode < 0.5) { return baseSrgb; }
  let depth = sampleSnowDepthCm(worldPos);
  if (camera.snowMode > 1.5) {
    if (depth <= 0.5) { return baseSrgb * 0.35; }
    return snowThicknessColor(depth);
  }
  let t = smoothstep(0.0, 30.0, depth) * 0.93;
  return mix(baseSrgb, vec3<f32>(0.97, 0.98, 1.0), t);
}

fn applySlope(baseSrgb: vec3<f32>, normal: vec3<f32>) -> vec3<f32> {
  if (camera.slopeEnabled < 0.5 || camera.slopeOpacity <= 0.001) {
    return baseSrgb;
  }
  let N = normalize(normal);
  let cosSlope = clamp(N.y, 0.0, 1.0);
  let slopeDeg = acos(cosSlope) * 57.29577951308232;
  let slopeU = clamp(slopeDeg / 90.0, 0.0, 1.0);
  let slopeSample = textureSampleLevel(slopeTex, slopeSamp, vec2<f32>(slopeU, 0.5), 0.0);
  if (slopeSample.a <= 0.0) {
    return baseSrgb;
  }
  return mix(baseSrgb, slopeSample.rgb, slopeSample.a * camera.slopeOpacity);
}

fn applyAltitude(baseSrgb: vec3<f32>, worldPos: vec3<f32>) -> vec3<f32> {
  if (camera.altitudeEnabled < 0.5 || camera.altitudeOpacity <= 0.001) {
    return baseSrgb;
  }
  let realAltitude = worldPos.y + camera.centerAltitude;
  let altU = clamp(realAltitude / max(camera.maxAltitude, 1.0), 0.0, 1.0);
  let altSample = textureSampleLevel(altitudeTex, altitudeSamp, vec2<f32>(altU, 0.5), 0.0);
  if (altSample.a <= 0.0) {
    return baseSrgb;
  }
  return mix(baseSrgb, altSample.rgb, altSample.a * camera.altitudeOpacity);
}

fn applySunlightMap(baseSrgb: vec3<f32>, worldPos: vec3<f32>) -> vec3<f32> {
  if (camera.sunlightEnabled < 0.5 || camera.sunlightMapEnabled < 0.5 || camera.sunlightMapOpacity <= 0.001) {
    return baseSrgb;
  }
  let u = (worldPos.x - camera.hmOriginX) / camera.hmScaleX;
  let v = (worldPos.z - camera.hmOriginZ) / camera.hmScaleZ;
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) {
    return baseSrgb;
  }
  let smSample = textureLoad(sunlightMapTex, gridNode(u, v, textureDimensions(sunlightMapTex, 0)), 0);
  if (smSample.a <= 0.0) {
    return baseSrgb;
  }
  return mix(baseSrgb, smSample.rgb, smSample.a * camera.sunlightMapOpacity);
}

fn sampleCastShadow(worldPos: vec3<f32>) -> f32 {
  if (camera.sunlightEnabled < 0.5 || camera.shadowEnabled < 0.5 || camera.shadowOpacity <= 0.001) {
    return 0.0;
  }
  let u = (worldPos.x - camera.hmOriginX) / camera.hmScaleX;
  let v = (worldPos.z - camera.hmOriginZ) / camera.hmScaleZ;
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) {
    return 0.0;
  }
  return textureLoad(shadowTex, gridNode(u, v, textureDimensions(shadowTex, 0)), 0).r;
}
`;

export const WGSL_HEIGHT_HELPERS = /* wgsl */ `
fn heightmapTexel(worldPos: vec3<f32>) -> vec2<i32> {
  let u = (worldPos.x - camera.hmOriginX) / camera.hmScaleX;
  let v = (worldPos.z - camera.hmOriginZ) / camera.hmScaleZ;
  return gridNode(u, v, textureDimensions(heightTex, 0));
}

/** Ground (DTM) height under a point, in the centred render frame. */
fn sampleGroundHeight(worldPos: vec3<f32>) -> f32 {
  return textureLoad(heightTex, heightmapTexel(worldPos), 0).r;
}

/** DTM normal under a point (central differences on the ground heightmap). */
fn computeSobelNormal(worldPos: vec3<f32>) -> vec3<f32> {
  let dims = vec2<f32>(textureDimensions(heightTex, 0));
  let maxCoord = vec2<i32>(dims) - vec2<i32>(1);
  let center = heightmapTexel(worldPos);

  let xR = clamp(center.x + 1, 0, maxCoord.x);
  let xL = clamp(center.x - 1, 0, maxCoord.x);
  let yS = clamp(center.y + 1, 0, maxCoord.y);
  let yN = clamp(center.y - 1, 0, maxCoord.y);

  let hR = textureLoad(heightTex, vec2<i32>(xR, center.y), 0).r;
  let hL = textureLoad(heightTex, vec2<i32>(xL, center.y), 0).r;
  let hS = textureLoad(heightTex, vec2<i32>(center.x, yS), 0).r;
  let hN = textureLoad(heightTex, vec2<i32>(center.x, yN), 0).r;

  // Node spacing: n nodes span the scale edge to edge.
  let cellWorldX = camera.hmScaleX / max(dims.x - 1.0, 1.0);
  let cellWorldZ = camera.hmScaleZ / max(dims.y - 1.0, 1.0);

  let dzdx = (hR - hL) / (2.0 * cellWorldX);
  let dzdz = (hS - hN) / (2.0 * cellWorldZ);

  return normalize(vec3<f32>(-dzdx, 1.0, -dzdz));
}
`;

/** Shared lighting: sun model when the sunlight panel is on, soft hillshade otherwise. */
export const WGSL_LIGHTING_HELPERS = /* wgsl */ `
fn shadeSurface(N: vec3<f32>, baseColorSrgb: vec3<f32>, worldPos: vec3<f32>) -> vec3<f32> {
  let baseColor = srgbToLinear(baseColorSrgb);
  let L = normalize(camera.sunDir.xyz);
  let ndotl = clamp(dot(N, L), 0.0, 1.0);

  if (camera.sunlightEnabled > 0.5) {
    let castShadow = sampleCastShadow(worldPos);
    let directLit = ndotl * (1.0 - castShadow) * camera.sunIntensity;
    let shadowDarkness = camera.shadowOpacity;
    let shadowMask = clamp(1.0 - (1.0 - directLit) * shadowDarkness, 0.0, 1.0);
    let directSun = baseColor * camera.sunColor.rgb * directLit;
    let upFacing = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
    let ambientBase = baseColor * camera.skyColor.rgb * (0.18 + 0.22 * upFacing);
    let lit = (directSun + ambientBase * shadowMask) * camera.exposure;
    return linearToSrgb(lit);
  }

  let diffuse = dot(N, L) * 0.5 + 0.5;
  let lighting = 0.15 + 0.85 * diffuse;
  return linearToSrgb(baseColor * lighting);
}
`;
