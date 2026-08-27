// ============================================
// WGSL Shader Components — Point Cloud Shaders
// ============================================

import {
  WGSL_CAMERA_STRUCT,
  WGSL_COLOR_HELPERS,
  WGSL_HEIGHT_HELPERS,
  WGSL_OVERLAY_HELPERS,
  WGSL_POINT_BINDINGS,
} from './common';

export const SHADER_GATHER = /* wgsl */ `
${WGSL_CAMERA_STRUCT}
${WGSL_POINT_BINDINGS}

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

${WGSL_OVERLAY_HELPERS}
${WGSL_COLOR_HELPERS}
${WGSL_HEIGHT_HELPERS}

@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
  @location(0) pos: vec3<f32>,
  @location(1) col: vec4<f32>,
) -> VsOut {
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
  let billboardScale = scaledRadius * 1.5;
  let scale = select(0.0, 1.0, keep > 0.5);
  let wp = pos + camera.right.xyz * uv.x * billboardScale * scale + camera.up.xyz * uv.y * billboardScale * scale;
  out.pos = camera.viewProj * vec4<f32>(wp, 1.0);
  out.color = col;
  out.worldPos = wp;
  out.center = pos;
  out.localUV = uv;
  out.sobelNormal = computeSobelNormal(pos);
  out.camDist = dist;
  out.radius = scaledRadius;
  return out;
}

fn shadePoint(N: vec3<f32>, baseColorSrgb: vec3<f32>, worldPos: vec3<f32>) -> vec3<f32> {
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

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  if (in.stochasticKeep < 0.5) { discard; }
  let dist2 = dot(in.localUV, in.localUV);
  if (dist2 > 1.0) { discard; }
  let edge = 1.0 - smoothstep(0.55, 1.0, sqrt(dist2));

  let snowed = applySnow(in.color.rgb, in.center);
  let sloped = applySlope(snowed, in.sobelNormal);
  let altituded = applyAltitude(sloped, in.center);
  let coloredBase = applySunlightMap(altituded, in.center);

  let N = normalize(in.sobelNormal);
  let color = shadePoint(N, coloredBase, in.center);
  return vec4<f32>(color, in.color.a * edge);
}
`;

export const SHADER_LOAD = SHADER_GATHER;

export const SHADER_APPLE_LITE = /* wgsl */ `
${WGSL_CAMERA_STRUCT}
${WGSL_POINT_BINDINGS}

struct VsOutLite {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) localUV: vec2<f32>,
  @location(2) normal: vec3<f32>,
  @location(3) worldCenter: vec3<f32>,
};

${WGSL_OVERLAY_HELPERS}
${WGSL_COLOR_HELPERS}

fn sampleHeightSmoothLite(u: f32, v: f32) -> f32 {
  let dims = vec2<f32>(textureDimensions(heightTex, 0));
  let coord = clamp(vec2<f32>(u, v), vec2<f32>(0.0), vec2<f32>(1.0)) * dims - vec2<f32>(0.5);
  let base = floor(coord);
  let f = coord - base;
  let w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let i = vec2<i32>(base);
  let maxCoord = vec2<i32>(dims) - vec2<i32>(1);
  let x0 = clamp(i.x, 0, maxCoord.x);
  let x1 = clamp(i.x + 1, 0, maxCoord.x);
  let y0 = clamp(i.y, 0, maxCoord.y);
  let y1 = clamp(i.y + 1, 0, maxCoord.y);
  let h00 = textureLoad(heightTex, vec2<i32>(x0, y0), 0).r;
  let h10 = textureLoad(heightTex, vec2<i32>(x1, y0), 0).r;
  let h01 = textureLoad(heightTex, vec2<i32>(x0, y1), 0).r;
  let h11 = textureLoad(heightTex, vec2<i32>(x1, y1), 0).r;
  return mix(mix(h00, h10, w.x), mix(h01, h11, w.x), w.y);
}

fn computeNormalCross(worldPos: vec3<f32>) -> vec3<f32> {
  let u = (worldPos.x - camera.hmOriginX) / camera.hmScaleX;
  let v = (worldPos.z - camera.hmOriginZ) / camera.hmScaleZ;
  let dims = vec2<f32>(textureDimensions(heightTex, 0));
  let texel = 1.0 / dims;
  let hR = sampleHeightSmoothLite(u + texel.x, v);
  let hL = sampleHeightSmoothLite(u - texel.x, v);
  let hS = sampleHeightSmoothLite(u, v + texel.y);
  let hN = sampleHeightSmoothLite(u, v - texel.y);
  let cellWorldX = camera.hmScaleX / dims.x;
  let cellWorldZ = camera.hmScaleZ / dims.y;
  let dzdx = (hR - hL) / (2.0 * cellWorldX);
  let dzdz = (hS - hN) / (2.0 * cellWorldZ);
  return normalize(vec3<f32>(-dzdx, 1.0, -dzdz));
}

@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
  @location(0) pos: vec3<f32>,
  @location(1) col: vec4<f32>,
) -> VsOutLite {
  var out: VsOutLite;
  let _unused = ii;
  let uv = vec2<f32>(select(-1.0, 1.0, (vi & 1u) != 0u), select(-1.0, 1.0, (vi & 2u) != 0u));
  let toCamera = camera.cameraPos.xyz - pos;
  let dist = length(toCamera);
  let distScale = clamp(1.0 + 0.12 * log2(max(dist / 200.0, 1.0)), 1.0, 2.5);
  let billboardScale = camera.pointSize * 0.5 * distScale * 1.35;
  let wp = pos + camera.right.xyz * uv.x * billboardScale + camera.up.xyz * uv.y * billboardScale;
  out.pos = camera.viewProj * vec4<f32>(wp, 1.0);
  out.color = col;
  out.localUV = uv;
  out.normal = computeNormalCross(pos);
  out.worldCenter = pos;
  return out;
}

@fragment
fn fs_main(in: VsOutLite) -> @location(0) vec4<f32> {
  let dist2 = dot(in.localUV, in.localUV);
  if (dist2 > 1.0) { discard; }
  let edge = 1.0 - smoothstep(0.55, 1.0, sqrt(dist2));
  let snowed = applySnow(in.color.rgb, in.worldCenter);
  let sloped = applySlope(snowed, in.normal);
  let altituded = applyAltitude(sloped, in.worldCenter);
  let colored = applySunlightMap(altituded, in.worldCenter);
  let baseColor = srgbToLinearLite(colored);
  let N = normalize(in.normal);
  let L = normalize(camera.sunDir.xyz);
  let ndotl = clamp(dot(N, L), 0.0, 1.0);

  if (camera.sunlightEnabled > 0.5) {
    let castShadow = sampleCastShadow(in.worldCenter);
    let directLit = ndotl * (1.0 - castShadow) * camera.sunIntensity;
    let shadowDarkness = camera.shadowOpacity;
    let shadowMask = clamp(1.0 - (1.0 - directLit) * shadowDarkness, 0.0, 1.0);
    let directSun = baseColor * camera.sunColor.rgb * directLit;
    let upFacing = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
    let ambientBase = baseColor * camera.skyColor.rgb * (0.18 + 0.22 * upFacing);
    let lit = (directSun + ambientBase * shadowMask) * camera.exposure;
    return vec4<f32>(linearToSrgbLite(lit), in.color.a * edge);
  }

  let diffuse = dot(N, L) * 0.5 + 0.5;
  let lighting = 0.18 + 0.82 * diffuse;
  return vec4<f32>(linearToSrgbLite(baseColor * lighting), in.color.a * edge);
}
`;
