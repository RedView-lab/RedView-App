// ============================================
// WGSL Shader Components — Upscale pass
// ============================================
//
// While the camera moves, the scene may be rendered at a fraction of the
// canvas resolution (fill rate is what limits integrated GPUs); this pass
// stretches it over the canvas with bilinear filtering.

export const BLIT_SHADER = /* wgsl */ `
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var colorSampler: sampler;

struct BlitVsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn blit_vs(@builtin(vertex_index) vi: u32) -> BlitVsOut {
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  var out: BlitVsOut;
  out.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2<f32>(p.x, 1.0 - p.y);
  return out;
}

@fragment
fn blit_fs(in: BlitVsOut) -> @location(0) vec4<f32> {
  return vec4<f32>(textureSampleLevel(colorTex, colorSampler, in.uv, 0.0).rgb, 1.0);
}
`;

/** Strength of the sharpening of accumulated still frames (0 = off, 1 = AMD CAS maximum). */
const PRESENT_SHARPNESS = 0.3;

/**
 * Shows the progressive anti-aliasing of still frames: the accumulation
 * target (running mean in linear light, rgba16float, canvas size) encoded
 * back to sRGB on the canvas. The jittered samples spread over one pixel
 * act as a 1 px box filter that softens the image a little: a light
 * contrast-adaptive sharpening (AMD FidelityFX CAS, cross neighbourhood)
 * gives the detail back without halos, weaker where local contrast is high.
 */
export const PRESENT_SHADER = /* wgsl */ `
@group(0) @binding(0) var accumTex: texture_2d<f32>;

@vertex
fn present_vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

fn accumAt(p: vec2<i32>, maxCoord: vec2<i32>) -> vec3<f32> {
  return clamp(textureLoad(accumTex, clamp(p, vec2<i32>(0), maxCoord), 0).rgb, vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn present_fs(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let maxCoord = vec2<i32>(textureDimensions(accumTex)) - vec2<i32>(1);
  let p = vec2<i32>(fragCoord.xy);
  let c = accumAt(p, maxCoord);
  let n = accumAt(p + vec2<i32>(0, -1), maxCoord);
  let s = accumAt(p + vec2<i32>(0, 1), maxCoord);
  let e = accumAt(p + vec2<i32>(1, 0), maxCoord);
  let w = accumAt(p + vec2<i32>(-1, 0), maxCoord);
  let lo = min(c, min(min(n, s), min(e, w)));
  let hi = max(c, max(max(n, s), max(e, w)));
  // Headroom before clipping, relative to the local maximum.
  let amount = sqrt(clamp(min(lo, vec3<f32>(1.0) - hi) / max(hi, vec3<f32>(1e-4)), vec3<f32>(0.0), vec3<f32>(1.0)));
  let weight = amount * (-1.0 / mix(8.0, 5.0, ${PRESENT_SHARPNESS.toFixed(2)}));
  let sharp = clamp((c + (n + s + e + w) * weight) / (vec3<f32>(1.0) + 4.0 * weight), vec3<f32>(0.0), vec3<f32>(1.0));
  let srgb = select(sharp * 12.92, 1.055 * pow(sharp, vec3<f32>(1.0 / 2.4)) - 0.055, sharp > vec3<f32>(0.0031308));
  return vec4<f32>(srgb, 1.0);
}
`;
