// ============================================
// Photo mode — physically based sky (Hillaire 2020)
// ============================================
//
// "A Scalable and Production Ready Sky and Atmosphere Rendering Technique"
// (Hillaire, EGSR 2020): Rayleigh, Mie and ozone of the Earth's atmosphere
// in small look-up tables built by compute passes —
//  - transmittance (256×64): sun light through the atmosphere, once;
//  - multiple scattering (32×32): every order beyond the first, once;
//  - sky view (192×108): radiance of the sky around the camera, when the sun
//    or the camera altitude changes;
//  - aerial perspective (32³ froxels): haze between the camera and the scene,
//    each frame the camera moves.
// Plus one pass deriving the sun and sky irradiance used to light the scene
// and the clouds, and the automatic exposure. Units: km, sun illuminance 1.

import { WGSL_PHOTO_HELPERS, WGSL_PHOTO_STRUCT } from './photoCommon';

export const TRANSMITTANCE_LUT_SIZE: [number, number] = [256, 64];
export const MULTISCATTER_LUT_SIZE = 32;
export const SKY_VIEW_LUT_SIZE: [number, number] = [192, 108];
export const AERIAL_PERSPECTIVE_SIZE = 32;
/** Farthest distance of the aerial perspective volume (km). */
export const AERIAL_PERSPECTIVE_MAX_KM = 64;
export const PHOTO_LIGHTING_BYTES = 6 * 16;

export const WGSL_PHOTO_LIGHTING_STRUCT = /* wgsl */ `
struct PhotoLighting {
  /** Sun illuminance reaching the scene's altitude (atmospheric transmittance). */
  sunScene: vec4<f32>,
  /** Sun illuminance at the cloud base. */
  sunClouds: vec4<f32>,
  /** Sky irradiance on an upward surface. */
  skyUp: vec4<f32>,
  /** Irradiance from the ground on a downward surface (bounce). */
  groundUp: vec4<f32>,
  /** x = automatic exposure. */
  exposure: vec4<f32>,
  /** Sky irradiance on a vertical surface (mean over azimuths). */
  skySide: vec4<f32>,
};
`;

