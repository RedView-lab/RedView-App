// ============================================
// Photo mode — volumetric clouds
// ============================================
//
// Static clouds around the scene only, traced progressively until the image
// is clean. After Guerrilla's Nubis (Schneider, "The Real-time Volumetric
// Cloudscapes of Horizon Zero Dawn" 2015, "Nubis, Evolved" 2022, "Nubis³:
// Methods (and madness) to model and render immersive real-time voxel-based
// clouds" 2023) and Hillaire ("Physically Based Sky, Atmosphere and Cloud
// Rendering in Frostbite" 2016):
//  - model: as in Nubis³, a voxel "dimensional profile" (0 outside, 1 deep
//    inside) holds the cloud's structure at the scale of its turrets. The
//    cumulus are nested spheres (`lib/cumulusModel.ts`: thermals, their
//    heads and side lobes, turrets on turrets down to ~60 m) voxelized here
//    as the smooth union of their depths; layer clouds come from the weather
//    map (broad patches with a flat top). 512²×128 voxels over the 26 km
//    domain;
//  - up-rez: Nubis³'s noise, rebuilt from its Houdini generator (turbulent
//    Alligator noise; curl-warped "curly-Alligator" wisps), applied as its
//    value erosion of the profile at two scales — billows of 120–240 m and
//    their fine texture, then billows of 25–45 m down to a few metres —
//    wispy where the profile is thin or the cloud is a layer, billowy on the
//    cumulus; then sharpened (density^0.6, Nubis³'s value);
//  - light: towards the sun, six detailed samples on a geometric series
//    (8 m → 0.5–1 km) then a light volume (optical depth to the top of the
//    layer, 100 m voxels) for the long shadows; Mie phase fit (HG + Draine,
//    Jendersie & d'Eon 2023), four multiple-scattering octaves (Wrenninge
//    2013), Nubis³'s in-scattering probability from the profile (dark
//    crevices and bases). Sky and ground light are marched through the
//    model itself (cosine-weighted directions, a new one per accumulated
//    sample): crevices and the undersides of turrets see less sky, the
//    lumps facing it more — the structure stays readable in the shade;
//    energy-conserving integration (Hillaire 2016);
//  - march: big steps outside the occupied voxels (light volume), then
//    steps sized for an optical depth of ~0.35 per step and never longer
//    than a few pixel footprints;
//  - convergence: while the view moves, half resolution, one pixel of each
//    2×2 block per frame and reprojection; once it stops, every pixel at
//    full resolution with its own low-discrepancy sequence, averaged in
//    place over 32–48 samples;
//  - ground: a 1024² shadow map on the base plane, marched with the
//    detailed field (direct and diffuse transmission, two-stream).

import { WGSL_PHOTO_HELPERS, WGSL_PHOTO_STRUCT } from './photoCommon';
import { WGSL_ATMOSPHERE, WGSL_ATMOSPHERE_LOOKUPS, WGSL_PHOTO_LIGHTING_STRUCT } from './atmosphereShaders';
import { FULLSCREEN_VS } from './lightingShader';
import { CUMULUS_GRID_XZ, CUMULUS_GRID_Y } from '../../lib/cumulusModel';

export const UPREZ_NOISE_SIZE = 128;
export const LOBE_NOISE_SIZE = 128;
export const WEATHER_SIZE = 1024;
/** Dimensional profile voxels (x, z, height). */
export const MODEL_SIZE: [number, number, number] = [512, 512, 128];
/** Baked lighting voxels (x, z, height): ≈ 40 m over the domain. */
export const LIGHT_VOLUME_SIZE: [number, number, number] = [512, 512, 64];
export const CLOUD_SHADOW_SIZE = 1024;
/** Half-size of the square around the scene centre where clouds exist (m): nothing is traced beyond. */
export const CLOUD_DOMAIN_HALF_M = 10000;
/** Clouds keep their full size within this distance of the scene centre, then shrink and thin out. */
export const CLOUD_FULL_RADIUS_M = 3500;
/** Periods of the lobe noise (mid scale) and of Nubis³'s noise (fine scale) (m). */
const UPREZ_MID_PERIOD_M = 720;
const UPREZ_FINE_PERIOD_M = 170;
/** Depth under a sphere's surface where the profile reaches 1 (m): the profile is a depth in metres up to there. */
const PROFILE_RAMP_M = 250;
/** Amplitude (m) and period (m) of the warp of the spheres' space: no perfect sphere left. */
const MODEL_WARP_M = 90;
const MODEL_WARP_PERIOD_M = 812;
/** Width of the smooth union of the spheres (m): a fillet in the crevices instead of a crease. */
const SMOOTH_UNION_M = 45;
export const MAX_ANVILS = 32;
/** Patches of the sub-layers: a 2D map over this half-size around the scene (m). */
export const HIGH_COVER_SIZE = 1024;
const HIGH_COVER_HALF_M = 200000;
/** Work per frame of the progressive builds. */
export const NOISE_SLICES_PER_STEP = 4;
export const MODEL_SLICES_PER_STEP = 4;
export const LIGHT_SLICES_PER_STEP = 2;
export const SHADOW_ROWS_PER_STEP = 256;

const WGSL_NOISE = /* wgsl */ `
fn pcg3d(v0: vec3<u32>) -> vec3<u32> {
  var v = v0 * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v = v ^ (v >> vec3<u32>(16u));
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

fn wrapCell(c: vec3<i32>, period: i32) -> vec3<u32> {
  return vec3<u32>(((c % vec3<i32>(period)) + vec3<i32>(period)) % vec3<i32>(period));
}

fn hash3(c: vec3<i32>, period: i32, seed: u32) -> vec3<f32> {
  return vec3<f32>(pcg3d(wrapCell(c, period) + vec3<u32>(seed * 7919u, seed * 104729u, seed * 1299709u))) * (1.0 / 4294967295.0);
}

fn hash4(c: vec3<i32>, period: i32, seed: u32) -> vec4<f32> {
  let a = pcg3d(wrapCell(c, period) + vec3<u32>(seed * 7919u, seed * 104729u, seed * 1299709u));
  let b = pcg3d(vec3<u32>(a.z ^ 0x9e3779b9u, a.x ^ 0x85ebca6bu, a.y ^ 0xc2b2ae35u));
  return vec4<f32>(f32(a.x), f32(a.y), f32(a.z), f32(b.x)) * (1.0 / 4294967296.0);
}

fn fade(t: vec3<f32>) -> vec3<f32> {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn gradDot(c: vec3<i32>, period: i32, seed: u32, f: vec3<f32>) -> f32 {
  return dot(normalize(hash3(c, period, seed) * 2.0 - 1.0 + vec3<f32>(1e-4)), f);
}

/** Tileable gradient noise in [−1, 1] of p ∈ [0, 1)³ with \`period\` cells per side. */
fn perlin(p: vec3<f32>, period: i32, seed: u32) -> f32 {
  let q = p * f32(period);
  let i = vec3<i32>(floor(q));
  let f = q - vec3<f32>(i);
  let u = fade(f);
  let n000 = gradDot(i, period, seed, f);
  let n100 = gradDot(i + vec3<i32>(1, 0, 0), period, seed, f - vec3<f32>(1.0, 0.0, 0.0));
  let n010 = gradDot(i + vec3<i32>(0, 1, 0), period, seed, f - vec3<f32>(0.0, 1.0, 0.0));
  let n110 = gradDot(i + vec3<i32>(1, 1, 0), period, seed, f - vec3<f32>(1.0, 1.0, 0.0));
  let n001 = gradDot(i + vec3<i32>(0, 0, 1), period, seed, f - vec3<f32>(0.0, 0.0, 1.0));
  let n101 = gradDot(i + vec3<i32>(1, 0, 1), period, seed, f - vec3<f32>(1.0, 0.0, 1.0));
  let n011 = gradDot(i + vec3<i32>(0, 1, 1), period, seed, f - vec3<f32>(0.0, 1.0, 1.0));
  let n111 = gradDot(i + vec3<i32>(1, 1, 1), period, seed, f - vec3<f32>(1.0, 1.0, 1.0));
  let x00 = mix(n000, n100, u.x);
  let x10 = mix(n010, n110, u.x);
  let x01 = mix(n001, n101, u.x);
  let x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

/** Tileable fBm in [0, 1]. */
fn perlinFbm(p: vec3<f32>, period: i32, octaves: i32, seed: u32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var norm = 0.0;
  var per = period;
  for (var o = 0; o < octaves; o++) {
    sum += perlin(p, per, seed + u32(o) * 31u) * 1.15 * amp;
    norm += amp;
    amp *= 0.5;
    per *= 2;
  }
  return clamp(sum / norm * 0.5 + 0.5, 0.0, 1.0);
}

fn remap(v: f32, lo: f32, hi: f32, nlo: f32, nhi: f32) -> f32 {
  return nlo + (v - lo) * (nhi - nlo) / max(hi - lo, 1e-5);
}
`;

/**
 * Nubis³'s cloud noise, after its Houdini generator (Nubis Voxel Clouds
 * Pack, 2023): Houdini's turbulent Alligator noise (SideFX HDK example:
 * per cell a random centre and height, a smoothstep bump of radius one
 * cell, the highest bump minus the second highest — round plates with sharp
 * cracks), octaves normalised by their total amplitude, and curl noise
 * (curl of a 3-octave Perlin potential) warping the wisps. Checked against
 * the pack's exported volume: same channel histograms.
 */
