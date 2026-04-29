export const SHADER_GATHER = `
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
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
  snowMode: f32,
  snowOriginX: f32,
  snowOriginZ: f32,
  snowScaleX: f32,
  snowScaleZ: f32,
  _snowPad0: f32,
  _snowPad1: f32,
  _snowPad2: f32,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var heightSamp: sampler;
@group(0) @binding(3) var snowTex: texture_2d<f32>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) worldPos: vec3<f32>,
  @location(2) center: vec3<f32>,
  @location(3) localUV: vec2<f32>,
  @location(4) sobelNormal: vec3<f32>,
  @location(5) @interpolate(flat) camDist: f32,
  @location(6) @interpolate(flat) radius: f32,
  @location(7) @interpolate(flat) stochasticKeep: f32,
};

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

fn pcgHash(input: u32) -> u32 {
  var state = input * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn computeSobelNormal(worldPos: vec3<f32>) -> vec3<f32> {
  let u = (worldPos.x - camera.hmOriginX) / camera.hmScaleX;
  let v = (worldPos.z - camera.hmOriginZ) / camera.hmScaleZ;
  let dims = vec2<f32>(textureDimensions(heightTex, 0));
  let texel = 1.0 / dims;
  let gatherL = textureGather(0, heightTex, heightSamp, vec2<f32>(u - texel.x, v));
  let gatherR = textureGather(0, heightTex, heightSamp, vec2<f32>(u + texel.x, v));
  let gatherD = textureGather(0, heightTex, heightSamp, vec2<f32>(u, v - texel.y));
  let gatherU = textureGather(0, heightTex, heightSamp, vec2<f32>(u, v + texel.y));
  let dzdx = (gatherR.x + 2.0 * gatherR.y + gatherR.z) - (gatherL.x + 2.0 * gatherL.y + gatherL.z);
  let dzdy = (gatherU.x + 2.0 * gatherU.y + gatherU.z) - (gatherD.x + 2.0 * gatherD.y + gatherD.z);
  let cellWorldX = camera.hmScaleX / dims.x;
  let cellWorldZ = camera.hmScaleZ / dims.y;
  let scale = (cellWorldX + cellWorldZ) * 0.5;
  return normalize(vec3<f32>(-dzdx, scale * 3.0, -dzdy));
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32, @location(0) pos: vec3<f32>, @location(1) col: vec4<f32>) -> VsOut {
  var out: VsOut;
  var keep = 1.0;
  if (camera.density < 0.999) {
    let h = pcgHash(ii);
    let r = f32(h) / 4294967295.0;
    keep = select(0.0, 1.0, r < camera.density);
  }
  out.stochasticKeep = keep;
  let uv = vec2<f32>(select(-1.0, 1.0, (vi & 1u) != 0u), select(-1.0, 1.0, (vi & 2u) != 0u));
  let toCamera = camera.cameraPos.xyz - pos;
  let dist = length(toCamera);
  let distScale = clamp(1.0 + 0.12 * log2(max(dist / 200.0, 1.0)), 1.0, 2.5);
  let baseRadius = camera.pointSize * 0.5;
  let scaledRadius = baseRadius * distScale;
  let billboardScale = scaledRadius * 1.8;
  let scale = select(0.0, 1.0, keep > 0.5);
  let wp = pos + camera.right.xyz * uv.x * billboardScale * scale + camera.up.xyz * uv.y * billboardScale * scale;
  out.pos = camera.viewProj * vec4<f32>(wp, 1.0);
  out.color = col;
  out.worldPos = wp;
  out.center = pos;
  out.localUV = uv;
  let lodNear = camera.lodThreshold * 0.6;
  if (dist > lodNear || camera.lodThreshold == 0.0) { out.sobelNormal = computeSobelNormal(pos); } else { out.sobelNormal = vec3<f32>(0.0, 1.0, 0.0); }
  out.camDist = dist;
  out.radius = scaledRadius;
  return out;
}

struct FsOut { @location(0) color: vec4<f32>, @builtin(frag_depth) depth: f32, };
fn srgbToLinear(c: vec3<f32>) -> vec3<f32> { return select(c / 12.92, pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c > vec3<f32>(0.04045)); }
fn linearToSrgb(c: vec3<f32>) -> vec3<f32> { return pow(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2)); }
fn shade(N: vec3<f32>, baseColorSrgb: vec3<f32>) -> vec3<f32> {
  let baseColor = srgbToLinear(baseColorSrgb);
  let L = normalize(camera.sunDir.xyz);
  let diffuse = dot(N, L) * 0.5 + 0.5;
  let lighting = 0.15 + 0.85 * diffuse;
  return linearToSrgb(baseColor * lighting);
}

@fragment
fn fs_main(in: VsOut) -> FsOut {
  if (in.stochasticKeep < 0.5) { discard; }
  var out: FsOut;
  let lodNear = camera.lodThreshold * 0.6;
  let lodFar  = camera.lodThreshold * 1.4;
  let snowedBase = applySnow(in.color.rgb, in.center);
  if (in.camDist < lodFar) {
    let rayDir = normalize(in.worldPos - camera.cameraPos.xyz);
    let localOrigin = camera.cameraPos.xyz - in.center;
    let invDir = 1.0 / rayDir;
    let half = in.radius * 1.02;
    let t0 = (-half - localOrigin) * invDir;
    let t1 = ( half - localOrigin) * invDir;
    let tmin = min(t0, t1);
    let tmax = max(t0, t1);
    let tNear = max(max(tmin.x, tmin.y), tmin.z);
    let tFar  = min(min(tmax.x, tmax.y), tmax.z);
    if (tNear > tFar || tFar < 0.0) {
      if (in.camDist < lodNear) { discard; }
    } else {
      let hitPos = camera.cameraPos.xyz + rayDir * tNear;
      let clipPos = camera.viewProj * vec4<f32>(hitPos, 1.0);
      var faceNormal = vec3<f32>(0.0);
      if (tNear == tmin.x) { faceNormal = vec3<f32>(-sign(rayDir.x), 0.0, 0.0); }
      else if (tNear == tmin.y) { faceNormal = vec3<f32>(0.0, -sign(rayDir.y), 0.0); }
      else { faceNormal = vec3<f32>(0.0, 0.0, -sign(rayDir.z)); }
      let boxColor = shade(faceNormal, snowedBase);
      let boxDepth = clipPos.z / clipPos.w;
      if (in.camDist > lodNear) {
        let t = smoothstep(lodNear, lodFar, in.camDist);
        let dist2 = dot(in.localUV, in.localUV);
        if (dist2 > 1.0) { discard; }
        let edge = 1.0 - smoothstep(0.6, 1.0, sqrt(dist2));
        let N = normalize(in.sobelNormal);
        let discColor = shade(N, snowedBase);
        out.color = vec4<f32>(mix(boxColor, discColor, t), mix(in.color.a, in.color.a * edge, t));
        out.depth = mix(boxDepth, in.pos.z, t);
      } else {
        out.color = vec4<f32>(boxColor, in.color.a);
        out.depth = boxDepth;
      }
      return out;
    }
  }
  let dist2 = dot(in.localUV, in.localUV);
  if (dist2 > 1.0) { discard; }
  let edge = 1.0 - smoothstep(0.5, 1.0, sqrt(dist2));
  let N = normalize(in.sobelNormal);
  let color = shade(N, snowedBase);
  out.color = vec4<f32>(color, in.color.a * edge);
  out.depth = in.pos.z;
  return out;
}`;

