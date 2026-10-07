// ============================================
// Photo mode — composite and post-processing
// ============================================
//
// composite_fs (scene target size, HDR): accumulated direct × cloud shadow
// (direct transmission of the shadow map) + ambient raised by the light the
// cloud lets through diffusely, aerial perspective, sky with the sun disc
// behind, the distant ground beyond the tiles, then the clouds (the
// full-resolution still accumulation, or a depth-aware upsampling of the
// half-resolution buffer while the view moves; their own aerial perspective).
// Bloom: Jimenez's (Call of Duty: Advanced Warfare, 2014) 13-tap downsample
// with a Karis average on the first level, tent upsample added level by
// level. final_fs (canvas): exposure, bloom, AgX, sRGB, dither, then the
// overlays (route, analysis zones) drawn over in their own UI colours.

import { WGSL_PHOTO_HELPERS, WGSL_PHOTO_STRUCT } from './photoCommon';
import { WGSL_ATMOSPHERE, WGSL_ATMOSPHERE_LOOKUPS, WGSL_PHOTO_LIGHTING_STRUCT } from './atmosphereShaders';
import { FULLSCREEN_VS } from './lightingShader';
import { WGSL_CLOUD_COMPOSITE_HELPERS } from './cloudShaders';

export const BLOOM_LEVELS = 6;

