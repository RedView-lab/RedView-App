// ============================================
// WGSL Shader Components — Terrain Mesh Shader
// ============================================

import {
  WGSL_CAMERA_STRUCT,
  WGSL_COLOR_HELPERS,
  WGSL_OVERLAY_HELPERS,
  WGSL_TERRAIN_BINDINGS,
} from './common';

export const TERRAIN_SHADER = /* wgsl */ `
${WGSL_CAMERA_STRUCT}
${WGSL_TERRAIN_BINDINGS}

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

${WGSL_OVERLAY_HELPERS}
${WGSL_COLOR_HELPERS}

@fragment
fn terrain_fs(in: TerrainVsOut) -> @location(0) vec4<f32> {
  let snowed = applySnow(in.color.rgb, in.worldPos);
  let sloped = applySlope(snowed, in.normal);
  let altituded = applyAltitude(sloped, in.worldPos);
  let colored = applySunlightMap(altituded, in.worldPos);

  let n = normalize(in.normal);
  let L = normalize(camera.sunDir.xyz);
  let ndotl = clamp(dot(n, L), 0.0, 1.0);

  if (camera.sunlightEnabled > 0.5) {
    let baseColor = srgbToLinear(colored);
    let castShadow = sampleCastShadow(in.worldPos);
    let directLit = ndotl * (1.0 - castShadow) * camera.sunIntensity;
    let shadowDarkness = camera.shadowOpacity;
    let shadowMask = clamp(1.0 - (1.0 - directLit) * shadowDarkness, 0.0, 1.0);
    let directSun = baseColor * camera.sunColor.rgb * directLit;
    let upFacing = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
    let ambientBase = baseColor * camera.skyColor.rgb * (0.18 + 0.22 * upFacing);
    let lit = (directSun + ambientBase * shadowMask) * camera.exposure;
    return vec4<f32>(linearToSrgb(lit), in.color.a);
  }

  let diffuse = ndotl * 0.7 + 0.3;
  return vec4<f32>(colored * diffuse, in.color.a);
}
`;
