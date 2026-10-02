// ============================================
// WGSL Shader Components — Eye-Dome Lighting (EDL) resolve pass
// ============================================
//
// Screen-space shading used by CloudCompare and Potree: each pixel is
// darkened by how much closer its 8 neighbours are (in log depth). It brings
// out edges, roofs, canopies and terrain relief without any normals. Depth
// comes from the reversed-Z, infinite-far projection: d = near / viewDist,
// so log2(viewDist) = log2(near) - log2(d) and the constant cancels out.
// Background pixels are left untouched (no dark halo around the cloud).
// Optional (off by default): it also outlines individual large points.
// While the camera moves the scene may be rendered smaller than the canvas
// (`scale` < 1): the pass then reads the texel under each canvas pixel.

export const EDL_PARAMS_FLOATS = 4;

function buildEdlShader(depthTextureType: string): string {
  return /* wgsl */ `
struct EdlParams {
  strength: f32,
  /** Neighbour distance in pixels of the scene targets. */
  radius: f32,
  enabled: f32,
  /** Scene target size / canvas size. */
  scale: f32,
};

@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: ${depthTextureType};
@group(0) @binding(2) var<uniform> edl: EdlParams;

@vertex
fn edl_vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

fn loadDepth(c: vec2<i32>) -> f32 {
  return textureLoad(depthTex, c, 0);
}

@fragment
fn edl_fs(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let dims = vec2<i32>(textureDimensions(colorTex));
  let c = min(vec2<i32>(fragCoord.xy * edl.scale), dims - vec2<i32>(1));
  let color = textureLoad(colorTex, c, 0).rgb;
  if (edl.enabled < 0.5) {
    return vec4<f32>(color, 1.0);
  }

  let d = loadDepth(c);
  if (d <= 0.0) {
    return vec4<f32>(color, 1.0);
  }
  let centerLog = -log2(d);
  var sum = 0.0;
  for (var k = 0; k < 8; k++) {
    let angle = f32(k) * 0.7853981633974483;
    let offset = vec2<i32>(round(vec2<f32>(cos(angle), sin(angle)) * edl.radius));
    let nd = loadDepth(clamp(c + offset, vec2<i32>(0), dims - vec2<i32>(1)));
    if (nd > 0.0) {
      sum += max(0.0, centerLog + log2(nd));
    }
  }
  let response = sum / 8.0;
  let shade = exp(-response * 300.0 * edl.strength);
  return vec4<f32>(color * shade, 1.0);
}
`;
}

export const EDL_SHADER = buildEdlShader('texture_depth_2d');
export const EDL_SHADER_MSAA = buildEdlShader('texture_depth_multisampled_2d');
