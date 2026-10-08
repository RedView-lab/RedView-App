// Programmes auxiliaires : maillage d'aperçu (terrain grossier pendant le
// chargement), polyligne de la trajectoire du soleil, ruban du tracé GPX et
// billboard du disque solaire.

export const PREVIEW_VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec4 a_color;

uniform mat4 u_viewProj;
uniform float u_elevationExaggeration;

out vec3 v_normal;
out vec4 v_color;

void main() {
  v_normal = normalize(vec3(a_normal.x, a_normal.y / max(u_elevationExaggeration, 0.001), a_normal.z));
  v_color = a_color;
  vec3 pos = vec3(a_pos.x, a_pos.y * u_elevationExaggeration, a_pos.z);
  gl_Position = u_viewProj * vec4(pos, 1.0);
}
`;

export const PREVIEW_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec3 v_normal;
in vec4 v_color;

uniform vec3 u_sunDir;
out vec4 fragColor;

void main() {
  float diff = max(dot(v_normal, u_sunDir), 0.0);
  float light = 0.6 + 0.4 * diff;
  fragColor = vec4(v_color.rgb * light, v_color.a);
}
`;

export const TRAJECTORY_VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec4 a_color;

uniform mat4 u_viewProj;
out vec4 v_color;

void main() {
  v_color = a_color;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}
`;

export const TRAJECTORY_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec4 v_color;
out vec4 fragColor;

void main() {
  fragColor = v_color;
}
`;

export const ROUTE_VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec4 a_color;

uniform mat4 u_viewProj;
out vec4 v_color;

void main() {
  v_color = a_color;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}
`;

export const ROUTE_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec4 v_color;
out vec4 fragColor;

void main() {
  fragColor = v_color;
}
`;

export const SUN_DISC_VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_quadPos;

uniform mat4 u_viewProj;
uniform vec3 u_sunDiscPos;
uniform float u_sunDiscRadius;
uniform vec3 u_camRight;
uniform vec3 u_camUp;

out vec2 v_localPos;

void main() {
  v_localPos = a_quadPos;
  vec3 worldPos = u_sunDiscPos + (a_quadPos.x * u_camRight + a_quadPos.y * u_camUp) * u_sunDiscRadius;
  gl_Position = u_viewProj * vec4(worldPos, 1.0);
}
`;

export const SUN_DISC_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_localPos;
uniform vec3 u_sunColor;
uniform float u_sunIntensity;

out vec4 fragColor;

void main() {
  float dist = length(v_localPos);
  if (dist > 1.0) discard;

  float core = smoothstep(0.35, 0.05, dist);
  float corona = exp(-dist * 4.5) * 0.75;
  float glow = exp(-dist * 2.0) * 0.35;
  float brightness = clamp(core + corona + glow, 0.0, 1.0) * max(u_sunIntensity, 0.15);

  vec3 white = vec3(1.0, 1.0, 0.98);
  vec3 col = mix(u_sunColor, white, core);
  fragColor = vec4(col * brightness, brightness);
}
`;