const WGSL_NUBIS_NOISE = /* wgsl */ `
/** Alligator noise of q (cell units), \`period\` cells per tile. */
fn alligator(q: vec3<f32>, period: i32, seed: u32) -> f32 {
  let id = vec3<i32>(floor(q));
  let f = q - vec3<f32>(id);
  var m1 = 0.0;
  var m2 = 0.0;
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let o = vec3<i32>(x, y, z);
        let h = hash4(id + o, period, seed);
        let d = length(vec3<f32>(o) + h.xyz - f);
        if (d < 1.0) {
          let s = 1.0 - d;
          let v = h.w * s * s * (3.0 - 2.0 * s);
          if (v > m1) { m2 = m1; m1 = v; } else if (v > m2) { m2 = v; }
        }
      }
    }
  }
  return m1 - m2;
}

/** Houdini's turbulent noise of type Alligator on the tile p ∈ [0, 1)³: \`freq\` cells per tile, octaves × 2. */
fn turbAlligator(p: vec3<f32>, freq: i32, octaves: i32, rough: f32, atten: f32, seed: u32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var norm = 0.0;
  var f = freq;
  for (var o = 0; o < octaves; o++) {
    sum += amp * alligator(p * f32(f), f, seed + u32(o) * 31u);
    norm += amp;
    amp *= rough;
    f *= 2;
  }
  return pow(max(sum / norm, 0.0), atten);
}

fn perlinSum(p: vec3<f32>, period: i32, seed: u32) -> f32 {
  return perlin(p, period, seed) + 0.5 * perlin(p, period * 2, seed + 13u) + 0.25 * perlin(p, period * 4, seed + 26u);
}

fn curlPotential(p: vec3<f32>, period: i32, seed: u32) -> vec3<f32> {
  return vec3<f32>(perlinSum(p, period, seed), perlinSum(p, period, seed + 101u), perlinSum(p, period, seed + 202u));
}

/** Curl of a Perlin potential (divergence-free: swirls, no sources). */
fn curlNoise(p: vec3<f32>, period: i32, seed: u32) -> vec3<f32> {
  let h = 1.0 / 1024.0;
  let dx = (curlPotential(p + vec3<f32>(h, 0.0, 0.0), period, seed) - curlPotential(p - vec3<f32>(h, 0.0, 0.0), period, seed)) / (2.0 * h);
  let dy = (curlPotential(p + vec3<f32>(0.0, h, 0.0), period, seed) - curlPotential(p - vec3<f32>(0.0, h, 0.0), period, seed)) / (2.0 * h);
  let dz = (curlPotential(p + vec3<f32>(0.0, 0.0, h), period, seed) - curlPotential(p - vec3<f32>(0.0, 0.0, h), period, seed)) / (2.0 * h);
  return vec3<f32>(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x);
}

/** Houdini's Fit: v from [a, b] to [c, d], clamped. */
fn fitRange(v: f32, a: f32, b: f32, c: f32, d: f32) -> f32 {
  return mix(c, d, saturate((v - a) / (b - a)));
}
`;

const WGSL_SLICE_PARAMS = /* wgsl */ `
struct SliceParams {
  /** First z slice (noise, model, light volume) or row (shadow map) of this dispatch. */
  zStart: u32,
  /** Weather map: seed, cover, type, cell spacing (m), anvil count, domain half-size and full-size radius (m). */
  seed: u32,
  coverage: f32,
  cloudType: f32,
  cellSize: f32,
  anvilCount: f32,
  domainHalf: f32,
  fullRadius: f32,
  _pad: vec4<f32>,
  /** w = layer thickness (m). */
  sun: vec4<f32>,
};
`;

/**
 * Up-rez noise 128³ (one tile, sampled at two periods): R / G low / high
 * frequency curly-Alligator wisps, B / A low / high frequency Alligator
 * billows (dark lumps, bright cracks) over a fine Alligator grain.
 */
export const UPREZ_NOISE_SHADER = /* wgsl */ `
${WGSL_NOISE}
${WGSL_NUBIS_NOISE}
${WGSL_SLICE_PARAMS}
@group(0) @binding(0) var<uniform> slice: SliceParams;
@group(0) @binding(1) var outTex: texture_storage_3d<rgba8unorm, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid0: vec3<u32>) {
  let gid = vec3<u32>(gid0.xy, gid0.z + slice.zStart);
  let size = textureDimensions(outTex);
  if (gid.x >= size.x || gid.y >= size.y || gid.z >= size.z) { return; }
  let p = (vec3<f32>(gid) + 0.5) / vec3<f32>(size);
  let pLow = p + curlNoise(p, 3, 500u) * 0.01;
  let pHigh = p + curlNoise(p, 5, 600u) * 0.005;
  let wispLow = pow(fitRange(fitRange(turbAlligator(pLow, 2, 5, 0.608, 1.0, 11u), -0.6, 0.881, 1.0, 0.0), 0.3, 0.7, 1.0, 0.0), 4.0);
  let wispHigh = pow(fitRange(fitRange(turbAlligator(pHigh, 4, 5, 0.608, 1.0, 21u), -0.6, 0.881, 1.0, 0.0), 0.3, 0.7, 1.0, 0.0), 4.0);
  let grainLow = fitRange(turbAlligator(p, 26, 2, 0.5, 0.5, 51u), 0.0, 1.0, 0.214, 0.0);
  let grainHigh = fitRange(turbAlligator(p, 26, 2, 0.5, 0.5, 61u), 0.0, 1.0, 0.214, 0.0);
  let billowLow = max(pow(1.0 - fitRange(turbAlligator(p, 3, 5, 0.5, 1.0, 31u), 0.003, 0.734, 0.0, 1.0), 6.0), grainLow);
  let billowHigh = max(pow(1.0 - fitRange(turbAlligator(p, 5, 5, 0.5, 1.0, 41u), 0.003, 0.734, 0.0, 1.0), 6.0), grainHigh);
  textureStore(outTex, vec3<i32>(gid), vec4<f32>(wispLow, wispHigh, billowLow, billowHigh));
}
`;

/**
 * Lobe noise 128³ (one tile of ${UPREZ_MID_PERIOD_M} m): the height of the
 * domes of a turbulent Alligator noise (0 in the cracks, 1 on the highest
 * tops) at 2, 3, 5 and 8 cells per tile (360, 240, 144, 90 m). Summed with
 * weights, it is an fBm of domes — big lobes carrying smaller ones — whose
 * complement erodes the model: the cauliflower between the modelled turrets.
 */
export const LOBE_NOISE_SHADER = /* wgsl */ `
${WGSL_NOISE}
${WGSL_NUBIS_NOISE}
${WGSL_SLICE_PARAMS}
@group(0) @binding(0) var<uniform> slice: SliceParams;
@group(0) @binding(1) var outTex: texture_storage_3d<rgba8unorm, write>;

fn dome(p: vec3<f32>, freq: i32, octaves: i32, seed: u32) -> f32 {
  return saturate(turbAlligator(p, freq, octaves, 0.5, 1.0, seed) / 0.45);
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid0: vec3<u32>) {
  let gid = vec3<u32>(gid0.xy, gid0.z + slice.zStart);
  let size = textureDimensions(outTex);
  if (gid.x >= size.x || gid.y >= size.y || gid.z >= size.z) { return; }
  let p = (vec3<f32>(gid) + 0.5) / vec3<f32>(size);
  textureStore(outTex, vec3<i32>(gid), vec4<f32>(dome(p, 2, 3, 71u), dome(p, 3, 3, 72u), dome(p, 5, 3, 73u), dome(p, 8, 2, 74u)));
}
`;

/**
 * Weather map (${WEATHER_SIZE}², the cloud domain): R = cover of the layer
 * clouds (broad fBm patches with a quantile threshold, zero where the sky is
 * cumulus), G = cloud type, B = anvil sheet (around the tallest
 * cumulonimbus towers), A = height of the layer there (fraction of the
 * layer). The cumulus themselves are in the model volume.
 */
export const WEATHER_SHADER = /* wgsl */ `
${WGSL_NOISE}
${WGSL_SLICE_PARAMS}
struct Anvils {
  items: array<vec4<f32>, ${MAX_ANVILS}>,
};
@group(0) @binding(0) var<uniform> slice: SliceParams;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> anvils: Anvils;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(outTex);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let uv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(size);
  let domainHalf = slice.domainHalf;
  let p = (uv * 2.0 - 1.0) * domainHalf;
  let cov = clamp(slice.coverage, 0.0, 1.0);
  if (cov <= 0.001) {
    textureStore(outTex, vec2<i32>(gid.xy), vec4<f32>(0.0));
    return;
  }
  let seed = slice.seed * 97u + 13u;
  let falloff = 1.0 - smoothstep(slice.fullRadius, domainHalf * 0.95, length(p));
  let n = vec3<f32>(uv, 0.37);
  let cellsPerDomain = max(2, i32(round(2.0 * domainHalf / slice.cellSize)));
  let patches = perlinFbm(n, max(2, cellsPerDomain / 2), 4, seed + 1u);
  let fine = perlinFbm(n, cellsPerDomain * 4, 2, seed + 3u);
  let layerThreshold = mix(0.72, 0.28, cov);
  var cover = smoothstep(layerThreshold - 0.04, layerThreshold + 0.14, patches + (fine - 0.5) * 0.12) * falloff;
  var height = mix(0.55, 1.0, smoothstep(0.4, 0.75, patches));
  let typeVariation = perlinFbm(n, 6, 2, seed + 4u) - 0.5;
  let cloudType = clamp(slice.cloudType + typeVariation * 0.25, 0.0, 1.0);
  cover *= 1.0 - smoothstep(0.45, 0.9, cloudType);
  if (cov >= 0.97) {
    cover = max(cover, 0.75 * falloff);
    height = max(height, 0.7);
  }
  var anvil = 0.0;
  let count = min(u32(slice.anvilCount), ${MAX_ANVILS}u);
  for (var i = 0u; i < count; i++) {
    let a = anvils.items[i];
    anvil = max(anvil, sqrt(saturate(1.0 - distance(p, a.xy) / max(a.z, 1.0))));
  }
  textureStore(outTex, vec2<i32>(gid.xy), vec4<f32>(cover, cloudType, anvil, height));
}
`;

/** Profile of the layer clouds and the anvils from the weather map (no cumulus). */
const WGSL_LAYER_PROFILE = /* wgsl */ `
/** Width of the transition from a layer cloud's surface to its core, in cover units. */
const LAYER_SOFTNESS: f32 = 0.8;

fn layerProfile(w: vec4<f32>, hf: f32, thickness: f32) -> f32 {
  var profile = 0.0;
  if (w.r > 0.0) {
    // Flat top: the cover must exceed (h / height)^8.
    profile = saturate((w.r - pow(hf / max(w.a, 0.04), 8.0)) / LAYER_SOFTNESS);
  }
  // Cumulonimbus anvil: a flat sheet under the top, wide around the towers.
  if (w.b > 0.001) {
    profile = max(profile, saturate((w.b * 0.07 - abs(hf - 0.88)) * thickness / 120.0));
  }
  return profile;
}
`;

/**
 * Dimensional profile voxels (${MODEL_SIZE.join('×')}, r8 packed four per
 * word into a buffer copied to the 3D texture): the smooth union of the
 * cumulus spheres' depths (bucketed in a ${CUMULUS_GRID_XZ}²×${CUMULUS_GRID_Y}
 * grid), ramped to 1 over ${PROFILE_RAMP_M} m, and the layer clouds.
 */
