function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || '';
    gl.deleteShader(sh);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return sh;
}

/**
 * Compile et lie un programme. `verifyLink` lève une erreur avec le journal
 * quand l'édition de liens échoue (les programmes auxiliaires sautent la
 * vérification, comme ils l'ont toujours fait).
 */
export function createProgram(
  gl: WebGL2RenderingContext,
  vertexSrc: string,
  fragmentSrc: string,
  label: string,
  { verifyLink = false }: { verifyLink?: boolean } = {},
): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error(`createProgram for ${label} failed`);
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (verifyLink && !gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) || '';
    gl.deleteProgram(prog);
    throw new Error(`Program link failed: ${log}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

/** Texture provisoire 1×1 (bornée), liée à un sampler jusqu'à l'arrivée des vraies données. */
export function createPlaceholderTexture(
  gl: WebGL2RenderingContext,
  internalFormat: number,
  format: number,
  type: number,
  pixel: ArrayBufferView,
  filter: number,
): WebGLTexture | null {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 1, 1, 0, format, type, pixel);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

export function mustLoc(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string): WebGLUniformLocation {
  const loc = gl.getUniformLocation(prog, name);
  if (!loc) throw new Error(`Uniform ${name} not found`);
  return loc;
}

export function normalize3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}
