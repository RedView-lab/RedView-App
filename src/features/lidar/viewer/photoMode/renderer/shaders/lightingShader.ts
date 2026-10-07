// ============================================
// Photo mode — deferred lighting of the G-buffer
// ============================================
//
// One full-screen pass per drawn frame: albedo (orthophoto colour with the
// overlays), class and depth → two linear radiance terms, kept apart so the
// moving cloud shadows can be applied later without lighting again:
//  - direct: sun × atmospheric transmittance × N·L × shadow of the points
//    (PCSS on two cascades: sharp at the foot of a trunk, soft under a crown);
//  - ambient: sky irradiance × sky view factor of the surface model × canopy
//    transmission × screen-space occlusion (Eye-Dome Lighting kernel).
// Normals: the DTM for ground returns, the surface model's for roofs and
// crown tops, up elsewhere. Vegetation is lit with wrapped diffuse (leaves
// scatter light around the crown). Both outputs are blended into the
// accumulation targets with the weight of the still frame (1 when moving).

import { WGSL_PHOTO_HELPERS, WGSL_PHOTO_STRUCT } from './photoCommon';
import { WGSL_ATMOSPHERE, WGSL_ATMOSPHERE_LOOKUPS, WGSL_PHOTO_LIGHTING_STRUCT } from './atmosphereShaders';

export const FULLSCREEN_VS = /* wgsl */ `
@vertex
fn fullscreen_vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const LIGHTING_SHADER = /* wgsl */ `
${WGSL_PHOTO_STRUCT}
${WGSL_PHOTO_HELPERS}
${WGSL_ATMOSPHERE}
${WGSL_ATMOSPHERE_LOOKUPS}
${WGSL_PHOTO_LIGHTING_STRUCT}
${FULLSCREEN_VS}
@group(0) @binding(0) var<uniform> photo: Photo;
@group(0) @binding(1) var<storage, read> lighting: PhotoLighting;
@group(0) @binding(2) var albedoTex: texture_2d<f32>;
@group(0) @binding(3) var materialTex: texture_2d<f32>;
@group(0) @binding(4) var depthTex: texture_depth_2d;
@group(0) @binding(5) var shadow0: texture_depth_2d;
@group(0) @binding(6) var shadow1: texture_depth_2d;
@group(0) @binding(7) var shadowCmp: sampler_comparison;
@group(0) @binding(8) var dsmHeight: texture_2d<f32>;
@group(0) @binding(9) var dsmInfo: texture_2d<f32>;
@group(0) @binding(10) var linearClamp: sampler;
@group(0) @binding(11) var dtmTex: texture_2d<f32>;
@group(0) @binding(12) var transmittanceLut: texture_2d<f32>;

/** Tangent of the sun's angular radius (0.2666°). */
const SUN_TAN: f32 = 0.004653;
const GOLDEN_ANGLE: f32 = 2.39996323;

fn dtmTexel(p: vec3<f32>) -> vec2<i32> {
  let dims = vec2<i32>(textureDimensions(dtmTex, 0));
  let uv = clamp(vec2<f32>((p.x - photo.dtm.x) / photo.dtm.z, (p.z - photo.dtm.y) / photo.dtm.w), vec2<f32>(0.0), vec2<f32>(1.0));
  return vec2<i32>(round(uv * vec2<f32>(dims - vec2<i32>(1))));
}

fn dtmAt(c: vec2<i32>) -> f32 {
  let dims = vec2<i32>(textureDimensions(dtmTex, 0));
  return textureLoad(dtmTex, clamp(c, vec2<i32>(0), dims - vec2<i32>(1)), 0).r;
}

fn dtmNormal(p: vec3<f32>) -> vec3<f32> {
  let dims = vec2<f32>(textureDimensions(dtmTex, 0));
  let c = dtmTexel(p);
  let cellX = photo.dtm.z / max(dims.x - 1.0, 1.0);
  let cellZ = photo.dtm.w / max(dims.y - 1.0, 1.0);
  let dx = (dtmAt(c + vec2<i32>(1, 0)) - dtmAt(c - vec2<i32>(1, 0))) / (2.0 * cellX);
  let dz = (dtmAt(c + vec2<i32>(0, 1)) - dtmAt(c - vec2<i32>(0, 1))) / (2.0 * cellZ);
  return normalize(vec3<f32>(-dx, 1.0, -dz));
}

struct SurfaceModel {
  height: f32,
  normal: vec3<f32>,
  svf: f32,
  valid: bool,
};