export const COMPOSITE_SHADER = /* wgsl */ `
${WGSL_PHOTO_STRUCT}
${WGSL_PHOTO_HELPERS}
${WGSL_ATMOSPHERE}
${WGSL_ATMOSPHERE_LOOKUPS}
${WGSL_PHOTO_LIGHTING_STRUCT}
${FULLSCREEN_VS}
@group(0) @binding(0) var<uniform> photo: Photo;
@group(0) @binding(1) var<storage, read> lighting: PhotoLighting;
@group(0) @binding(2) var directTex: texture_2d<f32>;
@group(0) @binding(3) var ambientTex: texture_2d<f32>;
@group(0) @binding(4) var depthTex: texture_depth_2d;
@group(0) @binding(5) var skyViewLut: texture_2d<f32>;
@group(0) @binding(6) var apVolume: texture_3d<f32>;
@group(0) @binding(7) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(8) var linearClamp: sampler;
@group(0) @binding(9) var cloudColor: texture_2d<f32>;
@group(0) @binding(10) var cloudDepth: texture_2d<f32>;
@group(0) @binding(11) var lightVolume: texture_3d<f32>;
@group(0) @binding(12) var stillColor: texture_2d<f32>;
@group(0) @binding(13) var stillDist: texture_2d<f32>;
@group(0) @binding(14) var cloudShadowMap: texture_2d<f32>;
${WGSL_CLOUD_COMPOSITE_HELPERS}

const SUN_RADIUS: f32 = 0.004653;
const FAR_DIST: f32 = 200000.0;

/** Aerial perspective between the camera and a point at distMeters along the pixel's ray: rgb = in-scatter, a = transmittance. */
fn aerialPerspective(uv: vec2<f32>, distMeters: f32) -> vec4<f32> {
  let w = sqrt(saturate(distMeters * 0.001 / photo.quality.y));
  let s = textureSampleLevel(apVolume, linearClamp, vec3<f32>(uv, w), 0.0);
  // The first slice lies ~16 m away: fade in from the camera.
  let fadeIn = saturate(w * 32.0);
  return vec4<f32>(s.rgb * fadeIn * photo.sunDir.w, mix(1.0, s.a, fadeIn));
}

/**
 * Optical depth of the clouds along the sun ray leaving the base plane at
 * q, from the light volume: the ray is followed to where it enters the
 * cloud domain (a low sun reaches it from far outside: the shadows of tall
 * towers run for tens of kilometres) and the volume gives the rest of the
 * way to the top of the layer.
 */
fn cloudShadowFromVolume(q: vec2<f32>, L: vec3<f32>, ly: f32) -> f32 {
  let domainHalf = photo.cloudParams.z;
  let d = vec2<f32>(L.x, L.z);
  let inv = 1.0 / select(d, vec2<f32>(1e-6), abs(d) < vec2<f32>(1e-6));
  let t1 = (vec2<f32>(-domainHalf) - q) * inv;
  let t2 = (vec2<f32>(domainHalf) - q) * inv;
  let enter = max(max(min(t1.x, t2.x), min(t1.y, t2.y)), 0.0);
  let leave = min(max(t1.x, t2.x), max(t1.y, t2.y));
  if (leave <= enter) { return 0.0; }
  let hf = ly * enter / (photo.cloudLayer.y - photo.cloudLayer.x);
  if (hf >= 1.0) { return 0.0; }
  return sunDepthAt(q.x + d.x * enter, q.y + d.y * enter, max(hf, 0.02));
}

/**
 * Transmission of the clouds towards the sun from a point (their ground
 * shadow): x = direct, y = total (direct + diffuse through the cloud).
 * Under the base, the shadow map where it covers (blended into the light
 * volume over its border), the light volume beyond; a summit inside the
 * layer reads the light volume at its own height.
 */
fn cloudShadowAt(p: vec3<f32>) -> vec2<f32> {
  if (photo.atmosphere.w < 0.5) { return vec2<f32>(1.0); }
  let L = normalize(photo.sunDir.xyz);
  let ly = max(L.y, 0.035);
  let alt = photo.scene.x + p.y;
  let base = photo.cloudLayer.x;
  let extinction = photo.cloudParams.x;
  if (alt >= base) {
    let hf = (alt - base) / (photo.cloudLayer.y - base);
    return cloudTransmissions(sunDepthAt(p.x, p.z, hf) * extinction);
  }
  let t = (base - alt) / ly;
  let q = p.xz + L.xz * t;
  let sh = photo.cloudShadow;
  let uv = (q - sh.xy) / (2.0 * sh.z) + 0.5;
  let border = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
  let mapWeight = select(0.0, smoothstep(0.0, 0.06, border), sh.w > 0.5);
  var shadow = vec2<f32>(1.0);
  if (mapWeight < 1.0) { shadow = cloudTransmissions(cloudShadowFromVolume(q, L, ly) * extinction); }
  if (mapWeight > 0.0) { shadow = mix(shadow, textureSampleLevel(cloudShadowMap, linearClamp, uv, 0.0).rg, mapWeight); }
  return shadow;
}

/** Sun on a horizontal surface over the sky irradiance: scales the light a cloud lets through diffusely. */
fn sunToSkyRatio() -> f32 {
  let L = normalize(photo.sunDir.xyz);
  return luminance(lighting.sunScene.rgb) * max(L.y, 0.0) / max(luminance(lighting.skyUp.rgb), 1e-5);
}

/** Lit surface under the clouds: direct sun through them, sky light plus what they scatter down. */
fn shadeUnderClouds(direct: vec3<f32>, ambient: vec3<f32>, p: vec3<f32>) -> vec3<f32> {
  let sh = cloudShadowAt(p);
  return direct * sh.x + ambient * (1.0 + max(sh.y - sh.x, 0.0) * sunToSkyRatio());
}

fn skyRadiance(dir: vec3<f32>) -> vec3<f32> {
  let L = normalize(photo.sunDir.xyz);
  var radiance = textureSampleLevel(skyViewLut, linearClamp, skyViewUv(dir, L, max(photo.atmosphere.z, 0.01)), 0.0).rgb * photo.sunDir.w;
  let cosA = dot(dir, L);
  if (cosA > 0.999) {
    let angle = asin(min(length(cross(dir, L)), 1.0));
    let r = angle / SUN_RADIUS;
    if (r < 1.2) {
      let limb = 1.0 - 0.6 * (1.0 - sqrt(max(0.0, 1.0 - min(r * r, 1.0))));
      let edge = 1.0 - smoothstep(0.96, 1.04, r);
      let sunT = sunTransmittance(transmittanceLut, linearClamp, atmospherePos(photo.cameraPos.xyz, photo.scene.x), L);
      radiance += sunT * photo.sunDir.w / (PI * SUN_RADIUS * SUN_RADIUS) * limb * edge;
    }
  }
  return radiance;
}

/** Sky, or the ground beyond the scene where the ray goes down to it. */
fn hash21(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn valueNoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2<f32>(1.0, 0.0)), u.x), mix(hash21(i + vec2<f32>(0.0, 1.0)), hash21(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}

/**
 * Gentle fBm relief (m) of the ground beyond the tiles: rolling hills read
 * through the haze, not a flat sea. Not ridged: under a low sun the ridged
 * crests of value noise read as sand dunes.
 */
fn distantRelief(xz: vec2<f32>) -> f32 {
  var p = xz / 6500.0;
  var amp = 1.0;
  var sum = 0.0;
  for (var o = 0; o < 4; o++) {
    sum += (valueNoise(p) - 0.5) * amp;
    p = p * 2.03 + vec2<f32>(17.3, 9.1);
    amp *= 0.45;
  }
  return sum * 260.0;
}

fn background(dir: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
  let eye = photo.cameraPos.xyz;
  let hit = raySphereAlt(eye.x, photo.scene.x + eye.y, eye.z, dir, photo.scene.y);
  if (hit.x <= 0.0) { return skyRadiance(dir); }
  let q = eye + dir * hit.x;
  let L = normalize(photo.sunDir.xyz);
  // Shaded relief (normal from the procedural heights, a footprint ~1 px wide
  // at that distance) and a varied albedo.
  let e = max(40.0, hit.x * 0.004);
  let h0 = distantRelief(q.xz);
  let n = normalize(vec3<f32>(-(distantRelief(q.xz + vec2<f32>(e, 0.0)) - h0) / e, 1.0, -(distantRelief(q.xz + vec2<f32>(0.0, e)) - h0) / e));
  let tint = valueNoise(q.xz / 2300.0 + vec2<f32>(3.7, 1.9));
  let albedo = photo.scene.z * mix(vec3<f32>(0.82, 0.95, 0.72), vec3<f32>(1.12, 1.04, 0.92), tint);
  let groundRadiance = albedo / PI * shadeUnderClouds(lighting.sunScene.rgb * max(dot(n, L), 0.0), lighting.skyUp.rgb * (0.5 + 0.5 * n.y), q);
  let ap = aerialPerspective(uv, hit.x);
  let near = groundRadiance * ap.a + ap.rgb;
  let farBlend = saturate((hit.x * 0.001 - photo.quality.y) / photo.quality.y);
  return mix(near, skyRadiance(dir), farBlend);
}

struct CloudSample {
  color: vec4<f32>,
  dist: f32,
};

/** Still accumulation at a full-resolution pixel. */
fn stillCloudsAt(q: vec2<u32>) -> CloudSample {
  var s: CloudSample;
  s.color = textureLoad(stillColor, vec2<i32>(q), 0);
  let opacity = 1.0 - s.color.a;
  s.dist = select(FAR_DIST, textureLoad(stillDist, vec2<i32>(q), 0).r / max(opacity, 1e-4), opacity > 1e-3);
  return s;
}

/**
 * Clouds at this pixel: the still accumulation once the pixel has a sample
 * (or still holds the previous image of this view), otherwise the
 * half-resolution buffer upsampled (depth-aware), or the first traced pixel
 * of its block when there is nothing else yet.
 */
fn cloudsAt(frag: vec2<f32>, sceneDist: f32) -> CloudSample {
  if (photo.cloudStill.y >= 0.0) {
    let px = vec2<u32>(frag);
    let k = u32(photo.cloudStill.x);
    let index = u32(photo.cloudStill.y);
    if (index + 1u >= k || stillPhase(px, k) <= index || photo.cloudStill.z > 0.5) { return stillCloudsAt(px); }
    if (photo.cloudTemporal.w < 0.5) { return stillCloudsAt(stillFirstPixel(px, k)); }
  }
  let cs = photo.cloudSize.xy;
  let pos = frag * (cs / photo.targetSize.xy) - 0.5;
  let b = vec2<i32>(floor(pos));
  let f = pos - floor(pos);
  let maxC = vec2<i32>(cs) - vec2<i32>(1);
  let reference = min(sceneDist, FAR_DIST);
  var color = vec4<f32>(0.0);
  var dist = 0.0;
  var distWeight = 0.0;
  var total = 0.0;
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      let q = clamp(b + vec2<i32>(i, j), vec2<i32>(0), maxC);
      let wb = select(1.0 - f.x, f.x, i == 1) * select(1.0 - f.y, f.y, j == 1);
      let d = textureLoad(cloudDepth, q, 0).rg;
      let limit = min(d.y, FAR_DIST);
      let wd = exp(-abs(limit - reference) / (0.05 * reference + 20.0));
      let w = wb * (wd + 1e-4);
      color += textureLoad(cloudColor, q, 0) * w;
      total += w;
      if (d.x < 1.0e6) {
        dist += d.x * w;
        distWeight += w;
      }
    }
  }
  var s: CloudSample;
  s.color = color / max(total, 1e-6);
  s.dist = select(FAR_DIST, dist / max(distWeight, 1e-6), distWeight > 1e-6);
  return s;
}

@fragment
fn composite_fs(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let px = vec2<i32>(frag.xy);
  let size = photo.targetSize.xy;
  let uv = frag.xy / size;
  let eye = photo.cameraPos.xyz;
  let dir = viewRay(uv, photo.invViewProj, eye);
  let direct = textureLoad(directTex, px, 0);
  let ambient = textureLoad(ambientTex, px, 0);
  let coverage = saturate(direct.a);
  let depth = textureLoad(depthTex, px, 0);
  var color = vec3<f32>(0.0);
  var sceneDist = 1.0e7;
  if (coverage > 0.001 && depth > 0.0) {
    let p = worldFromDepth(frag.xy, size, depth, photo.invDrawViewProj);
    sceneDist = distance(p, eye);
    let surface = shadeUnderClouds(direct.rgb, ambient.rgb, p);
    let ap = aerialPerspective(uv, sceneDist);
    color = surface * ap.a + ap.rgb * coverage;
  }
  if (coverage < 0.999) {
    color += background(dir, uv) * (1.0 - coverage);
  }
  let debugView = u32(photo.quality.w);
  if (debugView == 7u && coverage > 0.001 && depth > 0.0) {
    // Ground shadow of the clouds: grey = direct transmission, blue = inside the shadow map.
    let p = worldFromDepth(frag.xy, size, depth, photo.invDrawViewProj);
    let L = normalize(photo.sunDir.xyz);
    let q = p.xz + L.xz * (photo.cloudLayer.x - photo.scene.x - p.y) / max(L.y, 0.035);
    let suv = (q - photo.cloudShadow.xy) / (2.0 * photo.cloudShadow.z) + 0.5;
    let inMap = select(0.0, 0.3, all(suv > vec2<f32>(0.0)) && all(suv < vec2<f32>(1.0)));
    let sh = cloudShadowAt(p).x * 0.2;
    return vec4<f32>(sh, sh, sh + inMap * 0.2, 1.0);
  }
  if (debugView == 1u) { return vec4<f32>(direct.rgb, 1.0); }
  if (debugView == 2u || debugView == 6u) { return vec4<f32>(ambient.rgb, 1.0); }
  if (debugView == 3u || debugView == 5u) { return vec4<f32>(direct.rgb, 1.0); }
  if (debugView == 4u) {
    let c = cloudsAt(frag.xy, sceneDist);
    return vec4<f32>(c.color.rgb + vec3<f32>(0.0, 0.0, 0.02) * c.color.a, 1.0);
  }
  let c = cloudsAt(frag.xy, sceneDist);
  // Clouds behind the surface (a ridge in front of a cloud bank): none, even
  // where the half-resolution buffer straddles the silhouette.
  if (photo.atmosphere.w > 0.5 && (coverage < 0.5 || c.dist < sceneDist)) {
    let ap = aerialPerspective(uv, c.dist);
    let cloudRadiance = c.color.rgb * ap.a + ap.rgb * (1.0 - c.color.a);
    color = color * c.color.a + cloudRadiance;
  }
  return vec4<f32>(min(color, vec3<f32>(60000.0)), 1.0);
}
`;

