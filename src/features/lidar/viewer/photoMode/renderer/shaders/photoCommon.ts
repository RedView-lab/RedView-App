// ============================================
// Photo mode — WGSL shared by every pass
// ============================================
//
// One uniform block (`Photo`, packed by `photoUniforms.ts`) for the whole
// frame. Only mat4/vec4 members: no implicit padding between WGSL and the
// TS packer. Lengths in the render frame are metres (x east, y up = altitude
// − scene centre altitude, z south); the atmosphere works in kilometres.

/** Matrices then vec4s, in the order of the struct below (see `photoUniforms.ts`). */
const PHOTO_UNIFORM_MATRICES = 7;
const PHOTO_UNIFORM_VEC4S = 21;
export const PHOTO_UNIFORM_FLOATS = PHOTO_UNIFORM_MATRICES * 16 + PHOTO_UNIFORM_VEC4S * 4;

export const WGSL_PHOTO_STRUCT = /* wgsl */ `
struct Photo {
  /** Inverse of the matrix the G-buffer depth was drawn with (jittered while accumulating). */
  invDrawViewProj: mat4x4<f32>,
  /** Unjittered view-projection of this frame and of the previous one (cloud history). */
  viewProj: mat4x4<f32>,
  prevViewProj: mat4x4<f32>,
  /** Inverse of the unjittered view-projection (view rays). */
  invViewProj: mat4x4<f32>,
  shadow0: mat4x4<f32>,
  shadow1: mat4x4<f32>,
  /** Top-down orthographic projection of the surface model (DSM). */
  dsm: mat4x4<f32>,
  /** xyz render frame, w = altitude above sea level (m). */
  cameraPos: vec4<f32>,
  /** xyz unit vector towards the sun, w = sun illuminance. */
  sunDir: vec4<f32>,
  /** x = scene centre altitude (m), y = lowest ground altitude (m), z = mean ground albedo, w = unused. */
  scene: vec4<f32>,
  /** x = base altitude (m), y = top altitude (m), z = cover 0–1, w = type 0–1. */
  cloudLayer: vec4<f32>,
  /** x = extinction (1/m), y = absorbed share, z = half-size of the cloud domain around the scene centre (m), w = seed. */
  cloudParams: vec4<f32>,
  /** Ground shadow map of the clouds on their base plane: xy = centre (x/z), z = half-size (m), w = 1 when complete. */
  cloudShadow: vec4<f32>,
  /** Approximate Mie phase: gHG, gD, alpha, wD. */
  phase: vec4<f32>,
  /** x/y = texel size (m) of cascades 0/1, z/w = their depth range (m). */
  shadowInfo: vec4<f32>,
  /** x = cascade 1 valid, y = cascade 0 valid, z = DSM valid, w = ambient occlusion strength. */
  flags: vec4<f32>,
  /** DTM heightmap: origin x/z, size x/z (render frame). */
  dtm: vec4<f32>,
  /** x = frame index, y = accumulated sample (−1 when moving), z/w = sub-pixel jitter (target px). */
  frame: vec4<f32>,
  /** xy = scene target size (px), zw = canvas size (px). */
  targetSize: vec4<f32>,
  /** xy = cloud buffer size, z = 1 when every cloud pixel is traced this frame, w = traced pixel of each 2×2 block (0–3). */
  cloudSize: vec4<f32>,
  /** x = 2^EV, y = haze 0–1, z = bloom strength, w = unused. */
  exposure: vec4<f32>,
  /** x = Mie density scale, y = ground albedo, z = camera altitude (km), w = clouds on (0/1). */
  atmosphere: vec4<f32>,
  /** x = DSM top Y, y = DSM depth range (m), z = DSM texel (m), w = max cloud steps. */
  dsmInfo: vec4<f32>,
  /** x = cloud step scale, y = AP max distance (km), z = sun angular radius tangent, w = debug view (?photoDebug=). */
  quality: vec4<f32>,
  /** Half-resolution cloud history (moving view): x = weight of a new sample, y = clamp to the new samples (1) or not (0), z = unused, w = history valid. */
  cloudTemporal: vec4<f32>,
  /**
   * Full-resolution accumulation of the still view: x = pixels per block traced in turn (1, 2, 4),
   * y = still frame index (−1: the half-resolution buffer is shown), z = 1 when the pixels not traced
   * yet still hold an image of this view, w = sample index of this frame's pixels.
   */
  cloudStill: vec4<f32>,
  /** High sub-layers (Nubis' 2.5-D model), mid then high: x = base altitude (m), y = thickness (m), z = cover 0–1, w = type (0 streaks … 1 cells). */
  highClouds0: vec4<f32>,
  highClouds1: vec4<f32>,
};
`;

export const WGSL_PHOTO_HELPERS = /* wgsl */ `
const PI: f32 = 3.14159265358979;
const EARTH_RADIUS_M: f32 = 6371000.0;

fn srgbToLinear3(c: vec3<f32>) -> vec3<f32> {
  return select(c / 12.92, pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c > vec3<f32>(0.04045));
}

fn linearToSrgb3(c: vec3<f32>) -> vec3<f32> {
  let x = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  return select(x * 12.92, 1.055 * pow(x, vec3<f32>(1.0 / 2.4)) - 0.055, x > vec3<f32>(0.0031308));
}

fn luminance(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

/** Interleaved gradient noise (Jimenez 2014), in [0, 1). */
fn ign(p: vec2<f32>) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

/** World position of a pixel centre at a reversed-Z depth. */
fn worldFromDepth(px: vec2<f32>, size: vec2<f32>, depth: f32, inv: mat4x4<f32>) -> vec3<f32> {
  let ndc = vec2<f32>(px.x / size.x * 2.0 - 1.0, 1.0 - px.y / size.y * 2.0);
  let h = inv * vec4<f32>(ndc, depth, 1.0);
  return h.xyz / h.w;
}

/** Unit view ray through a point of the screen (uv in [0, 1], y down). */
fn viewRay(uv: vec2<f32>, inv: mat4x4<f32>, eye: vec3<f32>) -> vec3<f32> {
  let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let h = inv * vec4<f32>(ndc, 1.0, 1.0);
  return normalize(h.xyz / h.w - eye);
}

/** Altitude above sea level of a render-frame point (curved Earth, cancellation-free). */
fn shellAltitude(p: vec3<f32>, centreAlt: f32) -> f32 {
  let a = centreAlt + p.y;
  let rc = EARTH_RADIUS_M + a;
  let h2 = p.x * p.x + p.z * p.z;
  return a + h2 / (sqrt(h2 + rc * rc) + rc);
}

/**
 * Distances along the ray from a point at horizontal offset (x, z) and
 * altitude-coordinate a to the sphere of altitude h: (t0, t1) ascending,
 * or (−1, −1) when missed. Stable quadratic, see lib/shell.ts.
 */
fn raySphereAlt(x: f32, a: f32, z: f32, dir: vec3<f32>, h: f32) -> vec2<f32> {
  let b = x * dir.x + (EARTH_RADIUS_M + a) * dir.y + z * dir.z;
  let c = x * x + z * z + (a - h) * (2.0 * EARTH_RADIUS_M + a + h);
  let disc = b * b - c;
  if (disc < 0.0) { return vec2<f32>(-1.0, -1.0); }
  let q = -b - select(-1.0, 1.0, b >= 0.0) * sqrt(disc);
  if (abs(q) < 1e-6) { return vec2<f32>(0.0, 0.0); }
  let t0 = q;
  let t1 = c / q;
  return vec2<f32>(min(t0, t1), max(t0, t1));
}
`;