export const SHADER_LOAD = SHADER_GATHER.replace(
  'fn computeSobelNormal(worldPos: vec3<f32>) -> vec3<f32> {\n  let u = (worldPos.x - camera.hmOriginX) / camera.hmScaleX;\n  let v = (worldPos.z - camera.hmOriginZ) / camera.hmScaleZ;\n  let dims = vec2<f32>(textureDimensions(heightTex, 0));\n  let texel = 1.0 / dims;\n  let gatherL = textureGather(0, heightTex, heightSamp, vec2<f32>(u - texel.x, v));\n  let gatherR = textureGather(0, heightTex, heightSamp, vec2<f32>(u + texel.x, v));\n  let gatherD = textureGather(0, heightTex, heightSamp, vec2<f32>(u, v - texel.y));\n  let gatherU = textureGather(0, heightTex, heightSamp, vec2<f32>(u, v + texel.y));\n  let dzdx = (gatherR.x + 2.0 * gatherR.y + gatherR.z) - (gatherL.x + 2.0 * gatherL.y + gatherL.z);\n  let dzdy = (gatherU.x + 2.0 * gatherU.y + gatherU.z) - (gatherD.x + 2.0 * gatherD.y + gatherD.z);\n  let cellWorldX = camera.hmScaleX / dims.x;\n  let cellWorldZ = camera.hmScaleZ / dims.y;\n  let scale = (cellWorldX + cellWorldZ) * 0.5;\n  return normalize(vec3<f32>(-dzdx, scale * 3.0, -dzdy));\n}',
  'fn computeSobelNormal(worldPos: vec3<f32>) -> vec3<f32> {\n  let u = (worldPos.x - camera.hmOriginX) / camera.hmScaleX;\n  let v = (worldPos.z - camera.hmOriginZ) / camera.hmScaleZ;\n  let dims = textureDimensions(heightTex, 0);\n  let dimsF = vec2<f32>(dims);\n  let px = clamp(i32(u * dimsF.x), 0, i32(dims.x) - 1);\n  let py = clamp(i32(v * dimsF.y), 0, i32(dims.y) - 1);\n  let pxL = max(px - 1, 0);\n  let pxR = min(px + 1, i32(dims.x) - 1);\n  let pyD = max(py - 1, 0);\n  let pyU = min(py + 1, i32(dims.y) - 1);\n  let hL  = textureLoad(heightTex, vec2<i32>(pxL, py),  0).r;\n  let hR  = textureLoad(heightTex, vec2<i32>(pxR, py),  0).r;\n  let hD  = textureLoad(heightTex, vec2<i32>(px,  pyD), 0).r;\n  let hU  = textureLoad(heightTex, vec2<i32>(px,  pyU), 0).r;\n  let hLD = textureLoad(heightTex, vec2<i32>(pxL, pyD), 0).r;\n  let hRD = textureLoad(heightTex, vec2<i32>(pxR, pyD), 0).r;\n  let hLU = textureLoad(heightTex, vec2<i32>(pxL, pyU), 0).r;\n  let hRU = textureLoad(heightTex, vec2<i32>(pxR, pyU), 0).r;\n  let dzdx = (hRD + 2.0 * hR + hRU) - (hLD + 2.0 * hL + hLU);\n  let dzdy = (hLU + 2.0 * hU + hRU) - (hLD + 2.0 * hD + hRD);\n  let cellWorldX = camera.hmScaleX / dimsF.x;\n  let cellWorldZ = camera.hmScaleZ / dimsF.y;\n  let scale = (cellWorldX + cellWorldZ) * 0.5;\n  return normalize(vec3<f32>(-dzdx, scale * 3.0, -dzdy));\n}'
);