export const MODEL_SHADER = /* wgsl */ `
${WGSL_NOISE}
${WGSL_SLICE_PARAMS}
${WGSL_LAYER_PROFILE}
@group(0) @binding(0) var<uniform> slice: SliceParams;
@group(0) @binding(1) var weatherTex: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;
@group(0) @binding(3) var<storage, read> spheres: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> cells: array<vec2<u32>>;
@group(0) @binding(5) var<storage, read> indices: array<u32>;
@group(0) @binding(6) var<storage, read_write> outWords: array<u32>;

const MODEL_X: u32 = ${MODEL_SIZE[0]}u;
const MODEL_Z: u32 = ${MODEL_SIZE[1]}u;
const MODEL_H: u32 = ${MODEL_SIZE[2]}u;
const GRID_XZ: i32 = ${CUMULUS_GRID_XZ};
const GRID_Y: i32 = ${CUMULUS_GRID_Y};
const RAMP: f32 = ${PROFILE_RAMP_M}.0;
const SMOOTH_K: f32 = ${SMOOTH_UNION_M}.0;
const WARP_M: f32 = ${MODEL_WARP_M}.0;

/** Smooth displacement of the spheres' space (periodic over the domain). */
fn modelWarp(p: vec3<f32>, domainHalf: f32) -> vec3<f32> {
  let period = max(2, i32(round(2.0 * domainHalf / ${MODEL_WARP_PERIOD_M}.0)));
  let q = vec3<f32>(p.x + domainHalf, p.y, p.z + domainHalf) / (2.0 * domainHalf);
  return vec3<f32>(perlin(q, period, 901u), perlin(q, period, 902u), perlin(q, period, 903u)) * WARP_M;
}

fn smoothMax(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return max(a, b) + h * h * k * 0.25;
}

@compute @workgroup_size(16, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let group = gid.x;
  let row = gid.y;
  let level = slice.zStart + gid.z;
  if (group >= MODEL_X / 4u || row >= MODEL_Z || level >= MODEL_H) { return; }
  let domainHalf = slice.domainHalf;
  let thickness = slice.sun.w;
  let voxel = 2.0 * domainHalf / f32(MODEL_X);
  let hf = (f32(level) + 0.5) / f32(MODEL_H);
  let y = hf * thickness;
  let z = -domainHalf + (f32(row) + 0.5) * voxel;
  let cellXZ = 2.0 * domainHalf / f32(GRID_XZ);
  let cz = clamp(i32(floor((z + domainHalf) / cellXZ)), 0, GRID_XZ - 1);
  let cy = clamp(i32(floor(y / (thickness / f32(GRID_Y)))), 0, GRID_Y - 1);
  var packed = 0u;
  for (var k = 0u; k < 4u; k++) {
    let x = -domainHalf + (f32(group * 4u + k) + 0.5) * voxel;
    let w = textureSampleLevel(weatherTex, linearClamp, vec2<f32>(x, z) / (2.0 * domainHalf) + 0.5, 0.0);
    var dp = layerProfile(w, hf, thickness);
    let cx = clamp(i32(floor((x + domainHalf) / cellXZ)), 0, GRID_XZ - 1);
    let cell = cells[u32(cx + GRID_XZ * (cz + GRID_XZ * cy))];
    var depth = -1.0e9;
    let p = vec3<f32>(x, y, z) + modelWarp(vec3<f32>(x, y, z), domainHalf);
    for (var i = 0u; i < cell.y; i++) {
      let s = spheres[indices[cell.x + i]];
      depth = smoothMax(depth, s.w - distance(p, s.xyz), SMOOTH_K);
    }
    dp = max(dp, saturate(depth / RAMP) * smoothstep(0.45, 0.9, w.g));
    packed |= u32(round(saturate(dp) * 255.0)) << (8u * k);
  }
  outWords[(gid.z * MODEL_Z + row) * (MODEL_X / 4u) + group] = packed;
}
`;


/**
 * Patches of the two sub-layers (HIGH_COVER_SIZE² over ±HIGH_COVER_HALF_M):
 * broad warped fBm patches and bands, where air masses meet (Nubis 2017).
 * R / G = mid / high layer, around 0.5; the march adds the layer's mean cover.
 */
export const HIGH_COVER_SHADER = /* wgsl */ `
${WGSL_PHOTO_STRUCT}
${WGSL_NOISE}
@group(0) @binding(0) var<uniform> photo: Photo;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba8unorm, write>;
fn cellRandom2(c: vec2<i32>, seed: u32) -> f32 {
  return f32(pcg3d(vec3<u32>(bitcast<vec2<u32>>(c), seed)).x) * (1.0 / 4294967296.0);
}

fn valueNoise2(p: vec2<f32>, seed: u32) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  let c = vec2<i32>(i);
  let a = cellRandom2(c, seed);
  let b = cellRandom2(c + vec2<i32>(1, 0), seed);
  let d = cellRandom2(c + vec2<i32>(0, 1), seed);
  let e = cellRandom2(c + vec2<i32>(1, 1), seed);
  return mix(mix(a, b, u.x), mix(d, e, u.x), u.y);
}

fn fbm2(p: vec2<f32>, seed: u32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var q = p;
  for (var o = 0u; o < 4u; o++) {
    sum += amp * valueNoise2(q, seed + o);
    q = q * 2.03 + vec2<f32>(1.7, 9.2);
    amp *= 0.5;
  }
  return sum / 0.9375;
}

fn patchesAt(xz: vec2<f32>, index: u32) -> f32 {
  let seed = index * 97u + u32(photo.cloudParams.w) * 13u + 5u;
  let warp = vec2<f32>(fbm2(xz / 31000.0, seed), fbm2(xz / 31000.0 + vec2<f32>(5.2, 1.3), seed + 7u)) - 0.5;
  return fbm2(xz / 17000.0 + warp * 1.6, seed + 17u);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(outTex);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let xz = ((vec2<f32>(gid.xy) + 0.5) / vec2<f32>(size) * 2.0 - 1.0) * ${HIGH_COVER_HALF_M}.0;
  textureStore(outTex, vec2<i32>(gid.xy), vec4<f32>(patchesAt(xz, 0u), patchesAt(xz, 1u), 0.0, 1.0));
}
`;

/** Coordinates of the cloud domain and transmissions of an optical depth. */
const WGSL_CLOUD_DOMAIN = /* wgsl */ `
/** Diffuse transmission of a slab of optical depth τ (two-stream, g ≈ 0.85): 1 / (1 + ¾(1 − g)τ). */
const DIFFUSE_TRANSMISSION_K: f32 = 0.1125;

fn cloudDomainUv(x: f32, z: f32) -> vec2<f32> {
  return vec2<f32>(x, z) / (2.0 * photo.cloudParams.z) + 0.5;
}

/** Distance along the unit ray d (from x/z = o) to where it leaves the cloud domain's square. */
fn domainExit(o: vec2<f32>, d: vec2<f32>) -> f32 {
  let domainHalf = photo.cloudParams.z;
  let inv = 1.0 / select(d, vec2<f32>(1e-6), abs(d) < vec2<f32>(1e-6));
  let t1 = (vec2<f32>(-domainHalf) - o) * inv;
  let t2 = (vec2<f32>(domainHalf) - o) * inv;
  return max(min(max(t1.x, t2.x), max(t1.y, t2.y)), 0.0);
}

/** Direct (Beer) and total (direct + diffuse) transmission of an optical depth τ. */
fn cloudTransmissions(tau: f32) -> vec2<f32> {
  return vec2<f32>(exp(-tau), 1.0 / (1.0 + DIFFUSE_TRANSMISSION_K * tau));
}
`;

/** Light volume lookup (needs lightVolume/linearClamp). */
const WGSL_LIGHT_VOLUME_LOOKUP = /* wgsl */ `
/** The baked depth towards the sun is stored as 1 − exp(−depth / SUN_DEPTH_SCALE) (8 bits: fine near 0, up to ≈ 250). */
const SUN_DEPTH_SCALE: f32 = 40.0;

/**
 * Baked lighting at a point of the layer: x = encoded depth (density·m)
 * towards the sun, y = visible share of the sky, z = densest profile
 * around (empty-space skipping), w = visible share of the ground.
 */
fn lightVolumeAt(x: f32, z: f32, hf: f32) -> vec4<f32> {
  return textureSampleLevel(lightVolume, linearClamp, vec3<f32>(cloudDomainUv(x, z), hf), 0.0);
}

fn decodeSunDepth(v: f32) -> f32 {
  return -SUN_DEPTH_SCALE * log(max(1.0 - v, 1.0 / 512.0));
}

/** Depth (density·m) from a point of the layer to the sun, baked. */
fn sunDepthAt(x: f32, z: f32, hf: f32) -> f32 {
  return decodeSunDepth(lightVolumeAt(x, z, hf).x);
}
`;