export const WGSL_ATMOSPHERE = /* wgsl */ `
const ATMO_GROUND_R: f32 = 6360.0;
const ATMO_TOP_R: f32 = 6460.0;
const RAYLEIGH_SCAT: vec3<f32> = vec3<f32>(5.802e-3, 13.558e-3, 33.1e-3);
const RAYLEIGH_H: f32 = 8.0;
const MIE_SCAT: f32 = 3.996e-3;
const MIE_EXT: f32 = 4.44e-3;
const MIE_H: f32 = 1.2;
const MIE_G: f32 = 0.8;
const OZONE_ABS: vec3<f32> = vec3<f32>(0.650e-3, 1.881e-3, 0.085e-3);
const AP_SLICES: f32 = ${AERIAL_PERSPECTIVE_SIZE}.0;

struct Medium {
  rayleigh: vec3<f32>,
  mie: f32,
  extinction: vec3<f32>,
};

fn atmosphereMedium(heightKm: f32, mieScale: f32) -> Medium {
  let h = max(heightKm, 0.0);
  let rd = exp(-h / RAYLEIGH_H);
  let md = exp(-h / MIE_H) * mieScale;
  let od = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  var m: Medium;
  m.rayleigh = RAYLEIGH_SCAT * rd;
  m.mie = MIE_SCAT * md;
  m.extinction = m.rayleigh + vec3<f32>(MIE_EXT * md) + OZONE_ABS * od;
  return m;
}

fn rayleighPhase(c: f32) -> f32 {
  return 3.0 / (16.0 * PI) * (1.0 + c * c);
}

fn cornetteShanks(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  let d = 1.0 + g2 - 2.0 * g * c;
  return 3.0 * (1.0 - g2) * (1.0 + c * c) / (8.0 * PI * (2.0 + g2) * d * sqrt(d));
}

/** Nearest positive distance to a sphere centred on the planet, −1 when missed (km). */
fn raySphereKm(o: vec3<f32>, d: vec3<f32>, r: f32) -> f32 {
  let b = dot(o, d);
  let c = dot(o, o) - r * r;
  let disc = b * b - c;
  if (disc < 0.0) { return -1.0; }
  let s = sqrt(disc);
  let t0 = -b - s;
  let t1 = -b + s;
  if (t0 >= 0.0) { return t0; }
  if (t1 >= 0.0) { return t1; }
  return -1.0;
}

/** Bruneton's transmittance LUT parameterisation: uv → (radius, cos zenith). */
fn transmittanceLutParams(uv: vec2<f32>) -> vec2<f32> {
  let H = sqrt(ATMO_TOP_R * ATMO_TOP_R - ATMO_GROUND_R * ATMO_GROUND_R);
  let rho = H * uv.y;
  let r = sqrt(rho * rho + ATMO_GROUND_R * ATMO_GROUND_R);
  let dMin = ATMO_TOP_R - r;
  let dMax = rho + H;
  let d = dMin + uv.x * (dMax - dMin);
  var mu = 1.0;
  if (d > 0.0) { mu = (H * H - rho * rho - d * d) / (2.0 * r * d); }
  return vec2<f32>(r, clamp(mu, -1.0, 1.0));
}

fn transmittanceUv(r: f32, mu: f32) -> vec2<f32> {
  let H = sqrt(ATMO_TOP_R * ATMO_TOP_R - ATMO_GROUND_R * ATMO_GROUND_R);
  let rho = sqrt(max(0.0, r * r - ATMO_GROUND_R * ATMO_GROUND_R));
  let disc = r * r * (mu * mu - 1.0) + ATMO_TOP_R * ATMO_TOP_R;
  let d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  let dMin = ATMO_TOP_R - r;
  let dMax = rho + H;
  return vec2<f32>((d - dMin) / max(dMax - dMin, 1e-6), rho / H);
}

/** Atmosphere position (km, planet-centred) of a render-frame point. */
fn atmospherePos(p: vec3<f32>, centreAltM: f32) -> vec3<f32> {
  return vec3<f32>(p.x * 0.001, ATMO_GROUND_R + max(centreAltM + p.y, 1.0) * 0.001, p.z * 0.001);
}
`;

/** Transmittance and multiple-scattering lookups (passes that read the LUTs). */
export const WGSL_ATMOSPHERE_LOOKUPS = /* wgsl */ `
fn sunTransmittance(lut: texture_2d<f32>, samp: sampler, posKm: vec3<f32>, sunDir: vec3<f32>) -> vec3<f32> {
  let r = length(posKm);
  let up = posKm / r;
  let mu = dot(up, sunDir);
  // Below the planet's horizon from here: no direct sun.
  if (raySphereKm(posKm, sunDir, ATMO_GROUND_R) > 0.0) { return vec3<f32>(0.0); }
  return textureSampleLevel(lut, samp, transmittanceUv(r, mu), 0.0).rgb;
}

fn multipleScattering(lut: texture_2d<f32>, samp: sampler, posKm: vec3<f32>, sunDir: vec3<f32>) -> vec3<f32> {
  let r = length(posKm);
  let mu = dot(posKm / r, sunDir);
  let uv = vec2<f32>(mu * 0.5 + 0.5, clamp((r - ATMO_GROUND_R) / (ATMO_TOP_R - ATMO_GROUND_R), 0.0, 1.0));
  let half = 0.5 / ${MULTISCATTER_LUT_SIZE}.0;
  return textureSampleLevel(lut, samp, clamp(uv, vec2<f32>(half), vec2<f32>(1.0 - half)), 0.0).rgb;
}

/**
 * Sky-view LUT coordinates of a view direction, for a camera at altitude
 * \`camAltKm\` (Hillaire's latitude remapping around the horizon).
 */
fn skyViewUv(dir: vec3<f32>, sunDir: vec3<f32>, camAltKm: f32) -> vec2<f32> {
  let height = ATMO_GROUND_R + camAltKm;
  let horizon = acos(clamp(sqrt(max(height * height - ATMO_GROUND_R * ATMO_GROUND_R, 0.0)) / height, -1.0, 1.0));
  let altitudeAngle = horizon - acos(clamp(dir.y, -1.0, 1.0));
  var azimuth = 0.0;
  if (abs(altitudeAngle) < 0.5 * PI - 1e-4) {
    let up = vec3<f32>(0.0, 1.0, 0.0);
    var right = cross(sunDir, up);
    if (dot(right, right) < 1e-8) { right = vec3<f32>(1.0, 0.0, 0.0); }
    let forward = cross(up, right);
    let projected = normalize(vec3<f32>(dir.x, 0.0, dir.z) + vec3<f32>(1e-6, 0.0, 0.0));
    azimuth = atan2(dot(projected, right), dot(projected, forward)) + PI;
  }
  let v = 0.5 + 0.5 * sign(altitudeAngle) * sqrt(abs(altitudeAngle) * 2.0 / PI);
  return vec2<f32>(azimuth / (2.0 * PI), v);
}
`;

