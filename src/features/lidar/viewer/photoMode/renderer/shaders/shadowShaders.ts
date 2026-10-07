// ============================================
// Photo mode — shadow maps and surface model seen from above
// ============================================
//
// The shadow casters are the LiDAR points themselves (trees, buildings,
// power lines…) plus the DTM mesh, drawn depth-only from the sun with an
// orthographic projection. A point is a light-facing square: the shadow
// texel size, or its node's spacing where the node is the finest drawn
// (same octant masks as the adaptive point size, but for the shadow
// selection). The surface model (DSM) is the same drawing seen from the
// zenith; a compute pass turns its depth into heights, normals and the sky
// view factor.

import { WGSL_NODE_STRUCT } from '../../../renderer/shaders/pointShader';

export const SHADOW_PARAMS_BYTES = 16 * 4 + 4 * 16;

const WGSL_SHADOW_PARAMS = /* wgsl */ `
struct ShadowParams {
  viewProj: mat4x4<f32>,
  right: vec4<f32>,
  up: vec4<f32>,
  /** x = smallest sprite (m), y = adaptive spacing factor, z = point filter on, w = unused. */
  sizes: vec4<f32>,
  filterMask: vec4<u32>,
};
`;

export const SHADOW_SHADER = /* wgsl */ `
${WGSL_SHADOW_PARAMS}
${WGSL_NODE_STRUCT}
@group(0) @binding(0) var<uniform> shadow: ShadowParams;
/** Per pool slot: octants covered by a node of the shadow selection. */
@group(0) @binding(1) var<storage, read> shadowMasks: array<u32>;
@group(1) @binding(0) var<uniform> node: NodeParams;

fn classVisible(cls: u32) -> bool {
  if (shadow.sizes.z < 0.5) { return true; }
  if (cls < 32u) { return ((shadow.filterMask.x >> cls) & 1u) != 0u; }
  if (cls < 64u) { return ((shadow.filterMask.y >> (cls - 32u)) & 1u) != 0u; }
  if (cls < 96u) { return ((shadow.filterMask.z >> (cls - 64u)) & 1u) != 0u; }
  if (cls < 128u) { return ((shadow.filterMask.w >> (cls - 96u)) & 1u) != 0u; }
  return true;
}

@vertex
fn shadow_points_vs(@builtin(vertex_index) vi: u32, @location(0) q: vec4<f32>) -> @builtin(position) vec4<f32> {
  let cls = u32(q.w * 65535.0 + 0.5) & 0xffu;
  if (!classVisible(cls)) { return vec4<f32>(0.0, 0.0, 2.0, 1.0); }
  let uv = vec2<f32>(select(-1.0, 1.0, (vi & 1u) != 0u), select(-1.0, 1.0, (vi & 2u) != 0u));
  let pos = node.origin + vec3<f32>(q.x, q.z, -q.y) * node.size;
  let octant = select(0u, 1u, q.x >= 0.5) | select(0u, 2u, q.y >= 0.5) | select(0u, 4u, q.z >= 0.5);
  var size = shadow.sizes.x;
  if (((shadowMasks[node.slot] >> octant) & 1u) == 0u) {
    size = max(size, node.adaptiveSpacing * shadow.sizes.y);
  }
  let corner = pos + (shadow.right.xyz * uv.x + shadow.up.xyz * uv.y) * (size * 0.5);
  return shadow.viewProj * vec4<f32>(corner, 1.0);
}

@vertex
fn shadow_terrain_vs(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return shadow.viewProj * vec4<f32>(position, 1.0);
}
`;

export const DSM_PARAMS_BYTES = 16 * 4 + 2 * 16;

const WGSL_DSM_PARAMS = /* wgsl */ `
struct DsmParams {
  /** Inverse of the top-down projection: clip (x, y, depth) → render frame. */
  invViewProj: mat4x4<f32>,
  /** DTM heightmap: origin x/z, size x/z. */
  dtm: vec4<f32>,
  /** x = texel (m), y = sky view factor reach (texels), z = unused, w = unused. */
  info: vec4<f32>,
};
`;

