// ── WebGL Wind Particle Engine ─────────────────────────────────────────
// TypeScript port of https://github.com/mapbox/webgl-wind (ISC License)
// GPU-accelerated particle animation: positions stored in textures,
// updated via shaders, trails via ping-pong FBOs with fade.
//
// Adapted for Mapbox GL CustomLayerInterface: renders into Mapbox's
// shared WebGL context with proper GL state save/restore.

// ── GLSL Shaders (inline) ──────────────────────────────────────────────

const DRAW_VERT = `
precision mediump float;

attribute float a_index;

uniform sampler2D u_particles;
uniform float u_particles_res;

varying vec2 v_particle_pos;

void main() {
    vec4 color = texture2D(u_particles, vec2(
        fract(a_index / u_particles_res),
        floor(a_index / u_particles_res) / u_particles_res));

    // decode current particle position from the pixel's RGBA value
    v_particle_pos = vec2(
        color.r / 255.0 + color.b,
        color.g / 255.0 + color.a);

    gl_PointSize = 1.0;
    gl_Position = vec4(2.0 * v_particle_pos.x - 1.0, 1.0 - 2.0 * v_particle_pos.y, 0, 1);
}
`;

const DRAW_FRAG = `
precision mediump float;

uniform sampler2D u_wind;
uniform vec2 u_wind_min;
uniform vec2 u_wind_max;
uniform sampler2D u_color_ramp;

varying vec2 v_particle_pos;

void main() {
    vec2 velocity = mix(u_wind_min, u_wind_max, texture2D(u_wind, v_particle_pos).rg);
    float speed_t = length(velocity) / length(u_wind_max);

    // color ramp is encoded in a 16x16 texture
    vec2 ramp_pos = vec2(
        fract(16.0 * speed_t),
        floor(16.0 * speed_t) / 16.0);

    gl_FragColor = texture2D(u_color_ramp, ramp_pos);
}
`;

const QUAD_VERT = `
precision mediump float;

attribute vec2 a_pos;

varying vec2 v_tex_pos;

void main() {
    v_tex_pos = a_pos;
    gl_Position = vec4(1.0 - 2.0 * a_pos, 0, 1);
}
`;

const SCREEN_FRAG = `
precision mediump float;

uniform sampler2D u_screen;
uniform float u_opacity;

varying vec2 v_tex_pos;

void main() {
    vec4 color = texture2D(u_screen, 1.0 - v_tex_pos);
    // a hack to guarantee opacity fade out even with a value close to 1.0
    gl_FragColor = vec4(floor(255.0 * color * u_opacity) / 255.0);
}
`;

const UPDATE_FRAG = `
precision highp float;

uniform sampler2D u_particles;
uniform sampler2D u_wind;
uniform vec2 u_wind_res;
uniform vec2 u_wind_min;
uniform vec2 u_wind_max;
uniform float u_rand_seed;
uniform float u_speed_factor;
uniform float u_drop_rate;
uniform float u_drop_rate_bump;

varying vec2 v_tex_pos;

// pseudo-random generator
const vec3 rand_constants = vec3(12.9898, 78.233, 4375.85453);
float rand(const vec2 co) {
    float t = dot(rand_constants.xy, co);
    return fract(sin(t) * (rand_constants.z + t));
}

// wind speed lookup; use manual bilinear filtering based on 4 adjacent pixels
vec2 lookup_wind(const vec2 uv) {
    vec2 px = 1.0 / u_wind_res;
    vec2 vc = (floor(uv * u_wind_res)) * px;
    vec2 f = fract(uv * u_wind_res);
    vec2 tl = texture2D(u_wind, vc).rg;
    vec2 tr = texture2D(u_wind, vc + vec2(px.x, 0)).rg;
    vec2 bl = texture2D(u_wind, vc + vec2(0, px.y)).rg;
    vec2 br = texture2D(u_wind, vc + px).rg;
    return mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
}

void main() {
    vec4 color = texture2D(u_particles, v_tex_pos);
    vec2 pos = vec2(
        color.r / 255.0 + color.b,
        color.g / 255.0 + color.a); // decode particle position from pixel RGBA

    vec2 velocity = mix(u_wind_min, u_wind_max, lookup_wind(pos));
    float speed_t = length(velocity) / length(u_wind_max);

    // take EPSG:4326 distortion into account for calculating where the particle moved
    float distortion = cos(radians(pos.y * 180.0 - 90.0));
    vec2 offset = vec2(velocity.x / distortion, -velocity.y) * 0.0001 * u_speed_factor;

    // update particle position, wrapping around the date line
    pos = fract(1.0 + pos + offset);

    // a random seed to use for the particle drop
    vec2 seed = (pos + v_tex_pos) * u_rand_seed;

    // drop rate is a chance a particle will restart at random position
    float drop_rate = u_drop_rate + speed_t * u_drop_rate_bump;
    float drop = step(1.0 - drop_rate, rand(seed));

    vec2 random_pos = vec2(
        rand(seed + 1.3),
        rand(seed + 2.1));
    pos = mix(pos, random_pos, drop);

    // encode the new particle position back into RGBA
    gl_FragColor = vec4(
        fract(pos * 255.0),
        floor(pos * 255.0) / 255.0);
}
`;