const WGSL_SCATTER_STEP = /* wgsl */ `
struct ScatterResult {
  luminance: vec3<f32>,
  transmittance: vec3<f32>,
};

/**
 * Single + multiple scattering along a ray from \`origin\` (km) over \`tMax\`
 * km, sun illuminance 1 (Hillaire's IntegrateScatteredLuminance).
 */
fn integrateScattering(
  origin: vec3<f32>, dir: vec3<f32>, sunDir: vec3<f32>, tMax: f32, steps: i32, mieScale: f32,
) -> ScatterResult {
  let cosTheta = dot(dir, sunDir);
  let phaseR = rayleighPhase(cosTheta);
  let phaseM = cornetteShanks(cosTheta, MIE_G);
  var lum = vec3<f32>(0.0);
  var trans = vec3<f32>(1.0);
  var t = 0.0;
  for (var i = 0; i < steps; i++) {
    let tNew = tMax * (f32(i) + 0.3) / f32(steps);
    let dt = tNew - t;
    t = tNew;
    let p = origin + dir * t;
    let h = length(p) - ATMO_GROUND_R;
    let m = atmosphereMedium(h, mieScale);
    let stepTrans = exp(-dt * m.extinction);
    let sunT = sunTransmittance(transmittanceLut, linearClamp, p, sunDir);
    let ms = multipleScattering(multiScatterLut, linearClamp, p, sunDir);
    let scatterNoPhase = m.rayleigh + vec3<f32>(m.mie);
    let inScatter = (m.rayleigh * phaseR + vec3<f32>(m.mie * phaseM)) * sunT + scatterNoPhase * ms;
    let integral = (inScatter - inScatter * stepTrans) / max(m.extinction, vec3<f32>(1e-7));
    lum += trans * integral;
    trans *= stepTrans;
  }
  var result: ScatterResult;
  result.luminance = lum;
  result.transmittance = trans;
  return result;
}
`;

export const TRANSMITTANCE_LUT_SHADER = /* wgsl */ `
${WGSL_PHOTO_STRUCT}
${WGSL_PHOTO_HELPERS}
${WGSL_ATMOSPHERE}
@group(0) @binding(0) var<uniform> photo: Photo;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(outTex);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let uv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(size);
  let rm = transmittanceLutParams(uv);
  let o = vec3<f32>(0.0, rm.x, 0.0);
  let d = vec3<f32>(sqrt(max(0.0, 1.0 - rm.y * rm.y)), rm.y, 0.0);
  let tMax = raySphereKm(o, d, ATMO_TOP_R);
  var depth = vec3<f32>(0.0);
  let steps = 40;
  let dt = max(tMax, 0.0) / f32(steps);
  for (var i = 0; i < steps; i++) {
    let p = o + d * ((f32(i) + 0.5) * dt);
    depth += atmosphereMedium(length(p) - ATMO_GROUND_R, photo.atmosphere.x).extinction * dt;
  }
  textureStore(outTex, vec2<i32>(gid.xy), vec4<f32>(exp(-depth), 1.0));
}
`;