export const BLOOM_SHADER = /* wgsl */ `
${FULLSCREEN_VS}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearClamp: sampler;

fn tap(uv: vec2<f32>, o: vec2<f32>, texel: vec2<f32>) -> vec3<f32> {
  return textureSampleLevel(source, linearClamp, uv + o * texel, 0.0).rgb;
}

fn karis(c: vec3<f32>) -> f32 {
  return 1.0 / (1.0 + dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)));
}

fn downsample(frag: vec2<f32>, firstLevel: bool) -> vec3<f32> {
  let outSize = vec2<f32>(textureDimensions(source, 0)) * 0.5;
  let uv = frag / max(floor(outSize), vec2<f32>(1.0));
  let texel = 1.0 / vec2<f32>(textureDimensions(source, 0));
  let a = tap(uv, vec2<f32>(-2.0, -2.0), texel);
  let b = tap(uv, vec2<f32>(0.0, -2.0), texel);
  let c = tap(uv, vec2<f32>(2.0, -2.0), texel);
  let d = tap(uv, vec2<f32>(-1.0, -1.0), texel);
  let e = tap(uv, vec2<f32>(1.0, -1.0), texel);
  let f = tap(uv, vec2<f32>(-2.0, 0.0), texel);
  let g = tap(uv, vec2<f32>(0.0, 0.0), texel);
  let h = tap(uv, vec2<f32>(2.0, 0.0), texel);
  let i = tap(uv, vec2<f32>(-1.0, 1.0), texel);
  let j = tap(uv, vec2<f32>(1.0, 1.0), texel);
  let k = tap(uv, vec2<f32>(-2.0, 2.0), texel);
  let l = tap(uv, vec2<f32>(0.0, 2.0), texel);
  let m = tap(uv, vec2<f32>(2.0, 2.0), texel);
  let inner = (d + e + i + j) * 0.25;
  let g0 = (a + b + f + g) * 0.25;
  let g1 = (b + c + g + h) * 0.25;
  let g2 = (f + g + k + l) * 0.25;
  let g3 = (g + h + l + m) * 0.25;
  if (!firstLevel) {
    return inner * 0.5 + (g0 + g1 + g2 + g3) * 0.125;
  }
  // Karis average: one very bright texel (the sun) does not flicker the whole bloom.
  let wi = karis(inner) * 0.5;
  let w0 = karis(g0) * 0.125;
  let w1 = karis(g1) * 0.125;
  let w2 = karis(g2) * 0.125;
  let w3 = karis(g3) * 0.125;
  return (inner * wi + g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3) / (wi + w0 + w1 + w2 + w3);
}

@fragment
fn bloom_down_first_fs(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(downsample(frag.xy, true), 1.0);
}

@fragment
fn bloom_down_fs(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(downsample(frag.xy, false), 1.0);
}

/** 3×3 tent of the smaller level, added onto the larger one (additive blend). */
@fragment
fn bloom_up_fs(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let srcSize = vec2<f32>(textureDimensions(source, 0));
  let uv = frag.xy / (srcSize * 2.0);
  let texel = 1.0 / srcSize;
  var s = tap(uv, vec2<f32>(0.0, 0.0), texel) * 4.0;
  s += (tap(uv, vec2<f32>(-1.0, 0.0), texel) + tap(uv, vec2<f32>(1.0, 0.0), texel) + tap(uv, vec2<f32>(0.0, -1.0), texel) + tap(uv, vec2<f32>(0.0, 1.0), texel)) * 2.0;
  s += tap(uv, vec2<f32>(-1.0, -1.0), texel) + tap(uv, vec2<f32>(1.0, -1.0), texel) + tap(uv, vec2<f32>(-1.0, 1.0), texel) + tap(uv, vec2<f32>(1.0, 1.0), texel);
  return vec4<f32>(s / 16.0, 1.0);
}
`;