export const SHADER_APPLE_LITE = `
struct Camera {
  viewProj: mat4x4<f32>, right: vec4<f32>, up: vec4<f32>, cameraPos: vec4<f32>, pointSize: f32, lodThreshold: f32,
  viewportWidth: f32, viewportHeight: f32, sunDir: vec4<f32>, hmOriginX: f32, hmOriginZ: f32, hmScaleX: f32, hmScaleZ: f32,
  density: f32, _pad1: f32, _pad2: f32, _pad3: f32, snowMode: f32, snowOriginX: f32, snowOriginZ: f32, snowScaleX: f32, snowScaleZ: f32,
  _snowPad0: f32, _snowPad1: f32, _snowPad2: f32,
};
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var heightSamp: sampler;
@group(0) @binding(3) var snowTex: texture_2d<f32>;
struct VsOutLite { @builtin(position) pos: vec4<f32>, @location(0) color: vec4<f32>, @location(1) localUV: vec2<f32>, @location(2) normal: vec3<f32>, @location(3) worldCenter: vec3<f32>, };
fn sampleSnowDepthCm(worldPos: vec3<f32>) -> f32 { if (camera.snowMode < 0.5) { return 0.0; } let u = (worldPos.x - camera.snowOriginX) / camera.snowScaleX; let v = (worldPos.z - camera.snowOriginZ) / camera.snowScaleZ; if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) { return 0.0; } let dims = textureDimensions(snowTex, 0); let dimsF = vec2<f32>(dims); let px = clamp(i32(u * dimsF.x), 0, i32(dims.x) - 1); let py = clamp(i32(v * dimsF.y), 0, i32(dims.y) - 1); return textureLoad(snowTex, vec2<i32>(px, py), 0).r; }
fn snowThicknessColor(depthCm: f32) -> vec3<f32> { let t = clamp(depthCm / 200.0, 0.0, 1.0); let r = clamp(1.6 * t - 0.4, 0.0, 1.0); let g = clamp(1.0 - abs(t - 0.55) * 2.2, 0.0, 1.0); let b = clamp(1.0 - t * 1.4 + 0.15, 0.0, 1.0); return vec3<f32>(r, g, b); }
fn applySnow(baseSrgb: vec3<f32>, worldPos: vec3<f32>) -> vec3<f32> { if (camera.snowMode < 0.5) { return baseSrgb; } let depth = sampleSnowDepthCm(worldPos); if (camera.snowMode > 1.5) { if (depth <= 0.5) { return baseSrgb * 0.35; } return snowThicknessColor(depth); } let t = smoothstep(0.0, 30.0, depth) * 0.93; return mix(baseSrgb, vec3<f32>(0.97, 0.98, 1.0), t); }
fn computeNormalCross(worldPos: vec3<f32>) -> vec3<f32> { let u = (worldPos.x - camera.hmOriginX) / camera.hmScaleX; let v = (worldPos.z - camera.hmOriginZ) / camera.hmScaleZ; let dims = textureDimensions(heightTex, 0); let dimsF = vec2<f32>(dims); let px = clamp(i32(u * dimsF.x), 0, i32(dims.x) - 1); let py = clamp(i32(v * dimsF.y), 0, i32(dims.y) - 1); let pxL = max(px - 1, 0); let pxR = min(px + 1, i32(dims.x) - 1); let pyD = max(py - 1, 0); let pyU = min(py + 1, i32(dims.y) - 1); let hL = textureLoad(heightTex, vec2<i32>(pxL, py), 0).r; let hR = textureLoad(heightTex, vec2<i32>(pxR, py), 0).r; let hD = textureLoad(heightTex, vec2<i32>(px, pyD), 0).r; let hU = textureLoad(heightTex, vec2<i32>(px, pyU), 0).r; let dzdx = hR - hL; let dzdy = hU - hD; let cellWorldX = camera.hmScaleX / dimsF.x; let cellWorldZ = camera.hmScaleZ / dimsF.y; let scale = (cellWorldX + cellWorldZ) * 0.5; return normalize(vec3<f32>(-dzdx, scale * 6.0, -dzdy)); }
@vertex fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32, @location(0) pos: vec3<f32>, @location(1) col: vec4<f32>) -> VsOutLite { var out: VsOutLite; let _unused = ii; let uv = vec2<f32>(select(-1.0, 1.0, (vi & 1u) != 0u), select(-1.0, 1.0, (vi & 2u) != 0u)); let toCamera = camera.cameraPos.xyz - pos; let dist = length(toCamera); let distScale = clamp(1.0 + 0.12 * log2(max(dist / 200.0, 1.0)), 1.0, 2.5); let billboardScale = camera.pointSize * 0.5 * distScale * 1.35; let wp = pos + camera.right.xyz * uv.x * billboardScale + camera.up.xyz * uv.y * billboardScale; out.pos = camera.viewProj * vec4<f32>(wp, 1.0); out.color = col; out.localUV = uv; out.normal = computeNormalCross(pos); out.worldCenter = pos; return out; }
fn srgbToLinearLite(c: vec3<f32>) -> vec3<f32> { return select(c / 12.92, pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c > vec3<f32>(0.04045)); }
fn linearToSrgbLite(c: vec3<f32>) -> vec3<f32> { return pow(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2)); }
@fragment fn fs_main(in: VsOutLite) -> @location(0) vec4<f32> { let dist2 = dot(in.localUV, in.localUV); if (dist2 > 1.0) { discard; } let edge = 1.0 - smoothstep(0.55, 1.0, sqrt(dist2)); let snowed = applySnow(in.color.rgb, in.worldCenter); let baseColor = srgbToLinearLite(snowed); let N = normalize(in.normal); let L = normalize(camera.sunDir.xyz); let diffuse = dot(N, L) * 0.5 + 0.5; let lighting = 0.18 + 0.82 * diffuse; return vec4<f32>(linearToSrgbLite(baseColor * lighting), in.color.a * edge); }`;