// ── GL Utility Functions ───────────────────────────────────────────────

type GLProgram = WebGLProgram & { program: WebGLProgram; [key: string]: unknown };

function createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'Shader compile error');
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext, vertexSource: string, fragmentSource: string): GLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'Program link error');
  }

  const wrapper = { program } as GLProgram;

  const numAttributes = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number;
  for (let i = 0; i < numAttributes; i++) {
    const attribute = gl.getActiveAttrib(program, i)!;
    wrapper[attribute.name] = gl.getAttribLocation(program, attribute.name);
  }
  const numUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < numUniforms; i++) {
    const uniform = gl.getActiveUniform(program, i)!;
    wrapper[uniform.name] = gl.getUniformLocation(program, uniform.name);
  }
  return wrapper;
}

function createTexture(
  gl: WebGLRenderingContext,
  filter: number,
  data: Uint8Array | HTMLCanvasElement | HTMLImageElement,
  width?: number,
  height?: number,
): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  if (data instanceof Uint8Array) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width!, height!, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function bindTexture(gl: WebGLRenderingContext, texture: WebGLTexture, unit: number): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
}

function createBuffer(gl: WebGLRenderingContext, data: Float32Array): WebGLBuffer {
  const buffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return buffer;
}

function bindAttribute(gl: WebGLRenderingContext, buffer: WebGLBuffer, attribute: number, numComponents: number): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(attribute);
  gl.vertexAttribPointer(attribute, numComponents, gl.FLOAT, false, 0, 0);
}

function bindFramebuffer(gl: WebGLRenderingContext, framebuffer: WebGLFramebuffer | null, texture?: WebGLTexture): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  if (texture) {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  }
}

// ── Color ramp ─────────────────────────────────────────────────────────

const DEFAULT_RAMP_COLORS: Record<number, string> = {
  0.0: '#3288bd',
  0.1: '#66c2a5',
  0.2: '#abdda4',
  0.3: '#e6f598',
  0.4: '#fee08b',
  0.5: '#fdae61',
  0.6: '#f46d43',
  1.0: '#d53e4f',
};

function getColorRamp(colors: Record<number, string>): Uint8Array {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  canvas.width = 256;
  canvas.height = 1;

  const gradient = ctx.createLinearGradient(0, 0, 256, 0);
  for (const stop in colors) {
    gradient.addColorStop(+stop, colors[stop]);
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 1);

  return new Uint8Array(ctx.getImageData(0, 0, 256, 1).data);
}

// ── GL State save / restore (for shared Mapbox context) ────────────────

interface SavedGLState {
  blend: boolean;
  depthTest: boolean;
  stencilTest: boolean;
  scissorTest: boolean;
  cullFace: boolean;
  blendFuncSrc: number;
  blendFuncDst: number;
  activeTexture: number;
  program: WebGLProgram | null;
  framebuffer: WebGLFramebuffer | null;
  arrayBuffer: WebGLBuffer | null;
  viewport: Int32Array;
  textures: (WebGLTexture | null)[];
}

function saveGLState(gl: WebGLRenderingContext): SavedGLState {
  const textures: (WebGLTexture | null)[] = [];
  for (let i = 0; i < 4; i++) {
    gl.activeTexture(gl.TEXTURE0 + i);
    textures.push(gl.getParameter(gl.TEXTURE_BINDING_2D));
  }
  return {
    blend: gl.isEnabled(gl.BLEND),
    depthTest: gl.isEnabled(gl.DEPTH_TEST),
    stencilTest: gl.isEnabled(gl.STENCIL_TEST),
    scissorTest: gl.isEnabled(gl.SCISSOR_TEST),
    cullFace: gl.isEnabled(gl.CULL_FACE),
    blendFuncSrc: gl.getParameter(gl.BLEND_SRC_RGB),
    blendFuncDst: gl.getParameter(gl.BLEND_DST_RGB),
    activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE),
    program: gl.getParameter(gl.CURRENT_PROGRAM),
    framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING),
    arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
    viewport: gl.getParameter(gl.VIEWPORT),
    textures,
  };
}

