// ============================================
// Outils WebGL 2 du backend WebGL : programmes, textures, buffers
// ============================================

import { PASS_TEXTURE_UNITS, SCENE_TEXTURE_UNITS, UBO_BINDING } from './glShaders';

function compileShader(gl: WebGL2RenderingContext, type: number, source: string, label: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`createShader failed (${label})`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compile failed (${label}): ${log}`);
  }
  return shader;
}

/**
 * Compile et lie un programme, lie ses blocs d'uniforms et ses samplers aux
 * liaisons/unités fixes (`UBO_BINDING`, `SCENE_TEXTURE_UNITS`,
 * `PASS_TEXTURE_UNITS`). `feedbackVaryings` : sorties capturées par transform
 * feedback (un buffer chacune).
 */
export function createGlProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  label: string,
  feedbackVaryings?: readonly string[],
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource, `${label} vs`);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label} fs`);
  const program = gl.createProgram();
  if (!program) throw new Error(`createProgram failed (${label})`);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  if (feedbackVaryings) gl.transformFeedbackVaryings(program, feedbackVaryings as string[], gl.SEPARATE_ATTRIBS);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    const log = gl.getProgramInfoLog(program) ?? '';
    gl.deleteProgram(program);
    throw new Error(`WebGL program link failed (${label}): ${log}`);
  }

  const blocks: Record<string, number> = { Scene: UBO_BINDING.scene, NodeParams: UBO_BINDING.node, PointParams: UBO_BINDING.pointParams };
  for (const [name, binding] of Object.entries(blocks)) {
    const index = gl.getUniformBlockIndex(program, name);
    if (index !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, index, binding);
  }
  gl.useProgram(program);
  for (const [name, unit] of Object.entries({ ...SCENE_TEXTURE_UNITS, ...PASS_TEXTURE_UNITS })) {
    const location = gl.getUniformLocation(program, name);
    if (location) gl.uniform1i(location, unit);
  }
  gl.useProgram(null);
  return program;
}

export type GlFilter = 'linear' | 'nearest';

/** Texture 2D à stockage immuable, bornée, sans mipmaps (complète pour `texelFetch`). */
function allocateTexture(
  gl: WebGL2RenderingContext,
  internalFormat: number,
  width: number,
  height: number,
  filter: GlFilter,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, Math.max(1, width), Math.max(1, height));
  setTextureFilter(gl, texture, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

export function setTextureFilter(gl: WebGL2RenderingContext, texture: WebGLTexture, filter: GlFilter): void {
  const mode = filter === 'linear' ? gl.LINEAR : gl.NEAREST;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mode);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mode);
}

/** État pixel-store pour l'envoi de tableaux CPU sans bourrage. */
function prepareUpload(gl: WebGL2RenderingContext): void {
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
}

/** Grille r32float lue avec `texelFetch` (heightmap, hauteur de neige, ombre portée). */
export function createFloatTexture(gl: WebGL2RenderingContext, width: number, height: number, data: Float32Array): WebGLTexture {
  const texture = allocateTexture(gl, gl.R32F, width, height, 'nearest');
  prepareUpload(gl);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.FLOAT, data);
  return texture;
}

export function createRgbaTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  data: Uint8Array,
  filter: GlFilter = 'nearest',
): WebGLTexture {
  const texture = allocateTexture(gl, gl.RGBA8, width, height, filter);
  prepareUpload(gl);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return texture;
}

export function writeRgbaTexture(gl: WebGL2RenderingContext, texture: WebGLTexture, width: number, height: number, data: Uint8Array): void {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  prepareUpload(gl);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
}

/** Texture cible de rendu (couleur ou profondeur), filtrée comme indiqué. */
export function createTargetTexture(
  gl: WebGL2RenderingContext,
  internalFormat: number,
  width: number,
  height: number,
  filter: GlFilter,
): WebGLTexture {
  return allocateTexture(gl, internalFormat, width, height, filter);
}

/**
 * Grille rééchantillonnée (nœud le plus proche) à au plus `maxSize` nœuds par
 * côté : WebGL 2 ne garantit que 2048 texels par côté (WebGPU 8192). Les shaders
 * adressent les grilles par leur étendue de nœud à nœud : le premier et le
 * dernier nœud sont gardés et la grille plus grossière couvre la même emprise.
 */
export function fitGridToTextureSize<T extends Float32Array | Uint8Array>(
  data: T,
  width: number,
  height: number,
  channels: number,
  maxSize: number,
): { data: T; width: number; height: number } {
  if (width <= maxSize && height <= maxSize) return { data, width, height };
  const outW = Math.min(width, maxSize);
  const outH = Math.min(height, maxSize);
  const out = new (data.constructor as new (length: number) => T)(outW * outH * channels);
  const node = (i: number, outCount: number, count: number) => (outCount > 1 ? Math.round((i * (count - 1)) / (outCount - 1)) : 0);
  for (let y = 0; y < outH; y++) {
    const srcRow = node(y, outH, height) * width;
    for (let x = 0; x < outW; x++) {
      const src = (srcRow + node(x, outW, width)) * channels;
      const dst = (y * outW + x) * channels;
      for (let c = 0; c < channels; c++) out[dst + c] = data[src + c]!;
    }
  }
  return { data: out, width: outW, height: outH };
}

export function createStaticBuffer(gl: WebGL2RenderingContext, target: number, data: ArrayBufferView): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error('createBuffer failed');
  // La liaison de l'element array appartient au vertex array object lié.
  if (target === gl.ELEMENT_ARRAY_BUFFER) gl.bindVertexArray(null);
  gl.bindBuffer(target, buffer);
  gl.bufferData(target, data, gl.STATIC_DRAW);
  // Un buffer laissé lié à ARRAY_BUFFER ne peut pas être écrit par transform feedback.
  gl.bindBuffer(target, null);
  return buffer;
}