/** Density of the cloud field, shared by the light volume, the shadow map and the ray march. */
const WGSL_CLOUD_DENSITY = /* wgsl */ `
const UPREZ_MID_PERIOD: f32 = ${UPREZ_MID_PERIOD_M}.0;
const UPREZ_FINE_PERIOD: f32 = ${UPREZ_FINE_PERIOD_M}.0;
/** Depth (m) under the model's surface where the profile reaches 1. */
const PROFILE_DEPTH_M: f32 = ${PROFILE_RAMP_M}.0;
/** The base is reached within this height (m). */
const BASE_RAMP_M: f32 = 30.0;
/** Height (m) over which the base is ragged instead of flat. */
const BASE_FRAY_M: f32 = 140.0;
/** Height (m) above the base where the cumulus go from wispy (ragged base) to billowy. */
const BILLOW_HEIGHT_M: f32 = 250.0;
/**
 * Mid scale: the cracks between lobes are eroded this deep (m), the dome
 * tops not at all (complement of the weighted lobe heights, shifted so that
 * the tops stay whole).
 */
const LOBE_DEPTH_M: f32 = 170.0;
const LOBE_WEIGHTS: vec4<f32> = vec4<f32>(0.45, 0.3, 0.17, 0.08);
const LOBE_SHIFT: f32 = 0.18;
/** Fine scale: Nubis³'s billows (cracks + grain) carve this deep (m); its wisps up to the whole profile. */
const FINE_BILLOW_DEPTH_M: f32 = 20.0;
/**
 * From the eroded surface, the density reaches 1 over this depth (m): a
 * vapour skin the light enters (30 m read as plaster, the clouds as solid
 * models), not a fuzzy halo either.
 */
const DENSITY_RAMP_M: f32 = 65.0;
/** Turbulence of the fine lookup: displaced by the mid-scale noise (m). */
const FINE_WARP_M: f32 = 30.0;
/** Density = (eroded depth / ramp)^SHARPEN (Nubis³'s 0.6 for full density scale). */
const SHARPEN: f32 = 0.75;
/** Weight of the fine erosion (1 near, less far away where it is sub-pixel). */
var<private> cloudDetailWeight: f32 = 1.0;

fn weatherAt(x: f32, z: f32) -> vec4<f32> {
  return textureSampleLevel(weatherTex, linearClamp, cloudDomainUv(x, z), 0.0);
}

fn cumulusAmount(w: vec4<f32>) -> f32 {
  return smoothstep(0.45, 0.9, w.g);
}

/** Dimensional profile at a point of the layer (0 outside the clouds, 1 deep inside); flat base. */
fn dimensionalProfile(x: f32, z: f32, hf: f32) -> f32 {
  if (hf <= 0.0 || hf >= 1.0) { return 0.0; }
  let dp = textureSampleLevel(modelTex, linearClamp, vec3<f32>(cloudDomainUv(x, z), hf), 0.0).r;
  return dp * saturate(hf * (photo.cloudLayer.y - photo.cloudLayer.x) / BASE_RAMP_M);
}

/**
 * Density (0–1); where it is zero, a step (m) that does not jump over the
 * nearest material (half the depth still to erode); and the depth (m) under
 * the eroded surface (in-scattering probability). The profile is a
 * depth under the model's surface; the lobe noise carves the cauliflower
 * between the modelled turrets (wisps on layer clouds and ragged bases),
 * Nubis³'s noise the fine billows and grain; the density then rises over
 * DENSITY_RAMP_M.
 */
fn cloudSample(w: vec4<f32>, dp: f32, x: f32, z: f32, hf: f32, detail: bool) -> vec3<f32> {
  let thickness = photo.cloudLayer.y - photo.cloudLayer.x;
  let y = hf * thickness;
  let cumulus = cumulusAmount(w);
  let detailType = cumulus * smoothstep(0.0, BILLOW_HEIGHT_M, y);
  let p = vec3<f32>(x, y, z);
  let lobes = textureSampleLevel(lobeTex, repeatSampler, p / UPREZ_MID_PERIOD, 0.0);
  let lobeErosion = saturate((1.0 - dot(lobes, LOBE_WEIGHTS) - LOBE_SHIFT) / (1.0 - LOBE_SHIFT)) * LOBE_DEPTH_M;
  var nm = vec4<f32>(0.0);
  if (detail || detailType < 0.999) { nm = textureSampleLevel(uprezTex, repeatSampler, p / UPREZ_MID_PERIOD, 0.0); }
  let wispErosion = mix(nm.r, nm.g, dp) * PROFILE_DEPTH_M;
  var depth = dp * PROFILE_DEPTH_M - mix(wispErosion, lobeErosion, detailType);
  // Ragged base: the condensation level wavers over the noise.
  depth -= cumulus * max(0.0, BASE_FRAY_M * (0.9 - lobes.y) - y);
  if (depth <= 0.0) { return vec3<f32>(0.0, -depth * 0.5, 0.0); }
  if (detail) {
    let warp = (vec3<f32>(lobes.x, nm.r + nm.g, lobes.z) - 0.35) * FINE_WARP_M;
    let nf = textureSampleLevel(uprezTex, repeatSampler, (p + warp) / UPREZ_FINE_PERIOD, 0.0);
    let rel = saturate(depth / PROFILE_DEPTH_M);
    let billowy = mix(nf.b, nf.a, pow(rel, 0.25)) * FINE_BILLOW_DEPTH_M;
    let wispy = mix(nf.r, nf.g, rel) * PROFILE_DEPTH_M * 0.5;
    // The outer tens of metres fray into wisps even on cumulus.
    let fineType = detailType * mix(0.45, 1.0, saturate(depth / 90.0));
    depth -= mix(wispy, billowy, fineType) * cloudDetailWeight;
    if (depth <= 0.0) { return vec3<f32>(0.0, -depth * 0.5, 0.0); }
  }
  return vec3<f32>(pow(saturate(depth / DENSITY_RAMP_M), SHARPEN), 0.0, depth);
}

fn cloudDensity(x: f32, z: f32, hf: f32, detail: bool) -> f32 {
  let dp = dimensionalProfile(x, z, hf);
  if (dp <= 0.0) { return 0.0; }
  return cloudSample(weatherAt(x, z), dp, x, z, hf, detail).x;
}
`;

/**
 * Baked lighting (${LIGHT_VOLUME_SIZE.join('×')} over the cloud domain, ≈ 40 m):
 * the clouds are static, so everything the march would gather along long
 * paths is marched once here, finer and in more directions than a frame
 * could afford — the depth towards the sun (geometric steps from 15 m, then
 * 250 m, to the layer's edge: its top, or its base once the sun has set),
 * the visible share of the sky (12 cosine-weighted directions) and of the
 * ground (6), through the field without its fine erosion; and the densest
 * profile over the voxel's footprint in the model (empty-space skipping).
 */
export const LIGHT_VOLUME_SHADER = /* wgsl */ `
${WGSL_PHOTO_STRUCT}
${WGSL_PHOTO_HELPERS}
${WGSL_SLICE_PARAMS}
@group(0) @binding(0) var<uniform> photo: Photo;
@group(0) @binding(1) var<uniform> slice: SliceParams;
@group(0) @binding(2) var weatherTex: texture_2d<f32>;
@group(0) @binding(3) var modelTex: texture_3d<f32>;
@group(0) @binding(4) var uprezTex: texture_3d<f32>;
@group(0) @binding(5) var repeatSampler: sampler;
@group(0) @binding(6) var linearClamp: sampler;
@group(0) @binding(7) var outTex: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(8) var lobeTex: texture_3d<f32>;
${WGSL_CLOUD_DOMAIN}
${WGSL_CLOUD_DENSITY}

const SUN_DEPTH_SCALE: f32 = 40.0;
const SKY_DIRECTIONS: i32 = 12;
const GROUND_DIRECTIONS: i32 = 6;

/** Share of the ambient light through an optical depth: the multiple-scattering octaves (0.7^i energy, 0.45^i depth). */
fn ambientShare(tau: f32) -> f32 {
  return (exp(-tau) + 0.7 * exp(-0.45 * tau) + 0.49 * exp(-0.2025 * tau) + 0.343 * exp(-0.0911 * tau)) / 2.533;
}

/** Depth (density·m) along a direction from a point of the layer: samples at 25 m × 2.3^k, to ≈ 3.7 km. */
fn bakedDepth(x: f32, z: f32, hf: f32, dir: vec3<f32>, thickness: f32) -> f32 {
  var tau = 0.0;
  var s0 = 0.0;
  for (var k = 0; k < 7; k++) {
    let s1 = 25.0 * pow(2.3, f32(k));
    let mid = 0.5 * (s0 + s1);
    let h = hf + dir.y * mid / thickness;
    if (h <= 0.0 || h >= 1.0) { break; }
    tau += cloudDensity(x + dir.x * mid, z + dir.z * mid, h, false) * (s1 - s0);
    s0 = s1;
  }
  return tau;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid0: vec3<u32>) {
  let gid = vec3<u32>(gid0.xy, gid0.z + slice.zStart);
  let size = textureDimensions(outTex);
  if (gid.x >= size.x || gid.y >= size.y || gid.z >= size.z) { return; }
  let domainHalf = photo.cloudParams.z;
  let voxel = 2.0 * domainHalf / f32(size.x);
  let thickness = photo.cloudLayer.y - photo.cloudLayer.x;
  let x = -domainHalf + (f32(gid.x) + 0.5) * voxel;
  let z = -domainHalf + (f32(gid.y) + 0.5) * voxel;
  let hf = (f32(gid.z) + 0.5) / f32(size.z);

  let modelSize = vec3<i32>(textureDimensions(modelTex));
  let ratio = max(modelSize / vec3<i32>(size), vec3<i32>(1));
  let lo = vec3<i32>(gid) * ratio - vec3<i32>(1);
  let hi = vec3<i32>(gid) * ratio + ratio;
  var maxProfile = 0.0;
  for (var k = lo.z; k <= hi.z; k++) {
    for (var j = lo.y; j <= hi.y; j++) {
      for (var i = lo.x; i <= hi.x; i++) {
        let c = clamp(vec3<i32>(i, j, k), vec3<i32>(0), modelSize - 1);
        maxProfile = max(maxProfile, textureLoad(modelTex, c, 0).r);
      }
    }
  }

  // Towards the sun: fine first (the lobes' shadows on each other), then 250 m steps.
  let L = normalize(photo.sunDir.xyz);
  let ly = select(-max(-L.y, 0.035), max(L.y, 0.035), L.y >= 0.0);
  let toEdge = select(hf, 1.0 - hf, L.y >= 0.0) * thickness / abs(ly);
  let pathLen = min(toEdge, domainExit(vec2<f32>(x, z), L.xz));
  var tauSun = 0.0;
  var s0 = 0.0;
  var stepLen = 15.0;
  for (var i = 0; i < 96; i++) {
    if (s0 >= pathLen) { break; }
    let s1 = min(s0 + stepLen, pathLen);
    let mid = 0.5 * (s0 + s1);
    tauSun += cloudDensity(x + L.x * mid, z + L.z * mid, hf + ly * mid / thickness, false) * (s1 - s0);
    s0 = s1;
    stepLen = min(stepLen * 2.0, 250.0);
  }

  // Sky and ground: only around the clouds (elsewhere nothing reads them).
  var sky = 1.0;
  var ground = 1.0;
  if (maxProfile > 0.0) {
    let extinction = photo.cloudParams.x;
    let spin = fract(f32((gid.x * 7u + gid.y * 13u + gid.z * 29u) % 64u) * 0.618034) * 6.2831853;
    var skySum = 0.0;
    for (var d = 0; d < SKY_DIRECTIONS; d++) {
      let u = (f32(d) + 0.5) / f32(SKY_DIRECTIONS);
      let r = sqrt(u);
      let a = f32(d) * 2.39996323 + spin;
      let dir = vec3<f32>(r * cos(a), sqrt(1.0 - u), r * sin(a));
      skySum += ambientShare(bakedDepth(x, z, hf, dir, thickness) * extinction);
    }
    sky = skySum / f32(SKY_DIRECTIONS);
    var groundSum = 0.0;
    for (var d = 0; d < GROUND_DIRECTIONS; d++) {
      let u = (f32(d) + 0.5) / f32(GROUND_DIRECTIONS);
      let r = sqrt(u);
      let a = f32(d) * 2.39996323 + spin;
      let dir = vec3<f32>(r * cos(a), -sqrt(1.0 - u), r * sin(a));
      groundSum += ambientShare(bakedDepth(x, z, hf, dir, thickness) * extinction);
    }
    ground = groundSum / f32(GROUND_DIRECTIONS);
  }
  textureStore(outTex, vec3<i32>(gid), vec4<f32>(1.0 - exp(-tauSun / SUN_DEPTH_SCALE), sky, maxProfile, ground));
}
`;

/**
 * Ground shadow of the clouds (${CLOUD_SHADOW_SIZE}² around the scene,
 * on the base plane): every texel marches the detailed field up through the
 * layer along the sun. R = direct transmission, G = total transmission
 * (direct + diffuse through the cloud), B = optical depth.
 */
