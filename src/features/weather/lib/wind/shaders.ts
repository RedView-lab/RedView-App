import type { ParticleProgram, SavedGLState } from './types';

// ── GLSL Vertex Shader ─────────────────────────────────────────────────

export const VERTEX_SHADER = `
precision highp float;

attribute vec3 a_position;
attribute vec4 a_color;

uniform mat4 u_matrix;

varying vec4 v_color;

void main() {
    gl_Position = u_matrix * vec4(a_position, 1.0);
    // Depth bias: push arrows slightly toward camera to prevent Z-fighting with terrain
    gl_Position.z -= 0.0015 * gl_Position.w;
    v_color = a_color;
}
`;

// ── GLSL Fragment Shader ───────────────────────────────────────────────

export const FRAGMENT_SHADER = `
precision mediump float;

varying vec4 v_color;

void main() {
    gl_FragColor = v_color;
}
`;

// ── Shader compilation ─────────────────────────────────────────────────

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Unable to create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Shader compilation failed';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

export function createWindProgram(gl: WebGL2RenderingContext): ParticleProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('Unable to create GL program');

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'Program link failed';
    gl.deleteProgram(program);
    throw new Error(message);
  }

  return {
    program,
    a_position: gl.getAttribLocation(program, 'a_position'),
    a_color: gl.getAttribLocation(program, 'a_color'),
    u_matrix: gl.getUniformLocation(program, 'u_matrix'),
  };
}

// ── GL state save / restore ────────────────────────────────────────────
// Mapbox shares a single WebGL context — we must restore every piece of
// state we touch to avoid corrupting map tile rendering.

export function saveGLState(gl: WebGL2RenderingContext, attribs: number[]): SavedGLState {
  return {
    blend: gl.isEnabled(gl.BLEND),
    depthTest: gl.isEnabled(gl.DEPTH_TEST),
    stencilTest: gl.isEnabled(gl.STENCIL_TEST),
    scissorTest: gl.isEnabled(gl.SCISSOR_TEST),
    cullFace: gl.isEnabled(gl.CULL_FACE),
    depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
    blendSrcRgb: gl.getParameter(gl.BLEND_SRC_RGB),
    blendDstRgb: gl.getParameter(gl.BLEND_DST_RGB),
    blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA),
    blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
    blendEquationRgb: gl.getParameter(gl.BLEND_EQUATION_RGB),
    blendEquationAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA),
    activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE),
    program: gl.getParameter(gl.CURRENT_PROGRAM),
    framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING),
    arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
    viewport: gl.getParameter(gl.VIEWPORT),
    attribEnabled: attribs.map((a) =>
      a >= 0 ? Boolean(gl.getVertexAttrib(a, gl.VERTEX_ATTRIB_ARRAY_ENABLED)) : false,
    ),
    polygonOffsetFill: gl.isEnabled(gl.POLYGON_OFFSET_FILL),
    polygonOffsetFactor: gl.getParameter(gl.POLYGON_OFFSET_FACTOR),
    polygonOffsetUnits: gl.getParameter(gl.POLYGON_OFFSET_UNITS),
  };
}

export function restoreGLState(gl: WebGL2RenderingContext, state: SavedGLState, attribs: number[]): void {
  if (state.blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
  if (state.depthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
  if (state.stencilTest) gl.enable(gl.STENCIL_TEST); else gl.disable(gl.STENCIL_TEST);
  if (state.scissorTest) gl.enable(gl.SCISSOR_TEST); else gl.disable(gl.SCISSOR_TEST);
  if (state.cullFace) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);

  gl.depthMask(state.depthMask);
  gl.blendFuncSeparate(state.blendSrcRgb, state.blendDstRgb, state.blendSrcAlpha, state.blendDstAlpha);
  gl.blendEquationSeparate(state.blendEquationRgb, state.blendEquationAlpha);
  gl.useProgram(state.program);
  gl.bindFramebuffer(gl.FRAMEBUFFER, state.framebuffer);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.arrayBuffer);
  gl.viewport(state.viewport[0], state.viewport[1], state.viewport[2], state.viewport[3]);
  gl.activeTexture(state.activeTexture);

  if (state.polygonOffsetFill) gl.enable(gl.POLYGON_OFFSET_FILL); else gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.polygonOffset(state.polygonOffsetFactor, state.polygonOffsetUnits);

  for (let i = 0; i < attribs.length; i++) {
    const attrib = attribs[i];
    if (attrib < 0) continue;
    if (state.attribEnabled[i]) gl.enableVertexAttribArray(attrib);
    else gl.disableVertexAttribArray(attrib);
  }
}