export const TERRAIN_SHADER = `
struct Camera {
  viewProj: mat4x4<f32>, right: vec4<f32>, up: vec4<f32>, cameraPos: vec4<f32>, pointSize: f32, lodThreshold: f32,
  viewportWidth: f32, viewportHeight: f32, sunDir: vec4<f32>, hmOriginX: f32, hmOriginZ: f32, hmScaleX: f32, hmScaleZ: f32,
  density: f32, _pad1: f32, _pad2: f32, _pad3: f32, snowMode: f32, snowOriginX: f32, snowOriginZ: f32, snowScaleX: f32, snowScaleZ: f32,
  _snowPad0: f32, _snowPad1: f32, _snowPad2: f32,
};
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(3) var snowTex: texture_2d<f32>;
struct TerrainVsOut { @builtin(position) pos: vec4<f32>, @location(0) color: vec4<f32>, @location(1) normal: vec3<f32>, @location(2) worldPos: vec3<f32>, };
@vertex fn terrain_vs(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) col: vec4<f32>) -> TerrainVsOut { var out: TerrainVsOut; out.pos = camera.viewProj * vec4<f32>(position, 1.0); out.color = col; out.normal = normal; out.worldPos = position; return out; }
fn sampleSnowDepthCm(worldPos: vec3<f32>) -> f32 { if (camera.snowMode < 0.5) { return 0.0; } let u = (worldPos.x - camera.snowOriginX) / camera.snowScaleX; let v = (worldPos.z - camera.snowOriginZ) / camera.snowScaleZ; if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) { return 0.0; } let dims = textureDimensions(snowTex, 0); let dimsF = vec2<f32>(dims); let px = clamp(i32(u * dimsF.x), 0, i32(dims.x) - 1); let py = clamp(i32(v * dimsF.y), 0, i32(dims.y) - 1); return textureLoad(snowTex, vec2<i32>(px, py), 0).r; }
fn snowThicknessColor(depthCm: f32) -> vec3<f32> { let t = clamp(depthCm / 200.0, 0.0, 1.0); let r = clamp(1.6 * t - 0.4, 0.0, 1.0); let g = clamp(1.0 - abs(t - 0.55) * 2.2, 0.0, 1.0); let b = clamp(1.0 - t * 1.4 + 0.15, 0.0, 1.0); return vec3<f32>(r, g, b); }
fn applySnow(baseSrgb: vec3<f32>, worldPos: vec3<f32>) -> vec3<f32> { if (camera.snowMode < 0.5) { return baseSrgb; } let depth = sampleSnowDepthCm(worldPos); if (camera.snowMode > 1.5) { if (depth <= 0.5) { return baseSrgb * 0.35; } return snowThicknessColor(depth); } let t = smoothstep(0.0, 30.0, depth) * 0.93; return mix(baseSrgb, vec3<f32>(0.97, 0.98, 1.0), t); }
@fragment fn terrain_fs(in: TerrainVsOut) -> @location(0) vec4<f32> { let n = normalize(in.normal); let ndotl = max(dot(n, normalize(camera.sunDir.xyz)), 0.3); let snowed = applySnow(in.color.rgb, in.worldPos); return vec4<f32>(snowed * ndotl, in.color.a); }`;