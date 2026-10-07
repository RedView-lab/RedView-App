// ============================================
// Photo mode — packing of the `Photo` uniform block (photoCommon.ts)
// ============================================

import { PHOTO_UNIFORM_FLOATS } from './shaders/photoCommon';

type Vec4 = readonly [number, number, number, number];

export interface PhotoUniformValues {
  invDrawViewProj: Float32Array;
  viewProj: Float32Array;
  prevViewProj: Float32Array;
  invViewProj: Float32Array;
  shadow0: Float32Array;
  shadow1: Float32Array;
  dsm: Float32Array;
  cameraPos: Vec4;
  sunDir: Vec4;
  scene: Vec4;
  cloudLayer: Vec4;
  cloudParams: Vec4;
  cloudShadow: Vec4;
  phase: Vec4;
  shadowInfo: Vec4;
  flags: Vec4;
  dtm: Vec4;
  frame: Vec4;
  targetSize: Vec4;
  cloudSize: Vec4;
  exposure: Vec4;
  atmosphere: Vec4;
  dsmInfo: Vec4;
  quality: Vec4;
  cloudTemporal: Vec4;
  cloudStill: Vec4;
  highClouds0: Vec4;
  highClouds1: Vec4;
}

const MATRICES = ['invDrawViewProj', 'viewProj', 'prevViewProj', 'invViewProj', 'shadow0', 'shadow1', 'dsm'] as const;
const VEC4S = [
  'cameraPos', 'sunDir', 'scene', 'cloudLayer', 'cloudParams', 'cloudShadow', 'phase', 'shadowInfo', 'flags', 'dtm',
  'frame', 'targetSize', 'cloudSize', 'exposure', 'atmosphere', 'dsmInfo', 'quality', 'cloudTemporal', 'cloudStill',
  'highClouds0', 'highClouds1',
] as const;

/** Writes the block in the order of the WGSL struct (matrices, then vec4s). */
export function packPhotoUniforms(out: Float32Array, v: PhotoUniformValues): void {
  let o = 0;
  for (const key of MATRICES) {
    out.set(v[key].subarray(0, 16), o);
    o += 16;
  }
  for (const key of VEC4S) {
    const value = v[key];
    out[o] = value[0];
    out[o + 1] = value[1];
    out[o + 2] = value[2];
    out[o + 3] = value[3];
    o += 4;
  }
  if (o !== PHOTO_UNIFORM_FLOATS) throw new Error(`Photo uniforms: ${o} floats packed, ${PHOTO_UNIFORM_FLOATS} expected`);
}
