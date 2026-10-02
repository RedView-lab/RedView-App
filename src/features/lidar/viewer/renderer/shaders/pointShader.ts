// ============================================
// WGSL Shader Components — Point Cloud Shaders
// ============================================
//
// Points are streamed per LOD node as 12-byte records (see lod/lodTile.ts):
// u16×3 position quantized in the node cube, class, intensity, RGB. They
// are shaded once per point by a compute pass (colour mode, overlays, DTM
// lighting) when a node arrives or that state changes; the per-frame
// vertex shader only decodes the position, projects a screen-aligned
// sprite and reads the pre-shaded colour — no texture fetch per vertex.

import {
  WGSL_CAMERA_BINDING,
  WGSL_CAMERA_STRUCT,
  WGSL_COLOR_HELPERS,
  WGSL_HEIGHT_HELPERS,
  WGSL_LIGHTING_HELPERS,
  WGSL_OVERLAY_HELPERS,
  WGSL_SCENE_BINDINGS,
} from './common';

/** Group 1 of the point pipeline: per-frame sprite parameters. */
export const POINT_PARAMS_FLOATS = 8;
/** Per-node uniform record (bound with a dynamic offset). */
export const NODE_UNIFORM_BYTES = 32;

const WGSL_NODE_STRUCT = /* wgsl */ `
struct NodeParams {
  origin: vec3<f32>,
  size: f32,
  _pad0: f32,
  count: u32,
  _pad1: f32,
  _pad2: f32,
};
`;

export const POINT_SHADER = /* wgsl */ `
${WGSL_CAMERA_STRUCT}
${WGSL_CAMERA_BINDING}
${WGSL_NODE_STRUCT}

struct PointParams {
  minPx: f32,
  maxPx: f32,
  fixedPx: f32,
  focalPx: f32,
  viewportW: f32,
  viewportH: f32,
  antialias: f32,
  /** Point diameter in metres, the same for every point. */
  worldSize: f32,
};

@group(1) @binding(0) var<uniform> params: PointParams;
@group(2) @binding(0) var<uniform> node: NodeParams;

${WGSL_COLOR_HELPERS}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) @interpolate(flat) color: vec4<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) @interpolate(flat) px: f32,
};

@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  @location(0) q: vec4<f32>,
  @location(1) col: vec4<f32>,
) -> VsOut {
  var out: VsOut;
  let cls = u32(col.a * 255.0 + 0.5);
  let uv = vec2<f32>(select(-1.0, 1.0, (vi & 1u) != 0u), select(-1.0, 1.0, (vi & 2u) != 0u));
  // Quantized CRS axes (east, north, up) → render frame (east, up, −north).
  let pos = node.origin + vec3<f32>(q.x, q.z, -q.y) * node.size;
  let clip = camera.viewProj * vec4<f32>(pos, 1.0);

  // Diameter in pixels: one world size for every point (perspective only), or
  // a fixed pixel size; clamped so far points never vanish.
  var px = params.fixedPx;
  if (px <= 0.0) {
    px = params.worldSize * params.focalPx / max(clip.w, 1e-4);
  }
  px = clamp(px, params.minPx, params.maxPx);
  let visible = isPointClassVisible(cls);
  let halfNdc = select(0.0, px, visible) / vec2<f32>(params.viewportW, params.viewportH);

  out.pos = vec4<f32>(clip.xy + uv * halfNdc * clip.w, clip.z, clip.w);
  out.color = vec4<f32>(col.rgb, 1.0);
  out.uv = uv;
  out.px = px;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let r = length(in.uv);
  // Below ~2.5 px a disc would lose its only covered pixel: draw a square.
  if (in.px > 2.5 && r > 1.0) { discard; }
  var alpha = 1.0;
  if (params.antialias > 0.5 && in.px > 2.5) {
    // About one pixel of soft edge, resolved by alpha-to-coverage (MSAA).
    alpha = clamp((1.0 - r) * in.px * 0.5 + 0.5, 0.0, 1.0);
  }
  return vec4<f32>(in.color.rgb, alpha);
}
`;

