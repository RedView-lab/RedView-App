// Terrain program: textured + lit heightmap with snow, slope / altitude ramps,
// cast shadows, cumulative sunlight map and astronomical sun lighting.

export const VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;

uniform mat4 u_viewProj;
uniform float u_elevationExaggeration;

out vec3 v_normal;
out vec2 v_uv;
out vec3 v_worldPos;

void main() {
  v_normal = normalize(vec3(a_normal.x, a_normal.y / max(u_elevationExaggeration, 0.001), a_normal.z));
  v_uv = a_uv;
  vec3 pos = vec3(a_pos.x, a_pos.y * u_elevationExaggeration, a_pos.z);
  v_worldPos = pos;
  gl_Position = u_viewProj * vec4(pos, 1.0);
}
`;

export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

in vec3 v_normal;
in vec2 v_uv;
in vec3 v_worldPos;

uniform sampler2D u_ortho;
uniform sampler2D u_snow;          // R32F snow depth in cm (NEAREST sampling)
uniform sampler2D u_slopeRamp;     // 1D/2D LUT (256x1 RGBA) for slope colorization
uniform sampler2D u_altitudeRamp;  // 1D/2D LUT (512x1 RGBA) for altitude colorization
uniform sampler2D u_shadowMap;     // R8 (0 = lit, 255 = cast shadow)
uniform sampler2D u_sunlightMap;   // RGBA (cumulative sunshine map)

uniform vec3 u_sunDir;             // already normalised, points FROM surface TO sun
uniform vec3 u_sunColor;           // physical sun color from solar altitude
uniform float u_sunIntensity;      // 0.0 (night) to 1.0 (noon)
uniform vec3 u_skyColor;           // ambient sky tint
uniform float u_exposure;
uniform int u_sunlightEnabled;     // 0=off, 1=on

uniform int u_shadowEnabled;       // 0=off, 1=on
uniform float u_shadowOpacity;     // 0.0 to 1.0
uniform int u_sunlightMapEnabled;  // 0=off, 1=on
uniform float u_sunlightMapOpacity;// 0.0 to 1.0

uniform int u_snowMode;            // 0=off, 1=cover, 2=thickness
uniform vec2 u_snowOrigin;         // (originX, originZ) in renderer space
uniform vec2 u_snowScale;          // (scaleX,  scaleZ)  in renderer space
uniform vec2 u_terrainOrigin;      // (originX, originZ) for grid-aligned maps
uniform vec2 u_terrainScale;       // (scaleX,  scaleZ)  for grid-aligned maps

uniform int u_slopeEnabled;        // 0=off, 1=on
uniform float u_slopeOpacity;      // 0.0 to 1.0
uniform int u_altitudeEnabled;     // 0=off, 1=on
uniform float u_altitudeOpacity;   // 0.0 to 1.0
uniform float u_centerAltitude;    // center elevation in meters
uniform float u_maxAltitude;       // max elevation scale (default 5000.0)
uniform float u_elevationExaggeration;

out vec4 fragColor;

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
}

// Shadow / sunlight maps are node grids spanning the terrain bounds edge to
// edge: map uv 0..1 onto the first..last texel centres before filtering.
vec2 nodeGridUV(vec2 uv, ivec2 dims) {
  vec2 n = vec2(dims);
  return (clamp(uv, 0.0, 1.0) * (n - 1.0) + 0.5) / n;
}

float sampleSnowDepthCm() {
  if (u_snowMode == 0) return 0.0;
  vec2 uv = (v_worldPos.xz - u_snowOrigin) / u_snowScale;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
  ivec2 dims = textureSize(u_snow, 0);
  ivec2 px = clamp(ivec2(uv * vec2(dims)), ivec2(0), dims - ivec2(1));
  return texelFetch(u_snow, px, 0).r;
}

vec3 snowThicknessColor(float depthCm) {
  float t = clamp(depthCm / 200.0, 0.0, 1.0);
  float r = clamp(1.6 * t - 0.4, 0.0, 1.0);
  float g = clamp(1.0 - abs(t - 0.55) * 2.2, 0.0, 1.0);
  float b = clamp(1.0 - t * 1.4 + 0.15, 0.0, 1.0);
  return vec3(r, g, b);
}

vec3 applySnow(vec3 baseSrgb) {
  if (u_snowMode == 0) return baseSrgb;
  float depth = sampleSnowDepthCm();
  if (u_snowMode == 2) {
    if (depth <= 0.5) return baseSrgb * 0.35;
    return snowThicknessColor(depth);
  }
  // cover
  float t = smoothstep(0.0, 30.0, depth) * 0.93;
  return mix(baseSrgb, vec3(0.97, 0.98, 1.0), t);
}

void main() {
  vec3 base = texture(u_ortho, v_uv).rgb;
  vec3 tinted = applySnow(base);

  vec3 N = normalize(v_normal);

  // Surface slope angle in degrees, from the real (un-exaggerated) normal:
  // v_normal carries the vertical exaggeration for shading only.
  if (u_slopeEnabled == 1 && u_slopeOpacity > 0.0) {
    vec3 terrainN = normalize(vec3(N.x, N.y * u_elevationExaggeration, N.z));
    float cosSlope = clamp(terrainN.y, 0.0, 1.0);
    float slopeDeg = acos(cosSlope) * 57.29577951308232;
    float slopeU = clamp(slopeDeg / 90.0, 0.0, 1.0);
    vec4 slopeSample = texture(u_slopeRamp, vec2(slopeU, 0.5));
    if (slopeSample.a > 0.0) {
      tinted = mix(tinted, slopeSample.rgb, slopeSample.a * u_slopeOpacity);
    }
  }

  // Altitude colorization
  if (u_altitudeEnabled == 1 && u_altitudeOpacity > 0.0) {
    float realAltitude = (v_worldPos.y / max(u_elevationExaggeration, 0.001)) + u_centerAltitude;
    float altU = clamp(realAltitude / u_maxAltitude, 0.0, 1.0);
    vec4 altSample = texture(u_altitudeRamp, vec2(altU, 0.5));
    if (altSample.a > 0.0) {
      tinted = mix(tinted, altSample.rgb, altSample.a * u_altitudeOpacity);
    }
  }

  // Cumulative sunlight map (insolation) overlay
  vec2 gridUV = (v_worldPos.xz - u_terrainOrigin) / u_terrainScale;
  if (u_sunlightEnabled == 1 && u_sunlightMapEnabled == 1 && u_sunlightMapOpacity > 0.0) {
    if (all(greaterThanEqual(gridUV, vec2(0.0))) && all(lessThanEqual(gridUV, vec2(1.0)))) {
      vec4 smSample = texture(u_sunlightMap, nodeGridUV(gridUV, textureSize(u_sunlightMap, 0)));
      if (smSample.a > 0.0) {
        tinted = mix(tinted, smSample.rgb, smSample.a * u_sunlightMapOpacity);
      }
    }
  }

  vec3 baseLin = srgbToLinear(tinted);

  float ndotl = clamp(dot(N, u_sunDir), 0.0, 1.0);

  // Cast shadow sampling
  float castShadow = 0.0;
  if (u_sunlightEnabled == 1 && u_shadowEnabled == 1 && u_shadowOpacity > 0.0) {
    if (all(greaterThanEqual(gridUV, vec2(0.0))) && all(lessThanEqual(gridUV, vec2(1.0)))) {
      castShadow = texture(u_shadowMap, nodeGridUV(gridUV, textureSize(u_shadowMap, 0))).r;
    }
  }

  if (u_sunlightEnabled == 1) {
    // Physical Sun Lighting
    // Direct sunlight factor: self-shadow (ndotl) + cast shadow
    float directLit = ndotl * (1.0 - castShadow) * u_sunIntensity;

    // At shadowOpacity = 100% (1.0), all light (direct + ambient) in shadowed areas is fully extinguished to pure black (noir noir)
    float shadowDarkness = u_shadowOpacity;
    float shadowMask = clamp(1.0 - (1.0 - directLit) * shadowDarkness, 0.0, 1.0);

    vec3 directSun = baseLin * u_sunColor * directLit;
    float upFacing = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 ambientBase = baseLin * u_skyColor * (0.18 + 0.22 * upFacing);

    vec3 lit = (directSun + ambientBase * shadowMask) * u_exposure;
    fragColor = vec4(linearToSrgb(lit), 1.0);
  } else {

    // Default studio directional lighting
    float wrap = ndotl * 0.5 + 0.5;
    vec3 sunLight = baseLin * wrap;

    float upFacing = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 ambient = baseLin * u_skyColor * (0.18 + 0.22 * upFacing);

    vec3 lit = (sunLight * 0.85 + ambient) * u_exposure;
    fragColor = vec4(linearToSrgb(lit), 1.0);
  }
}
`;
