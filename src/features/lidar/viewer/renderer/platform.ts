import type { GpuTier, PlatformProfile } from '../lod/types';

// Budgets start low and are raised by the adaptive budget only when measured
// GPU time leaves headroom; `maxBudget` is a hard ceiling per class.
const PROFILES: Record<GpuTier, PlatformProfile> = {
  apple: {
    tier: 'apple', minBudget: 1_000_000, initialBudget: 4_000_000, maxBudget: 9_000_000, poolBudget: 12_000_000,
    maxCanvasDim: 4096, dprCap: 1.5, isApple: true, targetFrameMs: 16.6,
  },
  integrated: {
    tier: 'integrated', minBudget: 400_000, initialBudget: 1_500_000, maxBudget: 6_000_000, poolBudget: 8_000_000,
    maxCanvasDim: 4096, dprCap: 1.25, isApple: false, targetFrameMs: 16.6,
  },
  discrete: {
    tier: 'discrete', minBudget: 1_500_000, initialBudget: 6_000_000, maxBudget: 32_000_000, poolBudget: 40_000_000,
    maxCanvasDim: 8192, dprCap: 2.0, isApple: false, targetFrameMs: 16.6,
  },
};

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

export function resolvePlatformInfo(adapterInfo: any): {
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