/** Depth of the top-down drawing → height of the highest return (DTM where nothing was drawn). */
export const DSM_HEIGHT_SHADER = /* wgsl */ `
${WGSL_DSM_PARAMS}
@group(0) @binding(0) var<uniform> dsm: DsmParams;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var dtmTex: texture_2d<f32>;
@group(0) @binding(3) var outHeight: texture_storage_2d<r32float, write>;

fn dtmHeight(x: f32, z: f32) -> f32 {
  let dims = vec2<i32>(textureDimensions(dtmTex, 0));
  let u = clamp((x - dsm.dtm.x) / dsm.dtm.z, 0.0, 1.0);
  let v = clamp((z - dsm.dtm.y) / dsm.dtm.w, 0.0, 1.0);
  let c = vec2<i32>(round(vec2<f32>(u, v) * vec2<f32>(dims - vec2<i32>(1))));
  return textureLoad(dtmTex, c, 0).r;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(outHeight);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let uv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(size);
  let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let depth = textureLoad(depthTex, vec2<i32>(gid.xy), 0);
  let atTop = dsm.invViewProj * vec4<f32>(ndc, 0.0, 1.0);
  let ground = dtmHeight(atTop.x / atTop.w, atTop.z / atTop.w);
  var h = ground;
  if (depth < 0.99999) {
    let p = dsm.invViewProj * vec4<f32>(ndc, depth, 1.0);
    h = max(p.y / p.w, ground);
  }
  textureStore(outHeight, vec2<i32>(gid.xy), vec4<f32>(h, 0.0, 0.0, 0.0));
}
`;

/**
 * Normal of the surface model (smoothed over ±2 texels: roof pans and the
 * dome of a tree crown, not each return) and its sky view factor, the share
 * of the sky seen from it (12 directions, horizon up to `info.y` texels).
 */
export const DSM_SHADE_SHADER = /* wgsl */ `
${WGSL_DSM_PARAMS}
@group(0) @binding(0) var<uniform> dsm: DsmParams;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var outInfo: texture_storage_2d<rgba8unorm, write>;

fn h(c: vec2<i32>) -> f32 {
  let dims = vec2<i32>(textureDimensions(heightTex, 0));
  return textureLoad(heightTex, clamp(c, vec2<i32>(0), dims - vec2<i32>(1)), 0).r;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(outInfo);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let c = vec2<i32>(gid.xy);
  let texel = dsm.info.x;
  let h0 = h(c);
  // Texture x = east, y = south (top-down projection: up axis = north).
  let dx = (h(c + vec2<i32>(2, 0)) + h(c + vec2<i32>(2, 1)) + h(c + vec2<i32>(2, -1))
    - h(c - vec2<i32>(2, 0)) - h(c + vec2<i32>(-2, 1)) - h(c + vec2<i32>(-2, -1))) / (12.0 * texel);
  let dz = (h(c + vec2<i32>(0, 2)) + h(c + vec2<i32>(1, 2)) + h(c + vec2<i32>(-1, 2))
    - h(c - vec2<i32>(0, 2)) - h(c + vec2<i32>(1, -2)) - h(c + vec2<i32>(-1, -2))) / (12.0 * texel);
  let n = normalize(vec3<f32>(-dx, 1.0, -dz));

  var openness = 0.0;
  let reach = dsm.info.y;
  for (var k = 0; k < 12; k++) {
    let a = f32(k) * 0.5235988 + 0.26;
    let d = vec2<f32>(cos(a), sin(a));
    var maxSlope = 0.0;
    var dist = 1.5;
    for (var s = 0; s < 10; s++) {
      let o = vec2<i32>(round(d * dist));
      let rise = h(c + o) - h0;
      maxSlope = max(maxSlope, rise / (dist * texel));
      dist = min(dist * 1.6, reach);
    }
    // 1 − sin(horizon elevation): sky seen above the horizon in that direction.
    openness += 1.0 - maxSlope / sqrt(1.0 + maxSlope * maxSlope);
  }
  let svf = openness / 12.0;
  textureStore(outInfo, c, vec4<f32>(n.x * 0.5 + 0.5, n.z * 0.5 + 0.5, svf, 1.0));
}
`;