function restoreGLState(gl: WebGLRenderingContext, s: SavedGLState): void {
  // Restore capabilities
  if (s.blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
  if (s.depthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
  if (s.stencilTest) gl.enable(gl.STENCIL_TEST); else gl.disable(gl.STENCIL_TEST);
  if (s.scissorTest) gl.enable(gl.SCISSOR_TEST); else gl.disable(gl.SCISSOR_TEST);
  if (s.cullFace) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);

  gl.blendFunc(s.blendFuncSrc, s.blendFuncDst);
  gl.useProgram(s.program);
  gl.bindFramebuffer(gl.FRAMEBUFFER, s.framebuffer);
  gl.bindBuffer(gl.ARRAY_BUFFER, s.arrayBuffer);
  gl.viewport(s.viewport[0], s.viewport[1], s.viewport[2], s.viewport[3]);

  // Restore texture bindings
  for (let i = 0; i < s.textures.length; i++) {
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, s.textures[i]);
  }
  gl.activeTexture(s.activeTexture);
}

// ── WindGL class ───────────────────────────────────────────────────────

export interface WindData {
  image: Uint8Array;
  width: number;
  height: number;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

/** Max trail texture resolution (capped for performance) */
const MAX_TRAIL_RES = 2048;

export class WindGL {
  private gl: WebGLRenderingContext;

  fadeOpacity = 0.996;
  speedFactor = 0.25;
  dropRate = 0.003;
  dropRateBump = 0.01;

  private drawProgram: GLProgram;
  private screenProgram: GLProgram;
  private updateProgram: GLProgram;

  private quadBuffer: WebGLBuffer;
  private framebuffer: WebGLFramebuffer;

  private colorRampTexture!: WebGLTexture;
  private backgroundTexture!: WebGLTexture;
  private screenTexture!: WebGLTexture;

  private particleStateResolution!: number;
  private _numParticles!: number;
  private particleStateTexture0!: WebGLTexture;
  private particleStateTexture1!: WebGLTexture;
  private particleIndexBuffer!: WebGLBuffer;

  windData!: WindData;
  private windTexture!: WebGLTexture;

  /** Trail FBO dimensions (may differ from canvas size) */
  private trailWidth = 0;
  private trailHeight = 0;

  constructor(gl: WebGLRenderingContext) {
    this.gl = gl;

    this.drawProgram = createProgram(gl, DRAW_VERT, DRAW_FRAG);
    this.screenProgram = createProgram(gl, QUAD_VERT, SCREEN_FRAG);
    this.updateProgram = createProgram(gl, QUAD_VERT, UPDATE_FRAG);

    this.quadBuffer = createBuffer(gl, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]));
    this.framebuffer = gl.createFramebuffer()!;

