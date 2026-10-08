// ============================================
// Composants de shaders WGSL — shader du maillage du terrain
// ============================================

import {
  WGSL_CAMERA_STRUCT,
  WGSL_COLOR_HELPERS,
  WGSL_LIGHTING_HELPERS,
  WGSL_OVERLAY_HELPERS,
  WGSL_SCENE_BINDINGS,
} from './common';

export const TERRAIN_SHADER = /* wgsl */ `
${WGSL_CAMERA_STRUCT}
${WGSL_SCENE_BINDINGS}

struct TerrainVsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) worldPos: vec3<f32>,
};

@vertex
fn terrain_vs(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) col: vec4<f32>,
) -> TerrainVsOut {
  var out: TerrainVsOut;
  out.pos = camera.viewProj * vec4<f32>(position, 1.0);
  out.color = col;
  out.normal = normal;
  out.worldPos = position;
  return out;
}

/** Per terrain chunk (instance index): push-back along the view ray (m), see terrainLod.ts. */
@group(1) @binding(0) var<storage, read> chunkPushBack: array<f32>;

/**
 * Chunked terrain: a chunk drawn coarser than the grid is moved away from the
 * eye by its height error, so it stays behind the points of the true surface.
 * The move follows the view ray: the vertex keeps its pixel, chunks pushed by
 * different amounts still join on screen.
 */
@vertex
fn terrain_lod_vs(
  @builtin(instance_index) chunk: u32,
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) col: vec4<f32>,
) -> TerrainVsOut {
  let toVertex = position - camera.cameraPos.xyz;
  let pushed = position + toVertex * (chunkPushBack[chunk] / max(length(toVertex), 1e-3));
  var out: TerrainVsOut;
  out.pos = camera.viewProj * vec4<f32>(pushed, 1.0);
  out.color = col;
  out.normal = normal;
  out.worldPos = position;
  return out;
}

${WGSL_OVERLAY_HELPERS}
${WGSL_COLOR_HELPERS}
${WGSL_LIGHTING_HELPERS}

/**
 * Lit exactly like the ground points (same shadeSurface): the mesh shows
 * between the points, and a different shading drew a dark lattice there on
 * slopes facing away from the sun.
 */
@fragment
fn terrain_fs(in: TerrainVsOut) -> @location(0) vec4<f32> {
  let snowed = applySnow(in.color.rgb, in.worldPos);
  let sloped = applySlope(snowed, in.normal);
  let altituded = applyAltitude(sloped, in.worldPos);
  let colored = applySunlightMap(altituded, in.worldPos);
  return vec4<f32>(shadeSurface(normalize(in.normal), colored, in.worldPos), in.color.a);
}

struct TerrainPhotoOut {
  @location(0) albedo: vec4<f32>,
  @location(1) material: vec4<f32>,
};

/** Photo mode G-buffer: the same colours without lighting, class 2 (ground). */
@fragment
fn terrain_photo_fs(in: TerrainVsOut) -> TerrainPhotoOut {
  let snowed = applySnow(in.color.rgb, in.worldPos);
  let sloped = applySlope(snowed, in.normal);
  let altituded = applyAltitude(sloped, in.worldPos);
  var out: TerrainPhotoOut;
  out.albedo = vec4<f32>(applySunlightMap(altituded, in.worldPos), 1.0);
  out.material = vec4<f32>(2.0 / 255.0, 0.0, 0.0, 1.0);
  return out;
}
`;