export const MULTISCATTER_LUT_SHADER = /* wgsl */ `
${WGSL_PHOTO_STRUCT}
${WGSL_PHOTO_HELPERS}
${WGSL_ATMOSPHERE}
${WGSL_ATMOSPHERE_LOOKUPS}
@group(0) @binding(0) var<uniform> photo: Photo;
@group(0) @binding(1) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;
@group(0) @binding(3) var outTex: texture_storage_2d<rgba16float, write>;

var<workgroup> lumShared: array<vec3<f32>, 64>;
var<workgroup> fmsShared: array<vec3<f32>, 64>;

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let uv = (vec2<f32>(wg.xy) + 0.5) / ${MULTISCATTER_LUT_SIZE}.0;
  let sunCos = uv.x * 2.0 - 1.0;
  let sunDir = normalize(vec3<f32>(0.0, sunCos, -sqrt(max(0.0, 1.0 - sunCos * sunCos))));
  let h = ATMO_GROUND_R + clamp(uv.y, 0.002, 0.998) * (ATMO_TOP_R - ATMO_GROUND_R);
  let pos = vec3<f32>(0.0, h, 0.0);
  let mieScale = photo.atmosphere.x;
  let groundAlbedo = photo.atmosphere.y;

  let i = f32(li / 8u);
  let j = f32(li % 8u);
  let theta = 2.0 * PI * (i + 0.5) / 8.0;
  let phi = acos(clamp(1.0 - 2.0 * (j + 0.5) / 8.0, -1.0, 1.0));
  let dir = vec3<f32>(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));

  let groundT = raySphereKm(pos, dir, ATMO_GROUND_R);
  let topT = raySphereKm(pos, dir, ATMO_TOP_R);
  let tMax = select(topT, groundT, groundT > 0.0);
  let uniformPhase = 1.0 / (4.0 * PI);
  var lum = vec3<f32>(0.0);
  var fms = vec3<f32>(0.0);
  var trans = vec3<f32>(1.0);
  var t = 0.0;
  let steps = 20;
  for (var s = 0; s < steps; s++) {
    let tNew = tMax * (f32(s) + 0.3) / f32(steps);
    let dt = tNew - t;
    t = tNew;
    let p = pos + dir * t;
    let m = atmosphereMedium(length(p) - ATMO_GROUND_R, mieScale);
    let stepTrans = exp(-dt * m.extinction);
    let scatter = m.rayleigh + vec3<f32>(m.mie);
    let ext = max(m.extinction, vec3<f32>(1e-7));
    fms += trans * (scatter - scatter * stepTrans) / ext;
    let sunT = sunTransmittance(transmittanceLut, linearClamp, p, sunDir);
    let inScatter = scatter * uniformPhase * sunT;
    lum += trans * (inScatter - inScatter * stepTrans) / ext;
    trans *= stepTrans;
  }
  if (groundT > 0.0) {
    let hit = pos + dir * groundT;
    let n = normalize(hit);
    lum += trans * groundAlbedo / PI * saturate(dot(n, sunDir)) * sunTransmittance(transmittanceLut, linearClamp, n * (ATMO_GROUND_R + 0.001), sunDir);
  }
  lumShared[li] = lum;
  fmsShared[li] = fms;
  workgroupBarrier();
  var stride = 32u;
  loop {
    if (li < stride) {
      lumShared[li] += lumShared[li + stride];
      fmsShared[li] += fmsShared[li + stride];
    }
    workgroupBarrier();
    if (stride == 1u) { break; }
    stride = stride / 2u;
  }
  if (li == 0u) {
    // Mean over the sphere: L × 4π (sun in-scatter carried the 1/4π phase), r = mean transfer.
    let l = lumShared[0] / 64.0 * 4.0 * PI;
    let r = fmsShared[0] / 64.0;
    textureStore(outTex, vec2<i32>(wg.xy), vec4<f32>(l / max(vec3<f32>(1.0) - r, vec3<f32>(1e-3)), 1.0));
  }
}
`;