export const CLOUD_SHADOW_SHADER = /* wgsl */ `
${WGSL_PHOTO_STRUCT}
${WGSL_PHOTO_HELPERS}
${WGSL_SLICE_PARAMS}
@group(0) @binding(0) var<uniform> photo: Photo;
@group(0) @binding(1) var<uniform> slice: SliceParams;
@group(0) @binding(2) var weatherTex: texture_2d<f32>;
@group(0) @binding(3) var modelTex: texture_3d<f32>;
@group(0) @binding(4) var uprezTex: texture_3d<f32>;
@group(0) @binding(5) var repeatSampler: sampler;
@group(0) @binding(6) var linearClamp: sampler;
@group(0) @binding(7) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var lobeTex: texture_3d<f32>;
${WGSL_CLOUD_DOMAIN}
${WGSL_CLOUD_DENSITY}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid0: vec3<u32>) {
  let gid = vec2<u32>(gid0.x, gid0.y + slice.zStart);
  let size = textureDimensions(outTex);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let uv = (vec2<f32>(gid) + 0.5) / vec2<f32>(size);
  let q = photo.cloudShadow.xy + (uv * 2.0 - 1.0) * photo.cloudShadow.z;
  let L = normalize(photo.sunDir.xyz);
  let ly = max(L.y, 0.035);
  let thickness = photo.cloudLayer.y - photo.cloudLayer.x;
  let pathLen = min(thickness / ly, domainExit(q, L.xz));
  let steps = clamp(i32(ceil(pathLen / 120.0)), 16, 224);
  let dt = pathLen / f32(steps);
  var tau = 0.0;
  for (var i = 0; i < steps; i++) {
    let s = (f32(i) + 0.5) * dt;
    tau += cloudDensity(q.x + L.x * s, q.y + L.z * s, ly * s / thickness, true) * dt;
  }
  let opticalDepth = tau * photo.cloudParams.x;
  let tr = cloudTransmissions(opticalDepth);
  textureStore(outTex, vec2<i32>(gid), vec4<f32>(tr.x, tr.y, opticalDepth, 1.0));
}
`;

/** Order in which the pixels of a block are traced by the still accumulation (1, 2 or 4 per block). */
const WGSL_CLOUD_STILL_PATTERN = /* wgsl */ `
fn stillPhase(p: vec2<u32>, k: u32) -> u32 {
  if (k <= 1u) { return 0u; }
  if (k == 2u) { return (p.x + p.y) & 1u; }
  // 2×2 block: (0,0), then the diagonal (1,1), then (1,0), (0,1).
  var order = array<u32, 4>(0u, 2u, 3u, 1u);
  return order[(p.x & 1u) + 2u * (p.y & 1u)];
}

/** Pixel of a block traced first (shown before the others have their first sample). */
fn stillFirstPixel(p: vec2<u32>, k: u32) -> vec2<u32> {
  if (k <= 1u) { return p; }
  if (k == 2u) { return select(vec2<u32>(p.x ^ 1u, p.y), p, ((p.x + p.y) & 1u) == 0u); }
  return p & vec2<u32>(~1u);
}

/** Pixel traced by thread \`g\` of a still pass (phase \`phase\` of \`k\`). */
fn stillPixel(g: vec2<u32>, k: u32, phase: u32) -> vec2<u32> {
  if (k <= 1u) { return g; }
  if (k == 2u) { return vec2<u32>(g.x * 2u + ((g.y + phase) & 1u), g.y); }
  var offsets = array<vec2<u32>, 4>(vec2<u32>(0u, 0u), vec2<u32>(1u, 1u), vec2<u32>(1u, 0u), vec2<u32>(0u, 1u));
  return g * 2u + offsets[phase];
}

/** Texel of the traced buffer holding pixel \`p\` (for the pixels of the current phase). */
fn stillTexel(p: vec2<u32>, k: u32) -> vec2<u32> {
  if (k <= 1u) { return p; }
  if (k == 2u) { return vec2<u32>(p.x / 2u, p.y); }
  return p / 2u;
}
`;