export const POINT_SHADING_WORKGROUP_SIZE = 256;

/**
 * Writes one pre-shaded RGBA8 word per point: rgb = final colour (colour
 * mode, overlays, lighting), a = classification. Ground points (classes 2/9,
 * or unclassified points lying on the DTM) get the DTM hillshade; everything
 * else (trees, buildings, wires) gets flat-ground lighting, since the ground
 * normal under a roof or a canopy says nothing about its own orientation.
 * Eye-Dome Lighting then brings out the 3D structure in screen space.
 */
export const POINT_SHADING_SHADER = /* wgsl */ `
${WGSL_CAMERA_STRUCT}
${WGSL_SCENE_BINDINGS}
${WGSL_NODE_STRUCT}

@group(1) @binding(0) var<storage, read> packed: array<u32>;
@group(1) @binding(1) var<storage, read_write> shadedColors: array<u32>;
@group(1) @binding(2) var<uniform> node: NodeParams;

${WGSL_COLOR_HELPERS}
${WGSL_OVERLAY_HELPERS}
${WGSL_HEIGHT_HELPERS}
${WGSL_LIGHTING_HELPERS}

fn isGroundPoint(cls: u32, p: vec3<f32>) -> bool {
  if (cls == 2u || cls == 9u) { return true; }
  if (cls <= 1u) { return abs(p.y - sampleGroundHeight(p)) < 0.5; }
  return false;
}

/** ASPRS / IGN LiDAR HD classes. */
fn classificationColor(cls: u32) -> vec3<f32> {
  switch (cls) {
    case 2u: { return vec3<f32>(0.70, 0.56, 0.38); }
    case 3u: { return vec3<f32>(0.62, 0.82, 0.38); }
    case 4u: { return vec3<f32>(0.33, 0.68, 0.27); }
    case 5u: { return vec3<f32>(0.13, 0.47, 0.17); }
    case 6u: { return vec3<f32>(0.86, 0.31, 0.24); }
    case 7u, 18u: { return vec3<f32>(0.92, 0.25, 0.86); }
    case 9u: { return vec3<f32>(0.20, 0.47, 0.88); }
    case 17u: { return vec3<f32>(0.62, 0.62, 0.68); }
    case 64u: { return vec3<f32>(0.95, 0.66, 0.22); }
    case 65u: { return vec3<f32>(0.55, 0.20, 0.55); }
    case 66u: { return vec3<f32>(0.45, 0.80, 0.85); }
    case 67u: { return vec3<f32>(0.80, 0.80, 0.40); }
    default: { return vec3<f32>(0.78, 0.78, 0.78); }
  }
}

@compute @workgroup_size(${POINT_SHADING_WORKGROUP_SIZE})
fn shade_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= node.count) { return; }
  let w0 = packed[i * 3u];
  let w1 = packed[i * 3u + 1u];
  let w2 = packed[i * 3u + 2u];
  let q = vec3<f32>(f32(w0 & 0xffffu), f32(w0 >> 16u), f32(w1 & 0xffffu)) / 65535.0;
  let p = node.origin + vec3<f32>(q.x, q.z, -q.y) * node.size;
  let cls = (w1 >> 16u) & 0xffu;
  let intensity = f32(w1 >> 24u) / 255.0;

  var base = unpack4x8unorm(w2).rgb;
  if (camera.colorMode > 1.5) {
    base = classificationColor(cls);
  } else if (camera.colorMode > 0.5) {
    base = vec3<f32>(pow(intensity, 0.8));
  }

  let terrainNormal = computeSobelNormal(p);
  var c = applySnow(base, p);
  c = applySlope(c, terrainNormal);
  c = applyAltitude(c, p);
  c = applySunlightMap(c, p);

  let N = select(vec3<f32>(0.0, 1.0, 0.0), terrainNormal, isGroundPoint(cls, p));
  let lit = shadeSurface(N, c, p);
  shadedColors[i] = pack4x8unorm(vec4<f32>(lit, f32(cls) / 255.0));
}
`;