export const SKY_VIEW_LUT_SHADER = /* wgsl */ `
${WGSL_PHOTO_STRUCT}
${WGSL_PHOTO_HELPERS}
${WGSL_ATMOSPHERE}
${WGSL_ATMOSPHERE_LOOKUPS}
@group(0) @binding(0) var<uniform> photo: Photo;
@group(0) @binding(1) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;
@group(0) @binding(3) var multiScatterLut: texture_2d<f32>;
@group(0) @binding(4) var outTex: texture_storage_2d<rgba16float, write>;
${WGSL_SCATTER_STEP}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(outTex);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let uv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(size);
  let camAlt = max(photo.atmosphere.z, 0.01);
  let height = ATMO_GROUND_R + camAlt;
  let origin = vec3<f32>(0.0, height, 0.0);
  // The LUT is laid out around the sun's azimuth (sun towards −z).
  let sinSunAlt = clamp(photo.sunDir.y, -1.0, 1.0);
  let sunDir = vec3<f32>(0.0, sinSunAlt, -sqrt(max(0.0, 1.0 - sinSunAlt * sinSunAlt)));
  let azimuth = (uv.x - 0.5) * 2.0 * PI;
  var adjV = 0.0;
  if (uv.y < 0.5) {
    let coord = 1.0 - 2.0 * uv.y;
    adjV = -coord * coord;
  } else {
    let coord = uv.y * 2.0 - 1.0;
    adjV = coord * coord;
  }
  let horizon = acos(clamp(sqrt(max(height * height - ATMO_GROUND_R * ATMO_GROUND_R, 0.0)) / height, -1.0, 1.0)) - 0.5 * PI;
  let altitudeAngle = adjV * 0.5 * PI - horizon;
  let ca = cos(altitudeAngle);
  let dir = vec3<f32>(ca * sin(azimuth), sin(altitudeAngle), -ca * cos(azimuth));
  let groundT = raySphereKm(origin, dir, ATMO_GROUND_R);
  let topT = raySphereKm(origin, dir, ATMO_TOP_R);
  let tMax = select(topT, groundT, groundT > 0.0);
  let r = integrateScattering(origin, dir, sunDir, max(tMax, 0.0), 32, photo.atmosphere.x);
  textureStore(outTex, vec2<i32>(gid.xy), vec4<f32>(r.luminance, 1.0));
}
`;

export const AERIAL_PERSPECTIVE_SHADER = /* wgsl */ `
${WGSL_PHOTO_STRUCT}
${WGSL_PHOTO_HELPERS}
${WGSL_ATMOSPHERE}
${WGSL_ATMOSPHERE_LOOKUPS}
@group(0) @binding(0) var<uniform> photo: Photo;
@group(0) @binding(1) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;
@group(0) @binding(3) var multiScatterLut: texture_2d<f32>;
@group(0) @binding(4) var outTex: texture_storage_3d<rgba16float, write>;
${WGSL_SCATTER_STEP}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(outTex);
  if (gid.x >= size.x || gid.y >= size.y || gid.z >= size.z) { return; }
  let uv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(size.xy);
  let eye = photo.cameraPos.xyz;
  let dir = viewRay(uv, photo.invViewProj, eye);
  let w = (f32(gid.z) + 0.5) / AP_SLICES;
  let distKm = w * w * photo.quality.y;
  let origin = atmospherePos(eye, photo.scene.x);
  let steps = max(2, i32(gid.z / 2u) + 2);
  let r = integrateScattering(origin, dir, photo.sunDir.xyz, distKm, steps, photo.atmosphere.x);
  let t = dot(r.transmittance, vec3<f32>(1.0 / 3.0));
  textureStore(outTex, vec3<i32>(gid), vec4<f32>(r.luminance, t));
}
`;

/**
 * Sun and sky irradiance for the scene and the clouds, and the automatic
 * exposure: one workgroup integrating the sky-view LUT over the hemisphere.
 */
