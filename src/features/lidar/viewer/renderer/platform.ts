import type { GpuTier, PlatformProfile } from '../lod/types';

// Les budgets partent bas et ne sont relevés par le budget adaptatif que
// quand le temps GPU mesuré laisse de la marge ; `maxBudget` est un plafond
// strict par classe pour les images en mouvement, `restMaxBudget` pour les
// images fixes (raffinées une fois la caméra arrêtée). Le pool contient la
// sélection fixe plus une marge pour se retourner : 20 o par point sur le GPU
// (enregistrement de 16 o + couleur ombrée de 4 o), par ex. 480 Mo pour 24 M points.
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
  // Rastériseur CPU (une VM Linux ou une machine dont le navigateur bloque le
  // pilote GPU) : chaque pixel et chaque point coûtent du temps CPU, donc peu de
  // points, des pixels 1:1 et une image en demi-résolution pendant le mouvement.
  software: {
    tier: 'software', minBudget: 100_000, initialBudget: 300_000, maxBudget: 1_500_000, restMaxBudget: 4_000_000,
    poolBudget: 8_000_000, maxCanvasDim: 2048, dprCap: 1.0, isApple: false, motionScale: 0.5,
  },
};

/**
 * Les machines annonçant peu de mémoire (`navigator.deviceMemory` ≤ 4 Gio ; les GPU
 * intégrés la partagent) gardent la moitié du budget fixe et du pool.
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
 * Classe l'adaptateur. Chrome expose `vendor`/`architecture` (par ex.
 * "intel"/"gen-12lp", "amd"/"rdna-3") mais en général pas `description`, et une
 * architecture AMD est partagée par cartes de bureau et APU (RX 7800 XT et
 * Radeon 860M sont toutes deux "rdna-3") : `desc` doit alors venir de
 * `probeWebglRenderer`. Un adaptateur qui reste non identifié est traité comme
 * intégré : le budget prudent grandit alors d'après le temps GPU mesuré.
 */
function resolveGpuTier(vendor: string, arch: string, desc: string): GpuTier {
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
 * Modèle de GPU tel que WebGL le rapporte (par ex. "angle (amd, amd radeon(tm) 860m
 * graphics …)"), que les navigateurs exposent encore quand les infos
 * d'adaptateur de WebGPU laissent `description` vide. Chaîne vide si indisponible.
 */
function probeWebglRenderer(): string {
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

/** Rastériseurs CPU derrière un contexte WebGL : Mesa llvmpipe/softpipe/lavapipe, SwiftShader, Windows WARP. */
const SOFTWARE_RENDERER_RE = /swiftshader|llvmpipe|lavapipe|softpipe|basic render driver|microsoft basic render|\bwarp\b/;

/**
 * Fabricant de GPU nommé par une chaîne vendor/renderer WebGL, dans le
 * vocabulaire de `adapter.info.vendor` de WebGPU. Couvre ANGLE ("ANGLE (NVIDIA Corporation,
 * NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 535.54.03)"), les
 * chaînes Mesa natives que Firefox rapporte sous Linux ("Mesa Intel(R) UHD Graphics
 * 620 (KBL GT2)", "AMD Radeon RX 6700 XT (radeonsi, navi22, …)") et ses
 * chaînes assainies ("GeForce GTX 980, or similar").
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
 * Profil de plateforme d'un contexte WebGL 2, d'après ses chaînes vendor/renderer
 * démasquées (`WEBGL_debug_renderer_info` ; vides quand le navigateur les cache :
 * le profil reste alors `integrated` et le budget grandit d'après la cadence).
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
    // Ne faire confiance à la chaîne WebGL que si elle nomme le même fabricant
    // (le contexte WebGL d'un portable peut tourner sur l'autre GPU).
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