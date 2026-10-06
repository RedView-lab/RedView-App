// ============================================
// Offscreen render targets of the WebGL 2 backend
// ============================================
//
// The scene is always drawn offscreen, then a full-screen pass (copy, EDL,
// upscale or accumulation) writes the canvas: the default framebuffer is
// created without depth or multisampling, which keeps every path on
// formats WebGL 2 guarantees. With MSAA the scene goes into multisampled
// renderbuffers and is resolved (`blitFramebuffer`) into the single-sample
// textures; depth is resolved only when the EDL pass reads it.

import { createTargetTexture } from './glUtils';

export interface GlSceneTargets {
  width: number;
  height: number;
  /** Single-sample colour (RGBA8, linear filtering for the upscale) and depth (DEPTH_COMPONENT24). */
  colorTex: WebGLTexture;
  depthTex: WebGLTexture;
  /** Framebuffer of the two textures: drawn into without MSAA, resolve target with it. */
  fbo: WebGLFramebuffer;
  msFbo: WebGLFramebuffer | null;
  msColor: WebGLRenderbuffer | null;
  msDepth: WebGLRenderbuffer | null;
}

function checkComplete(gl: WebGL2RenderingContext, label: string): void {
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) {
    throw new Error(`WebGL framebuffer incomplete (${label}): 0x${status.toString(16)}`);
  }
}

export function createGlSceneTargets(gl: WebGL2RenderingContext, width: number, height: number, samples: number): GlSceneTargets {
  const colorTex = createTargetTexture(gl, gl.RGBA8, width, height, 'linear');
  const depthTex = createTargetTexture(gl, gl.DEPTH_COMPONENT24, width, height, 'nearest');
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('createFramebuffer failed');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
  checkComplete(gl, 'scene');

  let msFbo: WebGLFramebuffer | null = null;
  let msColor: WebGLRenderbuffer | null = null;
  let msDepth: WebGLRenderbuffer | null = null;
  if (samples > 1) {
    msFbo = gl.createFramebuffer();
    msColor = gl.createRenderbuffer();
    msDepth = gl.createRenderbuffer();
    if (!msFbo || !msColor || !msDepth) throw new Error('MSAA target allocation failed');
    gl.bindRenderbuffer(gl.RENDERBUFFER, msColor);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, msDepth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, msFbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msColor);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, msDepth);
    checkComplete(gl, 'scene MSAA');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { width, height, colorTex, depthTex, fbo, msFbo, msColor, msDepth };
}

/** Resolves the multisampled scene into the textures (no-op without MSAA). */
export function resolveGlSceneTargets(gl: WebGL2RenderingContext, targets: GlSceneTargets, withDepth: boolean): void {
  if (!targets.msFbo) return;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, targets.msFbo);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, targets.fbo);
  const { width, height } = targets;
  gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  if (withDepth) gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}

export function destroyGlSceneTargets(gl: WebGL2RenderingContext, targets: GlSceneTargets | null): void {
  if (!targets) return;
  gl.deleteFramebuffer(targets.fbo);
  gl.deleteTexture(targets.colorTex);
  gl.deleteTexture(targets.depthTex);
  if (targets.msFbo) gl.deleteFramebuffer(targets.msFbo);
  if (targets.msColor) gl.deleteRenderbuffer(targets.msColor);
  if (targets.msDepth) gl.deleteRenderbuffer(targets.msDepth);
}

/** Running mean of the still frames (linear light). */
export interface GlAccumTarget {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
}

/**
 * RGBA16F accumulation target, or null where half floats are not
 * renderable (no EXT_color_buffer_float / _half_float): the still frames
 * are then left as they are, without the progressive anti-aliasing.
 */
export function createGlAccumTarget(gl: WebGL2RenderingContext, width: number, height: number): GlAccumTarget | null {
  const texture = createTargetTexture(gl, gl.RGBA16F, width, height, 'nearest');
  const fbo = gl.createFramebuffer();
  if (!fbo) {
    gl.deleteTexture(texture);
    return null;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!complete) {
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(texture);
    return null;
  }
  return { texture, fbo };
}

export function destroyGlAccumTarget(gl: WebGL2RenderingContext, target: GlAccumTarget | null): void {
  if (!target) return;
  gl.deleteFramebuffer(target.fbo);
  gl.deleteTexture(target.texture);
}
