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
  lodThreshold: f32,
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
  _pad3: f32,
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
};
`;

export const WGSL_POINT_BINDINGS = /* wgsl */ `
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var heightSamp: sampler;
@group(0) @binding(3) var snowTex: texture_2d<f32>;
@group(0) @binding(4) var slopeTex: texture_2d<f32>;
@group(0) @binding(5) var slopeSamp: sampler;
@group(0) @binding(6) var altitudeTex: texture_2d<f32>;
@group(0) @binding(7) var altitudeSamp: sampler;
@group(0) @binding(8) var shadowTex: texture_2d<f32>;
@group(0) @binding(9) var sunlightMapTex: texture_2d<f32>;
`;

export const WGSL_TERRAIN_BINDINGS = /* wgsl */ `
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(3) var snowTex: texture_2d<f32>;
@group(0) @binding(4) var slopeTex: texture_2d<f32>;
@group(0) @binding(5) var slopeSamp: sampler;
@group(0) @binding(6) var altitudeTex: texture_2d<f32>;
@group(0) @binding(7) var altitudeSamp: sampler;
@group(0) @binding(8) var shadowTex: texture_2d<f32>;
@group(0) @binding(9) var sunlightMapTex: texture_2d<f32>;
`;

export const WGSL_COLOR_HELPERS = /* wgsl */ `
fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
  return select(c / 12.92, pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c > vec3<f32>(0.04045));
}

fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
  return pow(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2));
}

fn srgbToLinearLite(c: vec3<f32>) -> vec3<f32> {
  return select(c / 12.92, pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c > vec3<f32>(0.04045));
}

fn linearToSrgbLite(c: vec3<f32>) -> vec3<f32> {
  return pow(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2));
}

fn pcgHash(input: u32) -> u32 {
  var state = input * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
`;

export const WGSL_OVERLAY_HELPERS = /* wgsl */ `
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
  let slopeSample = textureSample(slopeTex, slopeSamp, vec2<f32>(slopeU, 0.5));
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
  let altSample = textureSample(altitudeTex, altitudeSamp, vec2<f32>(altU, 0.5));
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
  let dims = textureDimensions(sunlightMapTex, 0);
  let dimsF = vec2<f32>(dims);
  let px = clamp(i32(u * dimsF.x), 0, i32(dims.x) - 1);
  let py = clamp(i32(v * dimsF.y), 0, i32(dims.y) - 1);
  let smSample = textureLoad(sunlightMapTex, vec2<i32>(px, py), 0);
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
  let dims = textureDimensions(shadowTex, 0);
  let dimsF = vec2<f32>(dims);
  let px = clamp(i32(u * dimsF.x), 0, i32(dims.x) - 1);
  let py = clamp(i32(v * dimsF.y), 0, i32(dims.y) - 1);
  return textureLoad(shadowTex, vec2<i32>(px, py), 0).r;
}
`;

export const WGSL_HEIGHT_HELPERS = /* wgsl */ `
fn computeSobelNormal(worldPos: vec3<f32>) -> vec3<f32> {
  let u = (worldPos.x - camera.hmOriginX) / camera.hmScaleX;
  let v = (worldPos.z - camera.hmOriginZ) / camera.hmScaleZ;
  let dims = vec2<f32>(textureDimensions(heightTex, 0));
  let maxCoord = vec2<i32>(dims) - vec2<i32>(1);
  let center = vec2<i32>(clamp(vec2<f32>(u, v), vec2<f32>(0.0), vec2<f32>(1.0)) * dims);

  let xR = clamp(center.x + 1, 0, maxCoord.x);
  let xL = clamp(center.x - 1, 0, maxCoord.x);
  let yS = clamp(center.y + 1, 0, maxCoord.y);
  let yN = clamp(center.y - 1, 0, maxCoord.y);

  let hR = textureLoad(heightTex, vec2<i32>(xR, center.y), 0).r;
  let hL = textureLoad(heightTex, vec2<i32>(xL, center.y), 0).r;
  let hS = textureLoad(heightTex, vec2<i32>(center.x, yS), 0).r;
  let hN = textureLoad(heightTex, vec2<i32>(center.x, yN), 0).r;

  let cellWorldX = camera.hmScaleX / max(dims.x, 1.0);
  let cellWorldZ = camera.hmScaleZ / max(dims.y, 1.0);

  let dzdx = (hR - hL) / (2.0 * cellWorldX);
  let dzdz = (hS - hN) / (2.0 * cellWorldZ);

  return normalize(vec3<f32>(-dzdx, 1.0, -dzdz));
}
`;