    this.setColorRamp(DEFAULT_RAMP_COLORS);
  }

  /** Allocate / reallocate trail textures at a given resolution */
  resize(width: number, height: number): void {
    const gl = this.gl;
    const w = Math.min(width, MAX_TRAIL_RES);
    const h = Math.min(height, MAX_TRAIL_RES);
    if (w === this.trailWidth && h === this.trailHeight) return;
    this.trailWidth = w;
    this.trailHeight = h;
    const emptyPixels = new Uint8Array(w * h * 4);
    this.backgroundTexture = createTexture(gl, gl.NEAREST, emptyPixels, w, h);
    this.screenTexture = createTexture(gl, gl.NEAREST, emptyPixels, w, h);
  }

  setColorRamp(colors: Record<number, string>): void {
    this.colorRampTexture = createTexture(this.gl, this.gl.LINEAR, getColorRamp(colors), 16, 16);
  }

  set numParticles(numParticles: number) {
    const gl = this.gl;
    const particleRes = (this.particleStateResolution = Math.ceil(Math.sqrt(numParticles)));
    this._numParticles = particleRes * particleRes;

    const particleState = new Uint8Array(this._numParticles * 4);
    for (let i = 0; i < particleState.length; i++) {
      particleState[i] = Math.floor(Math.random() * 256);
    }

    this.particleStateTexture0 = createTexture(gl, gl.NEAREST, particleState, particleRes, particleRes);
    this.particleStateTexture1 = createTexture(gl, gl.NEAREST, particleState, particleRes, particleRes);

    const particleIndices = new Float32Array(this._numParticles);
    for (let i = 0; i < this._numParticles; i++) particleIndices[i] = i;
    this.particleIndexBuffer = createBuffer(gl, particleIndices);
  }

  get numParticles(): number {
    return this._numParticles;
  }

  setWind(windData: WindData): void {
    this.windData = windData;
    this.windTexture = createTexture(this.gl, this.gl.LINEAR, windData.image, windData.width, windData.height);
  }

  /** Prerender pass: update particle positions (offscreen FBO work) */
  prerender(): void {
    if (!this.windData) return;
    const gl = this.gl;
    const saved = saveGLState(gl);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);

    bindTexture(gl, this.windTexture, 0);
    bindTexture(gl, this.particleStateTexture0, 1);

    this.updateParticlesPass();

    restoreGLState(gl, saved);
  }

  /** Render pass: compose trail texture into the current framebuffer (Mapbox's) */
  render(): void {
    if (!this.windData) return;
    const gl = this.gl;
    const saved = saveGLState(gl);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);

    bindTexture(gl, this.windTexture, 0);
    bindTexture(gl, this.particleStateTexture0, 1);

    // 1) Draw particles + fade into the trail FBO
    bindFramebuffer(gl, this.framebuffer, this.screenTexture);
    gl.viewport(0, 0, this.trailWidth, this.trailHeight);

    this.drawTexture(this.backgroundTexture, this.fadeOpacity);
    this.drawParticles();

    // 2) Blit the trail texture into Mapbox's current FBO
    bindFramebuffer(gl, saved.framebuffer);
    gl.viewport(saved.viewport[0], saved.viewport[1], saved.viewport[2], saved.viewport[3]);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.drawTexture(this.screenTexture, 1.0);

    // 3) Swap trail textures for next frame
    const temp = this.backgroundTexture;
    this.backgroundTexture = this.screenTexture;
    this.screenTexture = temp;

    restoreGLState(gl, saved);
  }

  /** Release all GL resources */
  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.drawProgram.program);
    gl.deleteProgram(this.screenProgram.program);
    gl.deleteProgram(this.updateProgram.program);
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteBuffer(this.particleIndexBuffer);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteTexture(this.colorRampTexture);
    gl.deleteTexture(this.backgroundTexture);
    gl.deleteTexture(this.screenTexture);
    gl.deleteTexture(this.particleStateTexture0);
    gl.deleteTexture(this.particleStateTexture1);
    if (this.windTexture) gl.deleteTexture(this.windTexture);
  }

  // ── Private ──────────────────────────────────────────────────────

  private drawTexture(texture: WebGLTexture, opacity: number): void {
    const gl = this.gl;
    const program = this.screenProgram;
    gl.useProgram(program.program);

    bindAttribute(gl, this.quadBuffer, program.a_pos as number, 2);
    bindTexture(gl, texture, 2);
    gl.uniform1i(program.u_screen as WebGLUniformLocation, 2);
    gl.uniform1f(program.u_opacity as WebGLUniformLocation, opacity);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private drawParticles(): void {
    const gl = this.gl;
    const program = this.drawProgram;
    gl.useProgram(program.program);

    bindAttribute(gl, this.particleIndexBuffer, program.a_index as number, 1);
    bindTexture(gl, this.colorRampTexture, 2);

    gl.uniform1i(program.u_wind as WebGLUniformLocation, 0);
    gl.uniform1i(program.u_particles as WebGLUniformLocation, 1);
    gl.uniform1i(program.u_color_ramp as WebGLUniformLocation, 2);
    gl.uniform1f(program.u_particles_res as WebGLUniformLocation, this.particleStateResolution);
    gl.uniform2f(program.u_wind_min as WebGLUniformLocation, this.windData.uMin, this.windData.vMin);
    gl.uniform2f(program.u_wind_max as WebGLUniformLocation, this.windData.uMax, this.windData.vMax);

    gl.drawArrays(gl.POINTS, 0, this._numParticles);
  }

  private updateParticlesPass(): void {
    const gl = this.gl;
    bindFramebuffer(gl, this.framebuffer, this.particleStateTexture1);
    gl.viewport(0, 0, this.particleStateResolution, this.particleStateResolution);

    const program = this.updateProgram;
    gl.useProgram(program.program);

    bindAttribute(gl, this.quadBuffer, program.a_pos as number, 2);

    gl.uniform1i(program.u_wind as WebGLUniformLocation, 0);
    gl.uniform1i(program.u_particles as WebGLUniformLocation, 1);

    gl.uniform1f(program.u_rand_seed as WebGLUniformLocation, Math.random());
    gl.uniform2f(program.u_wind_res as WebGLUniformLocation, this.windData.width, this.windData.height);
    gl.uniform2f(program.u_wind_min as WebGLUniformLocation, this.windData.uMin, this.windData.vMin);
    gl.uniform2f(program.u_wind_max as WebGLUniformLocation, this.windData.uMax, this.windData.vMax);
    gl.uniform1f(program.u_speed_factor as WebGLUniformLocation, this.speedFactor);
    gl.uniform1f(program.u_drop_rate as WebGLUniformLocation, this.dropRate);
    gl.uniform1f(program.u_drop_rate_bump as WebGLUniformLocation, this.dropRateBump);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // swap the particle state textures so the new one becomes the current one
    const temp = this.particleStateTexture0;
    this.particleStateTexture0 = this.particleStateTexture1;
    this.particleStateTexture1 = temp;
  }
}