export const FINAL_SHADER = /* wgsl */ `
${WGSL_PHOTO_STRUCT}
${WGSL_PHOTO_HELPERS}
${WGSL_PHOTO_LIGHTING_STRUCT}
${FULLSCREEN_VS}
@group(0) @binding(0) var<uniform> photo: Photo;
@group(0) @binding(1) var<storage, read> lighting: PhotoLighting;
@group(0) @binding(2) var hdrTex: texture_2d<f32>;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;
@group(0) @binding(4) var overlayTex: texture_2d<f32>;
@group(0) @binding(5) var linearClamp: sampler;

// AgX (Troy Sobotka), sRGB primaries version of Benjamin Wrensch's fit.
fn agxContrast(x: vec3<f32>) -> vec3<f32> {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

fn agx(color: vec3<f32>) -> vec3<f32> {
  let inset = mat3x3<f32>(
    0.842479062253094, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772, 0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  let outset = mat3x3<f32>(
    1.19687900512017, -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  let minEv = -12.47393;
  let maxEv = 4.026069;
  var v = inset * max(color, vec3<f32>(1e-10));
  v = clamp(log2(max(v, vec3<f32>(1e-10))), vec3<f32>(minEv), vec3<f32>(maxEv));
  v = (v - minEv) / (maxEv - minEv);
  v = agxContrast(v);
  // Mild "photo" look between AgX base and punchy.
  let luma = dot(v, vec3<f32>(0.2126, 0.7152, 0.0722));
  v = pow(max(v, vec3<f32>(0.0)), vec3<f32>(1.06));
  v = luma + 1.1 * (v - luma);
  v = outset * v;
  return pow(max(v, vec3<f32>(0.0)), vec3<f32>(2.2));
}

@fragment
fn final_fs(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = frag.xy / photo.targetSize.zw;
  let hdr = textureSampleLevel(hdrTex, linearClamp, uv, 0.0).rgb;
  let bloom = textureSampleLevel(bloomTex, linearClamp, uv, 0.0).rgb / ${BLOOM_LEVELS}.0;
  var exposure = lighting.exposure.x * photo.exposure.x;
  if (photo.quality.w > 0.5 && photo.quality.w != 1.0 && photo.quality.w != 2.0 && photo.quality.w != 4.0) { exposure = 3.0; }
  let scene = mix(hdr, bloom, photo.exposure.z) * exposure;
  var display = linearToSrgb3(agx(scene));
  display += (ign(frag.xy) - 0.5) / 255.0;
  let overlay = textureSampleLevel(overlayTex, linearClamp, uv, 0.0);
  display = overlay.rgb + display * (1.0 - overlay.a);
  return vec4<f32>(display, 1.0);
}
`;
