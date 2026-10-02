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
