import type { Map as MapboxMap } from 'mapbox-gl';
import { DEFAULT_ORTHO_BOOT_FALLBACK_MS } from './constants';

export interface MapRuntimeProfile {
  antialias: boolean;
  pixelRatio: number;
  minTileCacheSize: number;
  maxTileCacheSize: number;
  orthoBootFallbackMs: number;
}

interface GpuProfile {
  isIntegratedGpu: boolean;
  isAmdOrIntel: boolean;
  isAppleGpu: boolean;
}

const UNKNOWN_GPU: GpuProfile = { isIntegratedGpu: false, isAmdOrIntel: false, isAppleGpu: false };
let cachedGpuProfile: GpuProfile | null = null;

function detectGpuProfile(): GpuProfile {
  if (cachedGpuProfile) return cachedGpuProfile;
  if (typeof document === 'undefined') return UNKNOWN_GPU;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return UNKNOWN_GPU;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '') || '';
    // Release the probe context right away: browsers cap live WebGL contexts
    // (Safari ~16) and an orphan context keeps GPU memory until GC.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    const r = renderer.toLowerCase();

    // Detect integrated GPUs (AMD Radeon Graphics / 680M / 780M / 880M, Intel Iris / UHD / Arc iGPU,
    // Apple Silicon: "ANGLE Metal Renderer: Apple M..." in Chromium, masked "Apple GPU" in Safari), mobile GPUs
    const isAmdOrIntel = /radeon|amd|intel/.test(r);
    const isAppleGpu = /apple m|apple gpu/.test(r);
    const isDedicated = /geforce|rtx|gtx|quadro|titan|radeon rx (?:[56789]\d00|vega (?:56|64))/.test(r);
    const isIntegrated = (isAmdOrIntel && !isDedicated) || isAppleGpu || /mali|adreno|powervr|swiftshader/.test(r);
    cachedGpuProfile = { isIntegratedGpu: isIntegrated, isAmdOrIntel, isAppleGpu };
    return cachedGpuProfile;
  } catch {
    return UNKNOWN_GPU;
  }
}

export function getMapRuntimeProfile(): MapRuntimeProfile {
  const nav = navigator as Navigator & {
    connection?: {
      effectiveType?: string;
      saveData?: boolean;
    };
    deviceMemory?: number;
    userAgentData?: {
      mobile?: boolean;
    };
  };

  const ua = (nav.userAgent || '').toLowerCase();
  const mem = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 0;
  const cores = nav.hardwareConcurrency || 0;
  const effectiveType = nav.connection?.effectiveType ?? '';
  const saveData = !!nav.connection?.saveData;
  const isMobile = !!nav.userAgentData?.mobile || /android|iphone|ipad|ipod|mobile/.test(ua);
  const { isIntegratedGpu, isAppleGpu } = detectGpuProfile();

  const constrainedDevice = saveData
    || effectiveType === 'slow-2g'
    || effectiveType === '2g'
    || isMobile
    || (mem > 0 && mem <= 4)
    || (cores > 0 && cores <= 4);
  if (constrainedDevice) {
    return {
      antialias: false,
      pixelRatio: 1.0,
      minTileCacheSize: 240,
      maxTileCacheSize: 800,
      orthoBootFallbackMs: 2400,
    };
  }

  const balancedDevice = effectiveType === '3g'
    || isIntegratedGpu
    || (mem > 0 && mem <= 8)
    || (cores > 0 && cores <= 8);
  if (balancedDevice) {
    // Integrated GPUs (e.g. AMD Ryzen APU with Radeon 780M / 680M) share system memory (UMA).
    // Disabling MSAA 4x and capping DPR at 1.25 saves >60% fill-rate while preserving crisp visuals.
    return {
      antialias: false,
      // Apple Silicon Retina: 1.5 on-screen density (true on-screen, see setDprLayoutScale).
      pixelRatio: isAppleGpu ? 1.5 : 1.25,
      minTileCacheSize: 320,
      maxTileCacheSize: 1000,
      orthoBootFallbackMs: 1800,
    };
  }

  return {
    antialias: true,
    pixelRatio: 1.5,
    minTileCacheSize: 400,
    maxTileCacheSize: 1200,
    orthoBootFallbackMs: DEFAULT_ORTHO_BOOT_FALLBACK_MS,
  };
}

let dprPatched = false;
let dprCap = Number.POSITIVE_INFINITY;
let dprLayoutScale = 1;
let readNativeDpr: () => number = () => 1;

function resolveNativeDprGetter(): () => number {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
    ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window), 'devicePixelRatio');
  const getter = descriptor?.get;
  if (getter) return () => Number(getter.call(window)) || 1;
  const fixed = Number(window.devicePixelRatio) || 1;
  return () => fixed;
}

/**
 * Ensures Mapbox GL JS (and every canvas in the dashboard) renders at the
 * optimal device pixel ratio for the host hardware profile.
 *
 * Mapbox GL JS does not support a `pixelRatio` constructor option and reads
 * `window.devicePixelRatio` directly via its internal browser utility.
 * Redefining the getter before `new mapboxgl.Map()` guarantees that canvas sizing,
 * painter viewports, projection matrices, and shader uniforms remain in sync.
 *
 * The getter is live: it follows the native DPR (window moved between screens),
 * applies the profile cap, and compensates the dashboard `transform: scale(appScale)`
 * (see {@link setDprLayoutScale}) so canvases are rendered at on-screen resolution
 * instead of the larger logical size then downscaled by the compositor.
 */
export function applyRuntimeProfileDpr(profile: MapRuntimeProfile): void {
  if (typeof window === 'undefined') return;
  dprCap = profile.pixelRatio;
  if (dprPatched) return;
  try {
    readNativeDpr = resolveNativeDprGetter();
    Object.defineProperty(window, 'devicePixelRatio', {
      get: () => Math.max(0.5, Math.min(readNativeDpr(), dprCap) * dprLayoutScale),
      configurable: true,
    });
    dprPatched = true;
  } catch (error) {
    console.warn('[runtimeProfile] Failed to cap window.devicePixelRatio', error);
  }
}

/**
 * Declares the CSS scale applied to the dashboard canvas (`appScale`).
 * A layout box of W logical px is shown on W * appScale screen px, so the
 * backing store only needs `W * appScale * dpr` pixels. On a 1366 or 1470 px
 * wide laptop (appScale ~0.72-0.92, see shared/lib/appScale.ts) this removes
 * 15-48 % of rendered pixels.
 * Takes effect on the next canvas resize (Mapbox resizes with its container).
 */
export function setDprLayoutScale(scale: number): void {
  dprLayoutScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function waitForMapIdleOrTimeout(map: MapboxMap, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      map.off('idle', onIdle);
      resolve();
    };
    const onIdle = () => finish();
    const timer = setTimeout(finish, timeoutMs);
    map.on('idle', onIdle);
  });
}