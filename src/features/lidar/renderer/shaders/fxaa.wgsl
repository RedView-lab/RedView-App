@group(0) @binding(0) var sceneTex: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );

  var out: VertexOutput;
  out.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
  out.uv = vec2<f32>(
    (pos[vertexIndex].x + 1.0) * 0.5,
    (1.0 - pos[vertexIndex].y) * 0.5,
  );
  return out;
}

fn luminance(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.299, 0.587, 0.114));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let texSize = vec2<f32>(textureDimensions(sceneTex));
  let rcpFrame = 1.0 / texSize;

  let rgbM = textureSample(sceneTex, sceneSampler, input.uv).rgb;
  let rgbN = textureSample(sceneTex, sceneSampler, input.uv + vec2<f32>(0.0, -rcpFrame.y)).rgb;
  let rgbS = textureSample(sceneTex, sceneSampler, input.uv + vec2<f32>(0.0, rcpFrame.y)).rgb;
  let rgbE = textureSample(sceneTex, sceneSampler, input.uv + vec2<f32>(rcpFrame.x, 0.0)).rgb;
  let rgbW = textureSample(sceneTex, sceneSampler, input.uv + vec2<f32>(-rcpFrame.x, 0.0)).rgb;

  let lumM = luminance(rgbM);
  let lumN = luminance(rgbN);
  let lumS = luminance(rgbS);
  let lumE = luminance(rgbE);
  let lumW = luminance(rgbW);

  let lumMin = min(lumM, min(min(lumN, lumS), min(lumE, lumW)));
  let lumMax = max(lumM, max(max(lumN, lumS), max(lumE, lumW)));
  let lumRange = lumMax - lumMin;

  // Compute edge direction and FXAA samples upfront (uniform control flow required)
  let dirX = -((lumN + lumS) - 2.0 * lumM);
  let dirY = (lumE + lumW) - 2.0 * lumM;

  let dirReduce = max(0.25 * (1.0 / 8.0), (lumN + lumS + lumE + lumW) * 0.25 * (1.0 / 4.0));
  let rcpDirMin = 1.0 / (min(abs(dirX), abs(dirY)) + dirReduce);
  let dir = clamp(
    vec2<f32>(dirX, dirY) * rcpDirMin,
    vec2<f32>(-4.0),
    vec2<f32>(4.0),
  ) * rcpFrame;

  // All textureSample calls must happen before any non-uniform branch
  let sampleA1 = textureSample(sceneTex, sceneSampler, input.uv + dir * (1.0 / 3.0 - 0.5)).rgb;
  let sampleA2 = textureSample(sceneTex, sceneSampler, input.uv + dir * (2.0 / 3.0 - 0.5)).rgb;
  let sampleB1 = textureSample(sceneTex, sceneSampler, input.uv + dir * -0.5).rgb;
  let sampleB2 = textureSample(sceneTex, sceneSampler, input.uv + dir * 0.5).rgb;

  // Early out for low-contrast areas (no edge)
  if (lumRange < max(0.0312, lumMax * 0.125)) {
    return vec4<f32>(rgbM, 1.0);
  }

  let rgbA = 0.5 * (sampleA1 + sampleA2);
  let rgbB = rgbA * 0.5 + 0.25 * (sampleB1 + sampleB2);

  let lumB = luminance(rgbB);
  if (lumB < lumMin || lumB > lumMax) {
    return vec4<f32>(rgbA, 1.0);
  }
  return vec4<f32>(rgbB, 1.0);
}
