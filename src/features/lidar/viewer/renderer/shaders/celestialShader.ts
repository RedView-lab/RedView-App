// ============================================
// WGSL Shader Components — Celestial & Trajectory Shaders
// ============================================

import { WGSL_CAMERA_STRUCT } from './common';

export const TRAJECTORY_SHADER = /* wgsl */ `
struct Camera {
  viewProj: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;

struct TrajectoryIn {
  @location(0) pos: vec3<f32>,
  @location(1) color: vec4<f32>,
};

struct TrajectoryOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn trajectory_vs(in: TrajectoryIn) -> TrajectoryOut {
  var out: TrajectoryOut;
  out.pos = camera.viewProj * vec4<f32>(in.pos, 1.0);
  out.color = in.color;
  return out;
}

@fragment
fn trajectory_fs(in: TrajectoryOut) -> @location(0) vec4<f32> {
  return in.color;
}
`;

export const SUN_DISC_SHADER = /* wgsl */ `
${WGSL_CAMERA_STRUCT}

@group(0) @binding(0) var<uniform> camera: Camera;

struct SunDiscOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) localUV: vec2<f32>,
};

@vertex
fn sun_disc_vs(@builtin(vertex_index) vi: u32) -> SunDiscOut {
  var out: SunDiscOut;
  var uv = vec2<f32>(-1.0, -1.0);
  if (vi == 1u || vi == 4u) {
    uv = vec2<f32>(1.0, -1.0);
  } else if (vi == 2u || vi == 3u) {
    uv = vec2<f32>(-1.0, 1.0);
  } else if (vi == 5u) {
    uv = vec2<f32>(1.0, 1.0);
  }
  out.localUV = uv;

  let worldPos = camera.sunDiscPos + (uv.x * camera.right.xyz + uv.y * camera.up.xyz) * camera.sunDiscRadius;
  out.pos = camera.viewProj * vec4<f32>(worldPos, 1.0);
  return out;
}

@fragment
fn sun_disc_fs(in: SunDiscOut) -> @location(0) vec4<f32> {
  let dist = length(in.localUV);
  if (dist > 1.0) {
    discard;
  }

  let core = smoothstep(0.35, 0.05, dist);
  let corona = exp(-dist * 4.5) * 0.75;
  let glow = exp(-dist * 2.0) * 0.35;
  let brightness = clamp(core + corona + glow, 0.0, 1.0) * max(camera.sunIntensity, 0.15);

  let white = vec3<f32>(1.0, 1.0, 0.98);
  let col = mix(camera.sunColor.rgb, white, core);
  return vec4<f32>(col * brightness, brightness);
}
`;