/** The ray march, shared by the half-resolution (moving) and full-resolution (still) passes. */
const WGSL_CLOUD_TRACE = /* wgsl */ `
const NO_CLOUD_DIST: f32 = 1.0e7;
/** First detailed sample towards the sun (m); the next ones double. */
const SUN_FIRST_STEP_M: f32 = 8.0;
/**
 * Multiple scattering: Wrenninge's octaves (energy a^i, optical depth b^i,
 * anisotropy c^i) for the first orders, then the higher orders as an
 * isotropic diffusion term: mostly a fast decay with the optical depth to
 * the sun, plus a share of the two-stream tail 1 / (1 + ¾(1 − g)τ) that
 * keeps the shaded side of a thick cloud from going black. Its weight sets
 * the radiance of a sunlit face near a thick cloud's reflectance
 * (≈ 0.8 E μ₀ / π): with the octaves alone a cumulus came out mid-grey;
 * with the two-stream tail alone the shaded masses stayed light grey
 * (no contrast between the lit turrets and the body of a tower).
 */
const MS_OCTAVES: i32 = 4;
const MS_A: f32 = 0.7;
const MS_B: f32 = 0.45;
const MS_C: f32 = 0.5;
const MS_DIFFUSION: f32 = 2.5;
const MS_DIFFUSION_DECAY: f32 = 0.12;
const MS_DIFFUSION_TAIL: f32 = 0.3;
/**
 * The diffusion term also fades with the optical depth of the near field
 * (the detailed samples, ≲ 0.5 km): a lobe in the shadow of its neighbour
 * gets less of the light diffusing from the sunlit faces than the faces
 * themselves — without it the shaded lobes were only 1.7× darker and the
 * cauliflower read flat.
 */
const MS_LOCAL_DECAY: f32 = 0.07;
/**
 * Nubis³'s in-scattering probability ("dark edges"): within this depth (m)
 * under the eroded surface, a point gathers multiple-scattered light from
 * fewer directions — every lobe gets a darker rim.
 */
const IN_SCATTER_DEPTH_M: f32 = 70.0;
/** Lighting is reused along the ray within this distance (m; at least two pixel footprints, longer behind an already opaque skin: ÷ transmittance). */
const LIGHT_REUSE_M: f32 = 3.0;
/** Share of the sky and ground light reaching the clouds' surface (their own shadow on the sky dome around them). */
const AMBIENT_SCALE: f32 = 0.75;
/** First sample of the sky / ground light paths (m); the next ones grow ×3 (20 m → ~0.5–1.6 km). */
const AMBIENT_FIRST_STEP_M: f32 = 20.0;
const AMBIENT_GROWTH: f32 = 3.0;

struct TraceSettings {
  maxSteps: i32,
  /** Optical depth aimed at per step inside a cloud. */
  tauStep: f32,
  /** Angle of a pixel (rad): the steps never go far below its footprint. */
  pixelAngle: f32,
  /** Detailed samples towards the sun. */
  sunSamples: i32,
  /** Scale of the steps outside the clouds. */
  coarseScale: f32,
  /** Samples of the sky / ground light paths through the model. */
  skySamples: i32,
  groundSamples: i32,
  /** Random sky / ground directions (one per accumulated sample) instead of the vertical. */
  stochasticAmbient: bool,
};

/** Cosine-weighted direction around +y (up = 1) or −y (up = −1) from two uniforms. */
fn hemisphereDir(u: vec2<f32>, up: f32) -> vec3<f32> {
  let r = sqrt(u.x);
  let phi = 2.0 * PI * u.y;
  return vec3<f32>(r * cos(phi), up * sqrt(max(0.0, 1.0 - u.x)), r * sin(phi));
}

/**
 * Optical depth (density·m, field without its fine erosion) from a point of
 * the layer along \`dir\`, on a geometric series of samples: the turrets
 * around a point shade it from the sky (or the ground) the way they are,
 * crevices and undersides darker, the lumps facing the light brighter.
 */
fn ambientOpticalDepth(p: vec3<f32>, hf: f32, dir: vec3<f32>, samples: i32, offset: f32) -> f32 {
  let thickness = photo.cloudLayer.y - photo.cloudLayer.x;
  var tau = 0.0;
  var s0 = 0.0;
  for (var j = 0; j < samples; j++) {
    let s1 = AMBIENT_FIRST_STEP_M * pow(AMBIENT_GROWTH, f32(j) + offset);
    let mid = 0.5 * (s0 + s1);
    let h = hf + dir.y * mid / thickness;
    if (h <= 0.0 || h >= 1.0) { break; }
    tau += cloudDensity(p.x + dir.x * mid, p.z + dir.z * mid, h, false) * (s1 - s0);
    s0 = s1;
  }
  return tau;
}

/**
 * Share of the ambient light reaching a point through an optical depth τ:
 * the same octaves as the sun's multiple scattering (light that scattered on
 * its way in still arrives, from a shallower effective depth).
 */
fn ambientTransmission(tau: f32) -> f32 {
  var sum = 0.0;
  var energy = 1.0;
  var depthScale = 1.0;
  var norm = 0.0;
  for (var o = 0; o < MS_OCTAVES; o++) {
    sum += energy * exp(-depthScale * tau);
    norm += energy;
    energy *= MS_A;
    depthScale *= MS_B;
  }
  return sum / norm;
}

struct CloudTrace {
  radiance: vec3<f32>,
  transmittance: f32,
  /** Mean distance of what the ray met (weighted by opacity), NO_CLOUD_DIST when clear. */
  dist: f32,
};

fn hgPhase(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  let d = 1.0 + g2 - 2.0 * g * c;
  return (1.0 - g2) / (4.0 * PI * d * sqrt(d));
}

fn drainePhase(c: f32, g: f32, alpha: f32) -> f32 {
  let g2 = g * g;
  return hgPhase(c, g) * (1.0 + alpha * c * c) / (1.0 + alpha * (1.0 + 2.0 * g2) / 3.0);
}

/** Approximate Mie phase with its anisotropy scaled by \`k\` (multiple-scattering octaves). */
fn cloudPhase(c: f32, k: f32) -> f32 {
  let ph = photo.phase;
  return (1.0 - ph.w) * hgPhase(c, ph.x * k) + ph.w * drainePhase(c, ph.y * k, ph.z);
}

/** Stretch of the ray in the layer and in the cloud domain (start, end); end ≤ start when it never enters. */
fn layerSegment(eye: vec3<f32>, dir: vec3<f32>, maxDist: f32) -> vec2<f32> {
  let base = photo.cloudLayer.x;
  let top = photo.cloudLayer.y;
  let a = photo.scene.x + eye.y;
  var limit = maxDist;
  let ground = raySphereAlt(eye.x, a, eye.z, dir, photo.scene.y - 30.0);
  if (ground.x > 0.0) { limit = min(limit, ground.x); }
  let alt = shellAltitude(eye, photo.scene.x);
  let topHit = raySphereAlt(eye.x, a, eye.z, dir, top);
  if (topHit.y <= 0.0) { return vec2<f32>(0.0, -1.0); }
  let baseHit = raySphereAlt(eye.x, a, eye.z, dir, base);
  var s = 0.0;
  var e = 0.0;
  if (alt > top) {
    s = topHit.x;
    e = select(topHit.y, baseHit.x, baseHit.x > 0.0);
  } else if (alt >= base) {
    s = 0.0;
    e = select(topHit.y, baseHit.x, baseHit.x > 0.0);
  } else {
    s = max(0.0, baseHit.y);
    e = topHit.y;
  }
  // The domain: a vertical cylinder around the scene centre.
  let domainHalf = photo.cloudParams.z;
  let h2 = dir.x * dir.x + dir.z * dir.z;
  let c = eye.x * eye.x + eye.z * eye.z - domainHalf * domainHalf;
  if (h2 > 1e-8) {
    let b = eye.x * dir.x + eye.z * dir.z;
    let disc = b * b - h2 * c;
    if (disc <= 0.0) { return vec2<f32>(0.0, -1.0); }
    let sq = sqrt(disc);
    s = max(s, (-b - sq) / h2);
    e = min(e, (-b + sq) / h2);
  } else if (c > 0.0) {
    return vec2<f32>(0.0, -1.0);
  }
  return vec2<f32>(max(s, 0.0), min(e, limit));
}

/**
 * Clouds along a ray up to \`maxDist\`. \`rnd\` (all in [0, 1), a new value per
 * sample of the pixel): x = start offset, y = offset of the sun and ambient
 * samples, zw = direction of the sky and ground light paths.
 */
fn traceClouds(eye: vec3<f32>, dir: vec3<f32>, maxDist: f32, rnd: vec4<f32>, settings: TraceSettings) -> CloudTrace {
  var result: CloudTrace;
  result.radiance = vec3<f32>(0.0);
  result.transmittance = 1.0;
  result.dist = NO_CLOUD_DIST;
  if (photo.atmosphere.w < 0.5) { return result; }
  var segment = layerSegment(eye, dir, maxDist);
  if (photo.cloudLayer.z <= 0.0) { segment = vec2<f32>(0.0, -1.0); }
  let low = traceLowLayer(eye, dir, segment, rnd, settings);
  // The sub-layers: front to back with the volumetric layer, by distance;
  // nothing to trace behind an opaque cloud.
  let highLimit = select(maxDist, min(maxDist, low.dist), low.transmittance < 0.02);
  var high = traceHighLayer(eye, dir, highLimit, photo.highClouds0, 0.0, rnd, settings);
  let high1 = traceHighLayer(eye, dir, highLimit, photo.highClouds1, 1.0, rnd, settings);
  high = composeTraces(high, high1);
  if (high.dist < low.dist) { return composeTraces(high, low); }
  return composeTraces(low, high);
}

/** Front trace then back trace: radiance, transmittance and opacity-weighted distance. */
fn composeTraces(front: CloudTrace, back: CloudTrace) -> CloudTrace {
  var r: CloudTrace;
  r.radiance = front.radiance + front.transmittance * back.radiance;
  r.transmittance = front.transmittance * back.transmittance;
  let wf = 1.0 - front.transmittance;
  let wb = front.transmittance * (1.0 - back.transmittance);
  r.dist = NO_CLOUD_DIST;
  if (wf + wb > 1e-4) {
    let df = select(0.0, front.dist, front.dist < NO_CLOUD_DIST * 0.5);
    let db = select(0.0, back.dist, back.dist < NO_CLOUD_DIST * 0.5);
    r.dist = (df * wf + db * wb) / (wf + wb);
  }
  return r;
}

/** The volumetric layer along a ray (its segment in the layer and the domain). */
fn traceLowLayer(eye: vec3<f32>, dir: vec3<f32>, segment: vec2<f32>, rnd: vec4<f32>, settings: TraceSettings) -> CloudTrace {
  var result: CloudTrace;
  result.radiance = vec3<f32>(0.0);
  result.transmittance = 1.0;
  result.dist = NO_CLOUD_DIST;
  if (segment.y <= segment.x) { return result; }

  let L = normalize(photo.sunDir.xyz);
  let cosTheta = dot(dir, L);
  var octavePhase: array<f32, MS_OCTAVES>;
  var c = 1.0;
  for (var o = 0; o < MS_OCTAVES; o++) {
    octavePhase[o] = cloudPhase(cosTheta, c);
    c *= MS_C;
  }
  let extinction = photo.cloudParams.x;
  let scatterAlbedo = 1.0 - photo.cloudParams.y;
  let base = photo.cloudLayer.x;
  let thickness = photo.cloudLayer.y - base;
  let voxel = 2.0 * photo.cloudParams.z / ${LIGHT_VOLUME_SIZE[0]}.0;
  let skyAmbient = lighting.skyUp.rgb / PI;
  let groundAmbient = (lighting.groundUp.rgb + 0.15 * lighting.skyUp.rgb) / PI;
  // Toward the sun the thin edges glow (forward peak): the in-scattering
  // probability darkens them less there.
  let powderAmount = mix(0.35, 1.0, saturate(0.5 - 0.5 * cosTheta));

  var t = segment.x + rnd.x * clamp(segment.x * 0.012, 20.0, 150.0) * settings.coarseScale;
  var T = 1.0;
  var radiance = vec3<f32>(0.0);
  var depthSum = 0.0;
  var depthWeight = 0.0;
  var fine = false;
  var fineUntil = -1.0;
  // Light at the last lit sample: sun (multiplies sunE) and ambient radiance, reused nearby.
  var lightT = -1.0e9;
  var sunCached = vec3<f32>(0.0);
  var ambientCached = vec3<f32>(0.0);
  for (var i = 0; i < settings.maxSteps; i++) {
    if (t >= segment.y || T < 0.003) { break; }
    let p = eye + dir * t;
    let hf = (shellAltitude(p, photo.scene.x) - base) / thickness;
    let footprint = max(0.6, t * settings.pixelAngle);
    let coarse = clamp(t * 0.012, 20.0, 150.0) * settings.coarseScale;
    let walking = t < fineUntil;
    let lv = lightVolumeAt(p.x, p.z, hf);
    if (lv.b <= 0.0 && !walking) {
      fine = false;
      t += max(coarse, voxel * 0.6);
      continue;
    }
    let dp = dimensionalProfile(p.x, p.z, hf);
    let emptyStep = clamp(3.0 * footprint, 1.0, 40.0);
    if (dp <= 0.0) {
      if (walking) {
        t += emptyStep;
      } else {
        fine = false;
        t += coarse;
      }
      continue;
    }
    if (!fine) {
      // Into the model: back one coarse step, walked again in fine steps.
      fine = true;
      fineUntil = t;
      t = max(segment.x, t - coarse);
      continue;
    }
    cloudDetailWeight = saturate(1.5 - t / 16000.0);
    let w = weatherAt(p.x, p.z);
    let cs = cloudSample(w, dp, p.x, p.z, hf, true);
    if (cs.x <= 0.0) {
      t += clamp(cs.y, emptyStep * 0.5, 40.0);
      continue;
    }
    let density = cs.x;
    let sigmaT = density * extinction;
    let step = clamp(settings.tauStep / sigmaT, footprint, emptyStep);

    if (abs(t - lightT) > max(LIGHT_REUSE_M / max(T, 0.2), 2.0 * footprint)) {
      lightT = t;
      // Sun: detailed near field, then the light volume for the rest of the way.
      // The fine erosion's own shadows (the baked volume is ≈ 40 m), then the baked rest of the way.
      var tauNear = 0.0;
      var s0 = 0.0;
      for (var j = 0; j < settings.sunSamples; j++) {
        let s1 = SUN_FIRST_STEP_M * pow(3.0, f32(j)) * (0.75 + 0.5 * rnd.y);
        let mid = 0.5 * (s0 + s1);
        tauNear += cloudDensity(p.x + L.x * mid, p.z + L.z * mid, hf + L.y * mid / thickness, true) * (s1 - s0);
        s0 = s1;
      }
      let tauSun = (tauNear + sunDepthAt(p.x + L.x * s0, p.z + L.z * s0, hf + L.y * s0 / thickness)) * extinction;
      var sunScatter = octavePhase[0] * exp(-tauSun);
      var multiple = 0.0;
      var energy = MS_A;
      var depthScale = MS_B;
      for (var o = 1; o < MS_OCTAVES; o++) {
        multiple += energy * octavePhase[o] * exp(-depthScale * tauSun);
        energy *= MS_A;
        depthScale *= MS_B;
      }
      let diffusion = mix(exp(-MS_DIFFUSION_DECAY * tauSun), cloudTransmissions(tauSun).y, MS_DIFFUSION_TAIL);
      multiple += MS_DIFFUSION / (4.0 * PI) * diffusion * exp(-MS_LOCAL_DECAY * min(tauSun, 40.0));
      // Nubis³'s in-scattering probability: deep inside, light arrives from
      // every side; near the eroded surface and the base, less (dark rims
      // on every lobe, darker crevices and base). Only on the multiple
      // scattering; toward the sun the thin edges glow instead.
      let depthProbability = 0.25 + 0.75 * pow(saturate(cs.z / IN_SCATTER_DEPTH_M), 0.6);
      let verticalProbability = pow(saturate(remap(hf * thickness, 30.0, 300.0, 0.3, 1.0)), 0.8);
      let inScatter = mix(1.0, saturate(depthProbability * verticalProbability), 0.8 * powderAmount);
      // The sun as seen from this point: reddened along its own path through
      // the air, gone when the planet hides it — tops still glow after the
      // sun set on the ground.
      let sunE = sunTransmittance(transmittanceLut, linearClamp, atmospherePos(p, photo.scene.x), L) * photo.sunDir.w;
      sunCached = sunE * (sunScatter + multiple * inScatter);
      // Sky from above and ground light from below, through the model: the
      // near ~1 km marched, the rest of the way up from the light volume
      // (towers above).
      // Sky and ground light: their visible share, baked.
      ambientCached = (skyAmbient * lv.y + groundAmbient * lv.w) * AMBIENT_SCALE;
    }
    let sunScatter = sunCached;
    let ambient = ambientCached;

    let sigmaS = sigmaT * scatterAlbedo;
    let S = sigmaS * (sunScatter + ambient);
    let stepT = exp(-sigmaT * step);
    radiance += T * (S - S * stepT) / sigmaT;
    let absorbed = T * (1.0 - stepT);
    depthSum += t * absorbed;
    depthWeight += absorbed;
    T *= stepT;
    t += step;
  }
  result.radiance = radiance;
  result.transmittance = T;
  if (depthWeight > 1e-4) { result.dist = depthSum / depthWeight; }
  return result;
}

/** Wind of the sub-layers (x/z, unit): cirrus fibres and rows of altocumulus line up with it. */
const HIGH_WIND: vec2<f32> = vec2<f32>(0.8, 0.6);
/**
 * Extinction (1/m) at full density: cirrus are sparse ice (optical depth
 * ≈ 0.3–2 through the sheet), altocumulus thin droplet sheets.
 */
const CIRRUS_EXTINCTION: f32 = 0.004;
const ALTO_EXTINCTION: f32 = 0.03;
/** Farthest sub-layer cloud traced (m): the aerial perspective has swallowed them beyond. */
const HIGH_MAX_DIST_M: f32 = 70000.0;
/** The sub-layers gather over the scene: full within this radius of its centre, gone by HIGH_END_M. */
const HIGH_FULL_M: f32 = 25000.0;
const HIGH_END_M: f32 = 55000.0;

/**
 * Cover of a sub-layer at a point: its patches (precomputed,
 * \`HIGH_COVER_SHADER\`) stretched then thresholded at the layer's cover —
 * sheets with real clear sky between them, about that share of the sky
 * covered, instead of a veil everywhere.
 */
fn highCover(xz: vec2<f32>, layer: vec4<f32>, index: f32) -> f32 {
  let raw = textureSampleLevel(highCoverTex, linearClamp, xz / (2.0 * ${HIGH_COVER_HALF_M}.0) + 0.5, 0.0);
  let patches = saturate((select(raw.r, raw.g, index > 0.5) - 0.5) * 2.6 + 0.5);
  let threshold = 1.0 - layer.z;
  return smoothstep(threshold - 0.12, threshold + 0.12, patches);
}

/**
 * Density of a sub-layer (Nubis Evolved's 2.5-D model): a cover from the
 * patches, a type blending streaks (cirrus fibres: Nubis³'s billow cracks
 * stretched ×14 along the wind), wisps (its curly wisps) and round cells
 * (Alligator domes in rows across the wind), then Nubis' remap — the cover
 * sharpens or thins the noise — and a rounded vertical profile in the sheet.
 */
fn highDensity(p: vec3<f32>, h: f32, layer: vec4<f32>, index: f32) -> f32 {
  let cov = highCover(p.xz, layer, index) * (1.0 - smoothstep(HIGH_FULL_M, HIGH_END_M, length(p.xz)));
  if (cov <= 0.02) { return 0.0; }
  let along = dot(p.xz, HIGH_WIND);
  let across = HIGH_WIND.x * p.z - HIGH_WIND.y * p.x;
  let y = h * layer.y;
  let shift = index * 0.37;
  let warpN = textureSampleLevel(lobeTex, repeatSampler, vec3<f32>(along / 21000.0, shift + y / 3000.0, across / 13000.0), 0.0);
  let wa = (warpN.x - 0.4) * 3000.0;
  let wc = (warpN.y - 0.4) * 1800.0;
  let fib = textureSampleLevel(uprezTex, repeatSampler, vec3<f32>((along + wa) / 5200.0, shift + y / 800.0, (across + wc) / 380.0), 0.0);
  let streaky = saturate(fib.b * 1.25 + fib.a * 0.5 - 0.2);
  let wn = textureSampleLevel(uprezTex, repeatSampler, vec3<f32>((along + wa) / 4200.0, shift + y / 900.0, (across + wc) / 2600.0), 0.0);
  let wispy = saturate(wn.r * 1.8 + wn.g * 1.2 + 0.1);
  let ln = textureSampleLevel(lobeTex, repeatSampler, vec3<f32>((along + wa * 0.3) / 1500.0, shift + y / 700.0, (across + wc * 0.3) / 2100.0), 0.0);
  let cells = saturate((ln.z * 0.55 + ln.w * 0.45) * 1.7 - 0.12);
  let typ = layer.w;
  var d = select(mix(streaky, wispy, saturate(typ * 2.0)), mix(wispy, cells, saturate(typ * 2.0 - 1.0)), typ > 0.5);
  // Thin towards the patches' edges: only the densest cells / fibres remain.
  d = saturate((d - (1.0 - cov) * 0.7) / max(0.3 + 0.7 * cov, 1e-3));
  // Rounded in the sheet: cells get domes, fibres thin out at the edges.
  let v = saturate(4.0 * h * (1.0 - h));
  return saturate(d - (1.0 - v) * mix(0.45, 0.85, saturate(typ * 2.0 - 1.0)));
}

/** One sub-layer along a ray: a few stochastic samples through the sheet, lit by the sun's own reddened light. */
fn traceHighLayer(eye: vec3<f32>, dir: vec3<f32>, maxDist: f32, layer: vec4<f32>, index: f32, rnd: vec4<f32>, settings: TraceSettings) -> CloudTrace {
  var r: CloudTrace;
  r.radiance = vec3<f32>(0.0);
  r.transmittance = 1.0;
  r.dist = NO_CLOUD_DIST;
  if (layer.z <= 0.0) { return r; }
  let base = layer.x;
  let top = layer.x + layer.y;
  let a = photo.scene.x + eye.y;
  let alt = shellAltitude(eye, photo.scene.x);
  let topHit = raySphereAlt(eye.x, a, eye.z, dir, top);
  let baseHit = raySphereAlt(eye.x, a, eye.z, dir, base);
  var s = 0.0;
  var e = 0.0;
  if (alt < base) {
    s = baseHit.y;
    e = topHit.y;
  } else if (alt <= top) {
    e = select(topHit.y, baseHit.x, baseHit.x > 0.0);
  } else {
    if (topHit.x <= 0.0) { return r; }
    s = topHit.x;
    e = select(topHit.y, baseHit.x, baseHit.x > 0.0);
  }
  e = min(e, min(maxDist, HIGH_MAX_DIST_M));
  if (e <= s || s < 0.0) { return r; }
  let ground = raySphereAlt(eye.x, a, eye.z, dir, photo.scene.y - 30.0);
  if (ground.x > 0.0 && ground.x < s) { return r; }

  let steps = select(6, 12, settings.stochasticAmbient);
  let dt = (e - s) / f32(steps);
  let droplets = smoothstep(0.4, 0.8, layer.w);
  let extinction = mix(CIRRUS_EXTINCTION, ALTO_EXTINCTION, droplets);
  let L = normalize(photo.sunDir.xyz);
  let cosTheta = dot(dir, L);
  // Ice crystals scatter less sharply forward than droplets.
  let phaseSun = mix(hgPhase(cosTheta, 0.75), cloudPhase(cosTheta, 1.0), droplets);
  let phaseMs = mix(hgPhase(cosTheta, 0.4), cloudPhase(cosTheta, 0.5), droplets);
  let skyAmbient = lighting.skyUp.rgb / PI;
  let groundAmbient = (lighting.groundUp.rgb + 0.15 * lighting.skyUp.rgb) / PI;
  let ambient = (skyAmbient * 0.9 + groundAmbient * 0.5) * AMBIENT_SCALE;
  let toEdgeScale = layer.y / max(abs(L.y), 0.05);
  var T = 1.0;
  var radiance = vec3<f32>(0.0);
  var depthSum = 0.0;
  var depthWeight = 0.0;
  for (var i = 0; i < steps; i++) {
    let t = s + (f32(i) + rnd.x) * dt;
    let p = eye + dir * t;
    let h = (shellAltitude(p, photo.scene.x) - base) / layer.y;
    if (h <= 0.0 || h >= 1.0) { continue; }
    let d = highDensity(p, h, layer, index);
    if (d <= 0.002) { continue; }
    let sigmaT = d * extinction;
    // Towards the sun: the cell's own shadow (two jittered samples, 40 m
    // then 200 m), not the whole way to the sheet's edge — a grazing sun
    // crosses kilometres of the sheet, mostly through the gaps between cells.
    let reach = select(h, 1.0 - h, L.y >= 0.0) * toEdgeScale;
    var tau = 0.0;
    var s0 = 0.0;
    for (var k = 0; k < 2; k++) {
      let s1 = min(reach, select(40.0, 200.0, k == 1) * (0.7 + 0.6 * rnd.y));
      let mid = 0.5 * (s0 + s1);
      let hq = h + L.y * mid / layer.y;
      if (hq > 0.0 && hq < 1.0) { tau += highDensity(p + L * mid, hq, layer, index) * (s1 - s0); }
      s0 = s1;
    }
    tau *= extinction;
    let sunE = sunTransmittance(transmittanceLut, linearClamp, atmospherePos(p, photo.scene.x), L) * photo.sunDir.w;
    // Multiple scattering grows with the sheet's optical depth (thin cirrus: mostly single).
    let thickness = saturate(d * extinction * layer.y * 0.5);
    let ms = (0.7 * phaseMs * exp(-0.45 * tau) + MS_DIFFUSION / (4.0 * PI) * 0.4 * exp(-0.12 * tau)) * thickness;
    let S = sigmaT * (sunE * (phaseSun * exp(-tau) + ms) + ambient);
    let stepT = exp(-sigmaT * dt);
    radiance += T * (S - S * stepT) / sigmaT;
    let absorbed = T * (1.0 - stepT);
    depthSum += t * absorbed;
    depthWeight += absorbed;
    T *= stepT;
    if (T < 0.01) { break; }
  }
  r.radiance = radiance;
  r.transmittance = T;
  if (depthWeight > 1e-4) { r.dist = depthSum / depthWeight; }
  return r;
}

/** Angle covered by one pixel of a buffer \`rows\` pixels high around a view ray. */
fn pixelAngleAt(uv: vec2<f32>, rows: f32, dir: vec3<f32>) -> f32 {
  let other = viewRay(uv + vec2<f32>(0.0, 1.0 / rows), photo.invViewProj, photo.cameraPos.xyz);
  return length(other - dir);
}

fn sceneDistanceAt(px: vec2<i32>) -> f32 {
  let depth = textureLoad(depthTex, px, 0);
  if (depth <= 0.0) { return NO_CLOUD_DIST; }
  let size = photo.targetSize.xy;
  return distance(worldFromDepth(vec2<f32>(px) + 0.5, size, depth, photo.invDrawViewProj), photo.cameraPos.xyz);
}

fn hash2(p: vec2<u32>, seed: u32) -> vec2<f32> {
  let h = pcg3d(vec3<u32>(p, seed));
  return vec2<f32>(f32(h.x), f32(h.y)) * (1.0 / 4294967296.0);
}
`;

