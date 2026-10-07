import type { GpuTier, PlatformProfile } from '../lod/types';

// Budgets start low and are raised by the adaptive budget only when measured
// GPU time leaves headroom; `maxBudget` is a hard ceiling per class for
// moving frames, `restMaxBudget` for still frames (refined once the camera
// stops). The pool holds the still selection plus a margin for turning
// back: 20 B per point on the GPU (16 B record + 4 B shaded colour), e.g.
// 480 MB for 24 M points.
const PROFILES: Record<GpuTier, PlatformProfile> = {
  apple: {
    tier: 'apple', minBudget: 1_000_000, initialBudget: 4_000_000, maxBudget: 9_000_000, restMaxBudget: 22_000_000,
    poolBudget: 26_000_000, maxCanvasDim: 4096, dprCap: 1.5, isApple: true, motionScale: 0.75,
  },
  integrated: {
    tier: 'integrated', minBudget: 400_000, initialBudget: 1_500_000, maxBudget: 8_000_000, restMaxBudget: 20_000_000,
    poolBudget: 24_000_000, maxCanvasDim: 4096, dprCap: 1.25, isApple: false, motionScale: 0.7,
  },
  discrete: {
    tier: 'discrete', minBudget: 1_500_000, initialBudget: 6_000_000, maxBudget: 32_000_000, restMaxBudget: 48_000_000,
    poolBudget: 56_000_000, maxCanvasDim: 8192, dprCap: 2.0, isApple: false, motionScale: 0.75,
  },
  // CPU rasteriser (a Linux VM or a machine whose GPU driver the browser
  // blocks): every pixel and point costs CPU time, so few points, 1:1
  // pixels and a half-resolution image while moving.
  software: {
    tier: 'software', minBudget: 100_000, initialBudget: 300_000, maxBudget: 1_500_000, restMaxBudget: 4_000_000,
    poolBudget: 8_000_000, maxCanvasDim: 2048, dprCap: 1.0, isApple: false, motionScale: 0.5,
  },
};

/**
 * Machines reporting little memory (`navigator.deviceMemory` ≤ 4 GiB; integrated
 * GPUs share it) keep half the still budget and pool.
 */
export function fitProfileToMemory(profile: PlatformProfile, deviceMemoryGiB: number | undefined): PlatformProfile {
  if (deviceMemoryGiB === undefined || deviceMemoryGiB > 4) return profile;
  const restMaxBudget = Math.max(profile.maxBudget, Math.round(profile.restMaxBudget / 2));
  return { ...profile, restMaxBudget, poolBudget: Math.max(restMaxBudget, Math.round(profile.poolBudget / 2)) };
}

const INTEL_DISCRETE_RE = /xe-?hpg|xe2-?hpg|alchemist|battlemage|\barc\b/;
const AMD_APU_RE = /radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|\b(6[0-9]0|7[0-9]0|8[0-9]0)m\b/;
const MOBILE_VENDOR_RE = /qualcomm|adreno|arm|mali|imagination|powervr|samsung|broadcom/;

/**
 * Classifies the adapter. Chrome exposes `vendor`/`architecture` (e.g.
 * "intel"/"gen-12lp", "amd"/"rdna-3") but usually not `description`, and an
 * AMD architecture is shared by desktop cards and APUs (RX 7800 XT and
 * Radeon 860M are both "rdna-3"): `desc` should then come from
 * `probeWebglRenderer`. An adapter that stays unidentified is treated as
 * integrated: the safe budget then grows from measured GPU time.
 */
export function resolveGpuTier(vendor: string, arch: string, desc: string): GpuTier {
  const haystack = `${vendor} ${arch} ${desc}`;
  if (haystack.includes('apple')) return 'apple';
  if (vendor.includes('nvidia')) return 'discrete';
  if (vendor.includes('intel')) return INTEL_DISCRETE_RE.test(`${arch} ${desc}`) ? 'discrete' : 'integrated';
  if (vendor.includes('amd') || vendor.includes('ati')) {
    if (!desc) return 'integrated';
    return AMD_APU_RE.test(desc) ? 'integrated' : 'discrete';
  }
  if (MOBILE_VENDOR_RE.test(haystack)) return 'integrated';
  return 'integrated';
}