fn surfaceModel(p: vec3<f32>) -> SurfaceModel {
  var s: SurfaceModel;
  s.valid = false;
  s.svf = 1.0;
  s.normal = vec3<f32>(0.0, 1.0, 0.0);
  s.height = -1e9;
  if (photo.flags.z < 0.5) { return s; }
  let c = photo.dsm * vec4<f32>(p, 1.0);
  let uv = c.xy * vec2<f32>(0.5, -0.5) + 0.5;
  if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return s; }
  let dims = vec2<f32>(textureDimensions(dsmHeight, 0));
  s.height = textureLoad(dsmHeight, vec2<i32>(min(uv * dims, dims - 1.0)), 0).r;
  let info = textureSampleLevel(dsmInfo, linearClamp, uv, 0.0);
  let nxz = info.xy * 2.0 - 1.0;
  s.normal = normalize(vec3<f32>(nxz.x, sqrt(max(0.0, 1.0 - dot(nxz, nxz))), nxz.y));
  s.svf = info.z;
  s.valid = true;
  return s;
}

fn vogel(i: u32, count: u32, rotation: f32) -> vec2<f32> {
  let r = sqrt((f32(i) + 0.5) / f32(count));
  let a = f32(i) * GOLDEN_ANGLE + rotation;
  return r * vec2<f32>(cos(a), sin(a));
}

/** (lit share, 1) on the cascade, (1, 0) when the point is outside it. */
fn cascadeShadow(tex: texture_depth_2d, m: mat4x4<f32>, texelM: f32, rangeM: f32, p: vec3<f32>, n: vec3<f32>, rotation: f32) -> vec2<f32> {
  let L = photo.sunDir.xyz;
  let ndl = clamp(dot(n, L), 0.08, 1.0);
  // Slope of the receiver as seen from the sun: grazing light needs more bias.
  let tanTheta = min(sqrt(1.0 - ndl * ndl) / ndl, 6.0);
  let offsetP = p + n * (texelM * (1.0 + 1.5 * (1.0 - ndl))) + L * (texelM * 0.5);
  let c = m * vec4<f32>(offsetP, 1.0);
  let uv = c.xy * vec2<f32>(0.5, -0.5) + 0.5;
  if (any(uv < vec2<f32>(0.01)) || any(uv > vec2<f32>(0.99)) || c.z <= 0.0 || c.z >= 1.0) { return vec2<f32>(1.0, 0.0); }
  let dims = vec2<f32>(textureDimensions(tex, 0));
  let metresPerUv = texelM * dims.x;
  // Depth bias in metres: half a texel plus the receiver's own slope across
  // the tap's distance (receiver-plane bias), so a slope never shadows itself.
  let baseBias = texelM * (0.6 + 1.2 * tanTheta);
  // Blocker search over the widest penumbra a caster in range could throw.
  let searchM = clamp(rangeM * SUN_TAN, texelM * 3.0, 2.5);
  let searchUv = searchM / metresPerUv;
  var blockers = 0.0;
  var blockerSum = 0.0;
  for (var i = 0u; i < 12u; i++) {
    let o = vogel(i, 12u, rotation);
    let suv = clamp(uv + o * searchUv, vec2<f32>(0.0), vec2<f32>(1.0));
    let d = textureLoad(tex, vec2<i32>(min(suv * dims, dims - 1.0)), 0);
    let zTap = c.z - (baseBias + length(o) * searchM * tanTheta) / rangeM;
    if (d < zTap) {
      blockers += 1.0;
      blockerSum += d;
    }
  }
  if (blockers < 0.5) { return vec2<f32>(1.0, 1.0); }
  let penumbraM = max(0.0, c.z - blockerSum / blockers) * rangeM * SUN_TAN * 2.0;
  let radiusM = max(penumbraM * 0.5, texelM * 0.85);
  var lit = 0.0;
  for (var i = 0u; i < 16u; i++) {
    let o = vogel(i, 16u, rotation + 1.3);
    let zTap = c.z - (baseBias + length(o) * radiusM * tanTheta) / rangeM;
    lit += textureSampleCompareLevel(tex, shadowCmp, uv + o * (radiusM / metresPerUv), zTap);
  }
  return vec2<f32>(lit / 16.0, 1.0);
}

fn sunShadow(p: vec3<f32>, n: vec3<f32>, rotation: f32) -> f32 {
  if (photo.flags.x > 0.5) {
    let s1 = cascadeShadow(shadow1, photo.shadow1, photo.shadowInfo.y, photo.shadowInfo.w, p, n, rotation);
    if (s1.y > 0.5) { return s1.x; }
  }
  if (photo.flags.y > 0.5) {
    return cascadeShadow(shadow0, photo.shadow0, photo.shadowInfo.x, photo.shadowInfo.z, p, n, rotation).x;
  }
  return 1.0;
}

