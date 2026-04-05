struct Uniforms {
  projMatrix: mat4x4<f32>,
  viewportSize: vec2<f32>,
  pointSize: f32,
  opacity: f32,
  originX: f32,
  originY: f32,
  originZ: f32,
  _pad0: f32,
  sunDir: vec3<f32>,
  _pad1: f32,
  cameraPos: vec3<f32>,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexInput {
  @location(0) quadOffset: vec2<f32>,
  @location(1) position: vec3<f32>,
  @location(2) color: vec3<f32>,
  @location(3) normal: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) vColor: vec3<f32>,
  @location(1) vNormal: vec3<f32>,
  @location(2) vUV: vec2<f32>,
  @location(3) vWorldPos: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;

  let worldPos = input.position - vec3<f32>(u.originX, u.originY, u.originZ);
  let clipPos = u.projMatrix * vec4<f32>(worldPos, 1.0);

  let aspect = u.viewportSize.x / u.viewportSize.y;
  let offsetX = input.quadOffset.x * u.pointSize / u.viewportSize.x * 2.0;
  let offsetY = input.quadOffset.y * u.pointSize / u.viewportSize.y * 2.0;

  out.clipPos = vec4<f32>(
    clipPos.x + offsetX * clipPos.w,
    clipPos.y + offsetY * clipPos.w,
    clipPos.z,
    clipPos.w
  );
  out.vColor = input.color;
  out.vNormal = input.normal;
  out.vUV = input.quadOffset;
  out.vWorldPos = worldPos;

  return out;
}

fn srgbToLinear(c: f32) -> f32 {
  if (c <= 0.04045) {
    return c / 12.92;
  }
  return pow((c + 0.055) / 1.055, 2.4);
}

fn linearToSrgb(c: f32) -> f32 {
  if (c <= 0.0031308) {
    return c * 12.92;
  }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let dist2 = dot(input.vUV, input.vUV);
  if (dist2 > 1.0) {
    discard;
  }

  let edge = 1.0 - smoothstep(0.7, 1.0, sqrt(dist2));

  let r = srgbToLinear(input.vColor.x);
  let g = srgbToLinear(input.vColor.y);
  let b = srgbToLinear(input.vColor.z);
  let baseColor = vec3<f32>(r, g, b);

  let N = normalize(input.vNormal);
  let L = normalize(u.sunDir);
  let V = normalize(u.cameraPos - input.vWorldPos);
  let H = normalize(L + V);

  let NdotL = dot(N, L) * 0.5 + 0.5;
  let diffuse = baseColor * NdotL;

  let specAngle = max(dot(N, H), 0.0);
  let specular = vec3<f32>(0.15) * pow(specAngle, 16.0);

  let ambient = baseColor * 0.15;
  var color = ambient + diffuse * 0.75 + specular;

  color = color / (color + vec3<f32>(1.0));

  let finalR = linearToSrgb(color.x);
  let finalG = linearToSrgb(color.y);
  let finalB = linearToSrgb(color.z);

  return vec4<f32>(finalR, finalG, finalB, u.opacity * edge);
}