/**
 * Ray march compute passes: \`march_half\` traces one pixel of each 2×2
 * block of the half-resolution buffer (or all of them) while the view moves;
 * \`march_still\` traces the pixels of this frame's phase at full resolution
 * into a compact buffer that \`CLOUD_ACCUMULATE_SHADER\` averages in place.
 */
export const CLOUD_MARCH_SHADER = /* wgsl */ `
${WGSL_PHOTO_STRUCT}
${WGSL_PHOTO_HELPERS}
${WGSL_ATMOSPHERE}
${WGSL_ATMOSPHERE_LOOKUPS}
${WGSL_PHOTO_LIGHTING_STRUCT}
${WGSL_NOISE}
@group(0) @binding(0) var<uniform> photo: Photo;
@group(0) @binding(1) var<storage, read> lighting: PhotoLighting;
@group(0) @binding(2) var weatherTex: texture_2d<f32>;
@group(0) @binding(3) var modelTex: texture_3d<f32>;
@group(0) @binding(4) var uprezTex: texture_3d<f32>;
@group(0) @binding(5) var lightVolume: texture_3d<f32>;
@group(0) @binding(6) var repeatSampler: sampler;
@group(0) @binding(7) var depthTex: texture_depth_2d;
@group(0) @binding(8) var outColor: texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var outDepth: texture_storage_2d<rg32float, write>;
@group(0) @binding(10) var linearClamp: sampler;
@group(0) @binding(11) var lobeTex: texture_3d<f32>;
@group(0) @binding(12) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(13) var highCoverTex: texture_2d<f32>;
${WGSL_CLOUD_DOMAIN}
${WGSL_LIGHT_VOLUME_LOOKUP}
${WGSL_CLOUD_DENSITY}
${WGSL_CLOUD_TRACE}
${WGSL_CLOUD_STILL_PATTERN}

@compute @workgroup_size(8, 8)
fn march_half(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = vec2<u32>(photo.cloudSize.xy);
  var pix = gid.xy;
  if (photo.cloudSize.z < 0.5) {
    let index = u32(photo.cloudSize.w);
    let offset = vec2<u32>(index & 1u, (index >> 1u) ^ (index & 1u));
    pix = gid.xy * 2u + offset;
  }
  if (pix.x >= size.x || pix.y >= size.y) { return; }
  let fpix = vec2<f32>(pix);
  let frameIndex = photo.frame.x;
  let uv = (fpix + 0.5) / vec2<f32>(size);
  let eye = photo.cameraPos.xyz;
  let dir = viewRay(uv, photo.invViewProj, eye);
  let tsize = photo.targetSize.xy;
  let sceneDist = sceneDistanceAt(vec2<i32>(clamp(uv * tsize, vec2<f32>(0.0), tsize - 1.0)));
  var settings: TraceSettings;
  settings.maxSteps = i32(photo.dsmInfo.w);
  settings.tauStep = 0.9;
  settings.pixelAngle = pixelAngleAt(uv, f32(size.y), dir) * 2.0;
  settings.sunSamples = 1;
  settings.coarseScale = photo.quality.x;
  settings.skySamples = 2;
  settings.groundSamples = 2;
  settings.stochasticAmbient = false;
  let rnd = vec4<f32>(
    fract(ign(fpix + vec2<f32>(frameIndex * 5.588238, frameIndex * 3.17))),
    fract(ign(fpix.yx + vec2<f32>(19.0, 7.0)) + frameIndex * 0.618034),
    0.0,
    0.0,
  );
  let r = traceClouds(eye, dir, sceneDist, rnd, settings);
  textureStore(outColor, vec2<i32>(pix), vec4<f32>(r.radiance, r.transmittance));
  textureStore(outDepth, vec2<i32>(pix), vec4<f32>(r.dist, sceneDist, 0.0, 0.0));
}

@compute @workgroup_size(8, 8)
fn march_still(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = u32(photo.cloudStill.x);
  let phase = u32(photo.cloudStill.y) % k;
  let pix = stillPixel(gid.xy, k, phase);
  let size = photo.targetSize.xy;
  if (f32(pix.x) >= size.x || f32(pix.y) >= size.y) { return; }
  let fpix = vec2<f32>(pix);
  let m = photo.cloudStill.w;
  // Per-pixel scrambled low-discrepancy sequences over the pixel's samples:
  // R2 for the sub-pixel position, golden ratio and √2 for the march.
  let scramble = hash2(pix, 0x5bd1e995u);
  let jitter = fract(scramble + m * vec2<f32>(0.7548777, 0.5698403)) - 0.5;
  let ambientUv = fract(hash2(pix, 0x68e31da4u) + m * vec2<f32>(0.5698403, 0.7548777));
  let rnd = vec4<f32>(fract(ign(fpix) + m * 0.618034), fract(hash2(pix, 0x27d4eb2du).x + m * 0.4142136), ambientUv);
  let uv = (fpix + 0.5 + jitter) / size;
  let eye = photo.cameraPos.xyz;
  let dir = viewRay(uv, photo.invViewProj, eye);
  let sceneDist = sceneDistanceAt(vec2<i32>(pix));
  var settings: TraceSettings;
  settings.maxSteps = 384;
  settings.tauStep = 0.35;
  settings.pixelAngle = pixelAngleAt(uv, size.y, dir);
  settings.sunSamples = 2;
  settings.coarseScale = 1.0;
  settings.skySamples = 3;

  settings.groundSamples = 2;
  settings.stochasticAmbient = true;
  let r = traceClouds(eye, dir, sceneDist, rnd, settings);
  let texel = vec2<i32>(stillTexel(pix, k));
  textureStore(outColor, texel, vec4<f32>(r.radiance, r.transmittance));
  // Distance weighted by opacity: averaged over the samples, divided back by the mean opacity.
  let opacity = 1.0 - r.transmittance;
  textureStore(outDepth, texel, vec4<f32>(select(0.0, r.dist * opacity, r.dist < NO_CLOUD_DIST * 0.5), sceneDist, 0.0, 0.0));
}
`;