export const SKY_IRRADIANCE_SHADER = /* wgsl */ `
${WGSL_PHOTO_STRUCT}
${WGSL_PHOTO_HELPERS}
${WGSL_ATMOSPHERE}
${WGSL_ATMOSPHERE_LOOKUPS}
${WGSL_PHOTO_LIGHTING_STRUCT}
@group(0) @binding(0) var<uniform> photo: Photo;
@group(0) @binding(1) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;
@group(0) @binding(3) var skyViewLut: texture_2d<f32>;
@group(0) @binding(4) var<storage, read_write> lighting: PhotoLighting;

var<workgroup> upShared: array<vec3<f32>, 64>;
var<workgroup> sideShared: array<vec3<f32>, 64>;

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) li: u32) {
  let sunDir = normalize(photo.sunDir.xyz);
  let camAlt = max(photo.atmosphere.z, 0.01);
  var up = vec3<f32>(0.0);
  var side = vec3<f32>(0.0);
  // 4 cosine-weighted directions per thread (golden-angle spiral).
  for (var k = 0u; k < 4u; k++) {
    let n = f32(li * 4u + k);
    let u = (n + 0.5) / 256.0;
    let r = sqrt(u);
    let a = n * 2.39996323;
    let dir = normalize(vec3<f32>(r * cos(a), sqrt(max(0.0, 1.0 - u)), r * sin(a)));
    let l = textureSampleLevel(skyViewLut, linearClamp, skyViewUv(dir, sunDir, camAlt), 0.0).rgb;
    up += l;
    // Vertical wall, averaged over its azimuths: mean cosine to its normal = sinθ / π.
    side += l * (r / PI) / max(dir.y, 0.05);
  }
  upShared[li] = up;
  sideShared[li] = side;
  workgroupBarrier();
  var stride = 32u;
  loop {
    if (li < stride) {
      upShared[li] += upShared[li + stride];
      sideShared[li] += sideShared[li + stride];
    }
    workgroupBarrier();
    if (stride == 1u) { break; }
    stride = stride / 2u;
  }
  if (li != 0u) { return; }
  // Cosine-weighted mean × π = irradiance.
  let sunIllum = photo.sunDir.w;
  // Three-wavelength Rayleigh skylight is bluer than measured skylight
  // (CCT 10 000–25 000 K, blue/red ≈ 2 rather than 6): shadows are lit by
  // a partly desaturated sky.
  let skyUpRaw = upShared[0] / 256.0 * PI * sunIllum;
  let skySideRaw = sideShared[0] / 256.0 * PI * sunIllum;
  let skyUp = mix(vec3<f32>(luminance(skyUpRaw)), skyUpRaw, 0.55);
  let skySide = mix(vec3<f32>(luminance(skySideRaw)), skySideRaw, 0.55);
  let scenePos = vec3<f32>(0.0, ATMO_GROUND_R + max(photo.scene.x, 1.0) * 0.001, 0.0);
  let cloudPos = vec3<f32>(0.0, ATMO_GROUND_R + max(photo.cloudLayer.x, 1.0) * 0.001, 0.0);
  let sunScene = sunTransmittance(transmittanceLut, linearClamp, scenePos, sunDir) * sunIllum;
  let sunClouds = sunTransmittance(transmittanceLut, linearClamp, cloudPos, sunDir) * sunIllum;
  let horizontalSun = sunScene * max(sunDir.y, 0.0);
  let albedo = photo.scene.z;
  lighting.sunScene = vec4<f32>(sunScene, 1.0);
  lighting.sunClouds = vec4<f32>(sunClouds, 1.0);
  lighting.skyUp = vec4<f32>(skyUp, 1.0);
  lighting.skySide = vec4<f32>(skySide, 1.0);
  lighting.groundUp = vec4<f32>(albedo * (horizontalSun + skyUp), 1.0);
  // A horizontal 18 % grey in this light maps to mid-grey; dusk is let darker.
  let reference = luminance(horizontalSun + skyUp);
  // Around sunset a photographer exposes for the sky: the ground is in the
  // shade while clouds still catch the sun, and metering on the ground blew
  // the reddened clouds out to pastel (−1.6 EV with the sun on the horizon,
  // nothing above ~8°).
  let sunset = 1.0 - smoothstep(-0.03, 0.14, sunDir.y);
  let exposure = PI / pow(max(reference, 0.004), 0.92) * exp2(-1.6 * sunset);
  lighting.exposure = vec4<f32>(exposure, reference, 0.0, 0.0);
}
`;