/**
 * GPU model as reported by WebGL (e.g. "angle (amd, amd radeon(tm) 860m
 * graphics …)"), which browsers still expose when WebGPU's adapter info
 * leaves `description` empty. Empty string when unavailable.
 */
export function probeWebglRenderer(): string {
  try {
    if (typeof document === 'undefined') return '';
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return '';
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return String(renderer ?? '').toLowerCase();
  } catch {
    return '';
  }
}

/** CPU rasterisers behind a WebGL context: Mesa llvmpipe/softpipe/lavapipe, SwiftShader, Windows WARP. */
const SOFTWARE_RENDERER_RE = /swiftshader|llvmpipe|lavapipe|softpipe|basic render driver|microsoft basic render|\bwarp\b/;

/**
 * GPU vendor named by a WebGL vendor/renderer string, in the vocabulary of
 * WebGPU's `adapter.info.vendor`. Covers ANGLE ("ANGLE (NVIDIA Corporation,
 * NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 535.54.03)"), the
 * native Mesa strings Firefox reports on Linux ("Mesa Intel(R) UHD Graphics
 * 620 (KBL GT2)", "AMD Radeon RX 6700 XT (radeonsi, navi22, …)") and its
 * sanitised ones ("GeForce GTX 980, or similar").
 */
export function webglVendorOf(text: string): string {
  if (/nvidia|geforce|quadro|\brtx\b|\bgtx\b/.test(text)) return 'nvidia';
  if (/\bamd\b|radeon|\bati\b|advanced micro devices/.test(text)) return 'amd';
  if (/intel|\biris\b/.test(text)) return 'intel';
  if (/apple/.test(text)) return 'apple';
  if (MOBILE_VENDOR_RE.test(text)) return 'arm';
  return '';
}

/**
 * Platform profile of a WebGL 2 context, from its unmasked vendor/renderer
 * strings (`WEBGL_debug_renderer_info`; empty when the browser hides them:
 * the profile then stays `integrated` and the budget grows from the cadence).
 */
export function resolveWebglPlatformInfo(vendorString: string, rendererString: string): {
  vendor: string;
  desc: string;
  profile: PlatformProfile;
} {
  const desc = rendererString.toLowerCase();
  const haystack = `${vendorString} ${rendererString}`.toLowerCase();
  if (SOFTWARE_RENDERER_RE.test(haystack)) {
    return { vendor: 'software', desc, profile: { ...PROFILES.software } };
  }
  const vendor = webglVendorOf(haystack);
  return { vendor, desc, profile: { ...PROFILES[resolveGpuTier(vendor, '', desc)] } };
}

/** Champs lus du GPUAdapterInfo de WebGPU (absents selon le navigateur). */
export interface GpuAdapterInfoFields {
  vendor?: string;
  architecture?: string;
  description?: string;
  device?: string;
}

export function resolvePlatformInfo(adapterInfo: GpuAdapterInfoFields | null | undefined): {
  vendor: string;
  arch: string;
  desc: string;
  isApple: boolean;
  profile: PlatformProfile;
} {
  const vendor = (adapterInfo?.vendor ?? '').toLowerCase();
  const arch = (adapterInfo?.architecture ?? '').toLowerCase();
  let desc = (adapterInfo?.description ?? adapterInfo?.device ?? '').toLowerCase();
  if (!desc && vendor) {
    // Only trust the WebGL string when it names the same vendor (a laptop's
    // WebGL context may run on the other GPU).
    const webglRenderer = probeWebglRenderer();
    if (webglRenderer.includes(vendor)) desc = webglRenderer;
  }
  const tier = resolveGpuTier(vendor, arch, desc);

  return {
    vendor,
    arch,
    desc,
    isApple: tier === 'apple',
    profile: { ...PROFILES[tier] },
  };
}