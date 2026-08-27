// ============================================
// WGSL Shader Components — 3D GPX Route Ribbon Shader
// ============================================

export const ROUTE_SHADER = /* wgsl */ `
struct Camera {
  viewProj: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;

struct RouteIn {
  @location(0) pos: vec3<f32>,
  @location(1) color: vec4<f32>,
};

struct RouteOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn route_vs(in: RouteIn) -> RouteOut {
  var out: RouteOut;
  out.pos = camera.viewProj * vec4<f32>(in.pos, 1.0);
  out.color = in.color;
  return out;
}

@fragment
fn route_fs(in: RouteOut) -> @location(0) vec4<f32> {
  return in.color;
}
`;
