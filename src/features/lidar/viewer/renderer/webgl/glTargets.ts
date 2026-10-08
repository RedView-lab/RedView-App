// ============================================
// Cibles de rendu hors écran du backend WebGL 2
// ============================================
//
// La scène est toujours dessinée hors écran, puis une passe plein écran
// (copie, EDL, agrandissement ou accumulation) écrit le canvas : le
// framebuffer par défaut est créé sans profondeur ni multiéchantillonnage, ce
// qui garde chaque chemin sur des formats que WebGL 2 garantit. Avec le MSAA,
// la scène va dans des renderbuffers multiéchantillonnés et est résolue
// (`blitFramebuffer`) dans les textures mono-échantillon ; la profondeur n'est
// résolue que quand la passe EDL la lit.

import { createTargetTexture } from './glUtils';

export interface GlSceneTargets {
  width: number;
  height: number;
  /** Couleur mono-échantillon (RGBA8, filtrage linéaire pour l'agrandissement) et profondeur (DEPTH_COMPONENT24). */
  colorTex: WebGLTexture;
  depthTex: WebGLTexture;
  /** Framebuffer des deux textures : on y dessine sans MSAA, cible de résolution avec. */
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

/** Résout la scène multiéchantillonnée dans les textures (sans effet sans MSAA). */
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

/** Moyenne courante des images fixes (lumière linéaire). */
export interface GlAccumTarget {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
}

/**
 * Cible d'accumulation RGBA16F, ou null là où les demi-flottants ne sont pas
 * rendables (pas d'EXT_color_buffer_float / _half_float) : les images fixes
 * restent alors telles quelles, sans l'anticrénelage progressif.
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
