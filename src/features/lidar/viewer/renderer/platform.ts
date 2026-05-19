import type { PlatformProfile } from '../lod/types';
import { SHADER_APPLE_LITE, SHADER_GATHER, SHADER_LOAD } from './shaders';

export function resolvePlatformInfo(adapterInfo: any): {
  vendor: string;
  arch: string;
  desc: string;
  isApple: boolean;
  profile: PlatformProfile;
} {
  const vendor = (adapterInfo?.vendor ?? '').toLowerCase();
  const arch = (adapterInfo?.architecture ?? '').toLowerCase();
  const desc = (adapterInfo?.description ?? adapterInfo?.device ?? '').toLowerCase();
  const isApple = vendor.includes('apple') || arch.includes('apple') || desc.includes('apple');

  return {
    vendor,
    arch,
    desc,
    isApple,
    profile: isApple
      ? { initialBudget: 4_000_000, maxBudget: 9_000_000, maxCanvasDim: 4096, dprCap: 1.5, isApple: true, targetFrameMs: 16.6, lodScreenScale: 1.6 }
      // Desktop dGPU: 12M initial / 32M max. CloudCompare-class density —
      // adaptive budget will throttle back automatically if frames slip.
      : { initialBudget: 12_000_000, maxBudget: 32_000_000, maxCanvasDim: 8192, dprCap: 3.0, isApple: false, targetFrameMs: 16.6, lodScreenScale: 1.0 },
  };
}

export function choosePointShaderVariant(isApple: boolean, hasF32Filter: boolean): {
  shaderCode: string;
  shaderLabel: string;
} {
  if (isApple) {
    return {
      shaderCode: SHADER_APPLE_LITE,
      shaderLabel: 'Apple-lite (no frag_depth, no raytrace, 4-tap normal)',
    };
  }
  if (hasF32Filter) {
    return {
      shaderCode: SHADER_GATHER,
      shaderLabel: 'textureGather (full quality)',
    };
  }
  return {
    shaderCode: SHADER_LOAD,
    shaderLabel: 'textureLoad (full quality fallback)',
  };
}