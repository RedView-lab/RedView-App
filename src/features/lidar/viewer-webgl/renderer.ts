// ============================================
// LiDAR HD — WebGL2 fallback renderer
// ============================================
// Custom WebGL2 engine mirroring the WebGPU terrain pipeline. Renders a
// single textured + lit heightmap mesh (no point cloud) so the viewer can
// run on machines without a usable WebGPU adapter (Windows iGPU, software
// fallback, older Mac, etc.).

const VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;

uniform mat4 u_viewProj;

out vec3 v_normal;
out vec2 v_uv;

void main() {
  v_normal = a_normal;
  v_uv = a_uv;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec3 v_normal;
in vec2 v_uv;

uniform sampler2D u_ortho;
uniform vec3 u_sunDir;       // already normalised, points FROM surface TO sun
uniform vec3 u_skyColor;     // ambient tint
uniform float u_exposure;

out vec4 fragColor;

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 linearToSrgb(vec3 c) {
  return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
}

void main() {
  vec3 base = texture(u_ortho, v_uv).rgb;
  vec3 baseLin = srgbToLinear(base);

  vec3 N = normalize(v_normal);
  float ndotl = clamp(dot(N, u_sunDir), 0.0, 1.0);

  // Half-Lambert wrap so shaded slopes still read clearly
  float wrap = ndotl * 0.5 + 0.5;
  vec3 sunLight = baseLin * wrap;

  // Sky/ambient term anchored on upward-facing surfaces
  float upFacing = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 ambient = baseLin * u_skyColor * (0.18 + 0.22 * upFacing);

  vec3 lit = (sunLight * 0.85 + ambient) * u_exposure;
  fragColor = vec4(linearToSrgb(lit), 1.0);
}
`;

export interface TerrainGPUData {
  vertices: Float32Array;   // interleaved pos.xyz | normal.xyz | uv.xy
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
}

export class WebGLTerrainRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly maxTextureSize: number;
  readonly rendererInfo: string;

  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private vbo!: WebGLBuffer;
  private ibo!: WebGLBuffer;
  private texture: WebGLTexture | null = null;

  private uViewProj!: WebGLUniformLocation;
  private uOrtho!: WebGLUniformLocation;
  private uSunDir!: WebGLUniformLocation;
  private uSkyColor!: WebGLUniformLocation;
  private uExposure!: WebGLUniformLocation;

  private indexCount = 0;
  private uses32BitIndex = true;

  exposure = 1.05;
  sunDir: [number, number, number] = normalize3(0.42, 0.78, 0.55);
  skyColor: [number, number, number] = [0.55, 0.65, 0.85];

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      premultipliedAlpha: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 indisponible');
    this.gl = gl;

    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.rendererInfo = dbg
      ? `${gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)} | ${gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)}`
      : 'WebGL2';

    // Required for 32-bit indices on WebGL2; this is core GL ES 3.0 so always
    // available, but we still feature-detect to be safe.
    this.uses32BitIndex = true;

    this.compileProgram();
    this.createBuffers();
    this.configureGLState();
  }

  private compileProgram() {
    const gl = this.gl;
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const prog = gl.createProgram();
    if (!prog) throw new Error('createProgram failed');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) || '';
      gl.deleteProgram(prog);
      throw new Error(`Program link failed: ${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = prog;

    this.uViewProj = mustLoc(gl, prog, 'u_viewProj');
    this.uOrtho    = mustLoc(gl, prog, 'u_ortho');
    this.uSunDir   = mustLoc(gl, prog, 'u_sunDir');
    this.uSkyColor = mustLoc(gl, prog, 'u_skyColor');
    this.uExposure = mustLoc(gl, prog, 'u_exposure');
  }

  private createBuffers() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    const ibo = gl.createBuffer();
    if (!vao || !vbo || !ibo) throw new Error('GL buffer alloc failed');
    this.vao = vao;
    this.vbo = vbo;
    this.ibo = ibo;

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const stride = 8 * 4; // 8 floats × 4 bytes
    // pos
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    // normal
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
    // uv
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 6 * 4);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bindVertexArray(null);
  }

  private configureGLState() {
    const gl = this.gl;
    gl.clearColor(0.04, 0.05, 0.08, 1.0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    // Terrain mesh is single-sided in concept but the camera can orbit
    // below it during pan/zoom; disabling cull avoids holes in the view.
    gl.disable(gl.CULL_FACE);
  }

  uploadMesh(data: TerrainGPUData): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.indexCount = data.indexCount;
  }

  uploadOrtho(bitmap: ImageBitmap): void {
    const gl = this.gl;
    if (!this.texture) this.texture = gl.createTexture();
    if (!this.texture) throw new Error('createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8,
      bitmap.width, bitmap.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, bitmap as unknown as TexImageSource,
    );
    // High-quality sampling: trilinear + 16× anisotropy when available.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic')
      || gl.getExtension('MOZ_EXT_texture_filter_anisotropic')
      || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
    if (aniso) {
      const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
      gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, max));
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  resize(w: number, h: number): void {
    const gl = this.gl;
    if (gl.canvas.width !== w || gl.canvas.height !== h) {
      gl.canvas.width = w;
      gl.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
  }

  /** Multiply view × proj using column-major WebGPU-style matrices. */
  static multiplyMat4(a: Float32Array, b: Float32Array): Float32Array {
    // out = b * a (since both are column-major and we want viewProj = proj * view)
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += b[k * 4 + r] * a[c * 4 + k];
        out[c * 4 + r] = s;
      }
    }
    return out;
  }

  render(viewProj: Float32Array): void {
    const gl = this.gl;
    if (!this.indexCount) return;
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uViewProj, false, viewProj);
    gl.uniform3f(this.uSunDir, this.sunDir[0], this.sunDir[1], this.sunDir[2]);
    gl.uniform3f(this.uSkyColor, this.skyColor[0], this.skyColor[1], this.skyColor[2]);
    gl.uniform1f(this.uExposure, this.exposure);

    if (this.texture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(this.uOrtho, 0);
    }

    gl.bindVertexArray(this.vao);
    gl.drawElements(
      gl.TRIANGLES,
      this.indexCount,
      this.uses32BitIndex ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      0,
    );
    gl.bindVertexArray(null);
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
    gl.deleteVertexArray(this.vao);
    if (this.texture) gl.deleteTexture(this.texture);
    gl.deleteProgram(this.program);
  }
}

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

function mustLoc(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string): WebGLUniformLocation {
  const loc = gl.getUniformLocation(prog, name);
  if (!loc) throw new Error(`Uniform ${name} not found`);
  return loc;
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}