/** Eye-Dome Lighting kernel as a short-range occlusion term (reversed-Z: d = near / distance). */
fn screenOcclusion(px: vec2<i32>, depth: f32) -> f32 {
  let dims = vec2<i32>(textureDimensions(depthTex, 0));
  let radius = max(1.5, 2.0 * photo.targetSize.x / max(photo.targetSize.z, 1.0));
  let centreLog = -log2(depth);
  var sum = 0.0;
  for (var k = 0; k < 8; k++) {
    let a = f32(k) * 0.7853981633974483;
    let o = vec2<i32>(round(vec2<f32>(cos(a), sin(a)) * radius));
    let nd = textureLoad(depthTex, clamp(px + o, vec2<i32>(0), dims - vec2<i32>(1)), 0);
    // Capped: a crevice darkens, a silhouette against the far field does not turn black.
    if (nd > 0.0) { sum += clamp(centreLog + log2(nd), 0.0, 0.003); }
  }
  return exp(-sum / 8.0 * 300.0 * photo.flags.w);
}

struct LightOut {
  @location(0) direct: vec4<f32>,
  @location(1) ambient: vec4<f32>,
};

@fragment
fn lighting_fs(@builtin(position) frag: vec4<f32>) -> LightOut {
  var out: LightOut;
  let px = vec2<i32>(frag.xy);
  let albedoSample = textureLoad(albedoTex, px, 0);
  let depth = textureLoad(depthTex, px, 0);
  if (albedoSample.a < 0.5 || depth <= 0.0) {
    out.direct = vec4<f32>(0.0);
    out.ambient = vec4<f32>(0.0);
    return out;
  }
  let p = worldFromDepth(frag.xy, photo.targetSize.xy, depth, photo.invDrawViewProj);
  let cls = u32(textureLoad(materialTex, px, 0).r * 255.0 + 0.5);
  // Orthophoto colours are display values of sunlit surfaces: a little
  // below 1 as reflectance.
  let albedo = srgbToLinear3(albedoSample.rgb) * 0.9;
  let L = normalize(photo.sunDir.xyz);

  let groundH = dtmAt(dtmTexel(p));
  let ground = cls == 2u || cls == 9u || (cls <= 1u && abs(p.y - groundH) < 0.5);
  let vegetation = cls >= 3u && cls <= 5u;
  let model = surfaceModel(p);
  var n = vec3<f32>(0.0, 1.0, 0.0);
  if (ground) {
    n = dtmNormal(p);
  } else if (model.valid && p.y > model.height - 1.5) {
    n = model.normal;
  }

  // Direct sun.
  let ndl = dot(n, L);
  var diffuse = max(ndl, 0.0);
  if (vegetation) { diffuse = clamp((ndl + 0.45) / 1.45, 0.0, 1.0); }
  let rotation = 6.2831853 * ign(frag.xy + vec2<f32>(5.588238 * photo.frame.x));
  var shadow = 0.0;
  if (diffuse > 0.0) { shadow = sunShadow(p, n, rotation); }
  let sunE = sunTransmittance(transmittanceLut, linearClamp, atmospherePos(p, photo.scene.x), L) * photo.sunDir.w;
  out.direct = vec4<f32>(albedo / PI * sunE * diffuse * shadow, 1.0);

  // Sky and ground bounce.
  var skyE = mix(lighting.skySide.rgb + 0.5 * lighting.groundUp.rgb, lighting.skyUp.rgb, saturate(n.y));
  if (n.y < 0.0) { skyE = mix(lighting.skySide.rgb + 0.5 * lighting.groundUp.rgb, lighting.groundUp.rgb, -n.y); }
  var occlusion = screenOcclusion(px, depth);
  if (model.valid) {
    occlusion *= mix(1.0, model.svf, 0.85);
    let below = model.height - p.y;
    if (below > 1.5) { occlusion *= exp(-0.07 * min(below, 30.0)); }
  }
  out.ambient = vec4<f32>(albedo / PI * skyE * occlusion, 1.0);
  let debugView = u32(photo.quality.w);
  if (debugView == 3u) {
    out.direct = vec4<f32>(vec3<f32>(shadow * 0.2), 1.0);
    out.ambient = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  } else if (debugView == 5u) {
    out.direct = vec4<f32>((n * 0.5 + 0.5) * 0.2, 1.0);
    out.ambient = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  } else if (debugView == 6u) {
    out.direct = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    out.ambient = vec4<f32>(vec3<f32>(occlusion * 0.2), 1.0);
  }
  return out;
}
`;