/**
 * Still accumulation: the pixels traced this frame are blended into the
 * full-resolution image with the weight of their sample (blend constant
 * 1 / (n + 1)), the others are left as they are.
 */
export const CLOUD_ACCUMULATE_SHADER = /* wgsl */ `
${WGSL_PHOTO_STRUCT}
${FULLSCREEN_VS}
@group(0) @binding(0) var<uniform> photo: Photo;
@group(0) @binding(1) var freshColor: texture_2d<f32>;
@group(0) @binding(2) var freshDepth: texture_2d<f32>;
${WGSL_CLOUD_STILL_PATTERN}

struct AccumulateOutput {
  @location(0) color: vec4<f32>,
  @location(1) dist: vec4<f32>,
};

@fragment
fn accumulate_fs(@builtin(position) frag: vec4<f32>) -> AccumulateOutput {
  let pix = vec2<u32>(frag.xy);
  let k = u32(photo.cloudStill.x);
  if (stillPhase(pix, k) != u32(photo.cloudStill.y) % k) { discard; }
  let texel = vec2<i32>(stillTexel(pix, k));
  var result: AccumulateOutput;
  result.color = textureLoad(freshColor, texel, 0);
  result.dist = vec4<f32>(textureLoad(freshDepth, texel, 0).r, 0.0, 0.0, 1.0);
  return result;
}
`;

/**
 * Temporal resolve of the half-resolution buffer (moving view): pixels
 * traced this frame are blended with their reprojected history (weight
 * \`cloudTemporal.x\`), the others take their reprojected history, clamped to
 * the freshly traced neighbours. The clouds are static: the history is
 * reprojected through the cloud distance alone.
 */
export const CLOUD_TEMPORAL_SHADER = /* wgsl */ `
${WGSL_PHOTO_STRUCT}
${WGSL_PHOTO_HELPERS}
@group(0) @binding(0) var<uniform> photo: Photo;
@group(0) @binding(1) var freshColor: texture_2d<f32>;
@group(0) @binding(2) var freshDepth: texture_2d<f32>;
@group(0) @binding(3) var historyColor: texture_2d<f32>;
@group(0) @binding(4) var historyDepth: texture_2d<f32>;
@group(0) @binding(5) var linearClamp: sampler;
@group(0) @binding(6) var outColor: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var outDepth: texture_storage_2d<rg32float, write>;

fn tracedOffset() -> vec2<i32> {
  let index = u32(photo.cloudSize.w);
  return vec2<i32>(i32(index & 1u), i32((index >> 1u) ^ (index & 1u)));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = vec2<i32>(photo.cloudSize.xy);
  let p = vec2<i32>(gid.xy);
  if (p.x >= size.x || p.y >= size.y) { return; }
  let fullTrace = photo.cloudSize.z > 0.5;
  let offset = tracedOffset();
  let traced = fullTrace || all((p & vec2<i32>(1)) == offset);
  let eye = photo.cameraPos.xyz;
  let uv = (vec2<f32>(p) + 0.5) / vec2<f32>(size);
  let dir = viewRay(uv, photo.invViewProj, eye);

  let fresh = textureLoad(freshColor, p, 0);
  let freshD = textureLoad(freshDepth, p, 0).rg;
  let ownHistoryD = textureLoad(historyDepth, p, 0).rg;
  var dist = select(ownHistoryD.x, freshD.x, traced);
  if (dist > 1.0e6) { dist = 30000.0; }
  let clip = photo.prevViewProj * vec4<f32>(eye + dir * dist, 1.0);
  var valid = photo.cloudTemporal.w > 0.5 && clip.w > 1e-4;
  var history = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  var historyD = ownHistoryD;
  if (valid) {
    let puv = clip.xy / clip.w * vec2<f32>(0.5, -0.5) + 0.5;
    valid = all(puv >= vec2<f32>(0.0)) && all(puv <= vec2<f32>(1.0));
    if (valid) {
      history = textureSampleLevel(historyColor, linearClamp, puv, 0.0);
      historyD = textureLoad(historyDepth, clamp(vec2<i32>(puv * vec2<f32>(size)), vec2<i32>(0), size - 1), 0).rg;
    }
  }

  var color = fresh;
  var depthOut = freshD;
  // Freshly traced pixels of the 3×3 neighbouring blocks.
  let block = (p - offset) / 2;
  var lo = vec4<f32>(1e9);
  var hi = vec4<f32>(-1e9);
  var nearest = fresh;
  var nearestD = freshD;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let q = clamp((block + vec2<i32>(i, j)) * 2 + offset, vec2<i32>(0), size - 1);
      let s = textureLoad(freshColor, q, 0);
      lo = min(lo, s);
      hi = max(hi, s);
      if (i == 0 && j == 0) {
        nearest = s;
        nearestD = textureLoad(freshDepth, q, 0).rg;
      }
    }
  }
  if (traced) {
    if (valid) { color = mix(history, fresh, photo.cloudTemporal.x); }
  } else if (valid) {
    let margin = (hi - lo) * 0.25 + vec4<f32>(0.002);
    color = clamp(history, lo - margin, hi + margin);
    depthOut = historyD;
  } else {
    color = nearest;
    depthOut = nearestD;
  }
  textureStore(outColor, p, color);
  textureStore(outDepth, p, vec4<f32>(depthOut, 0.0, 0.0));
}
`;

/** For the composite: domain lookups and the still pattern. */
export const WGSL_CLOUD_COMPOSITE_HELPERS = `${WGSL_CLOUD_DOMAIN}\n${WGSL_LIGHT_VOLUME_LOOKUP}\n${WGSL_CLOUD_STILL_PATTERN}`;
