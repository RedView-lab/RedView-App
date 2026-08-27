import type { Map as MapboxMap } from 'mapbox-gl';
import { DEFAULT_ORTHO_BOOT_FALLBACK_MS } from './constants';

export interface MapRuntimeProfile {
  antialias: boolean;
  pixelRatio: number;
  minTileCacheSize: number;
  maxTileCacheSize: number;
  orthoBootFallbackMs: number;
}

function detectGpuProfile(): { isIntegratedGpu: boolean; isAmdOrIntel: boolean } {
  if (typeof document === 'undefined') return { isIntegratedGpu: false, isAmdOrIntel: false };
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return { isIntegratedGpu: false, isAmdOrIntel: false };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '') || '';
    const r = renderer.toLowerCase();

    // Detect integrated GPUs (AMD Radeon Graphics / 680M / 780M / 880M, Intel Iris / UHD / Arc iGPU, Apple M-series, mobile GPUs)
    const isAmdOrIntel = /radeon|amd|intel/.test(r);
    const isDedicated = /geforce|rtx|gtx|quadro|titan|radeon rx (?:[56789]\d00|vega (?:56|64))/.test(r);
    const isIntegrated = (isAmdOrIntel && !isDedicated) || /mali|adreno|apple m|powervr|swiftshader/.test(r);
    return { isIntegratedGpu: isIntegrated, isAmdOrIntel };
  } catch {
    return { isIntegratedGpu: false, isAmdOrIntel: false };
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
  const rawDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  const { isIntegratedGpu } = detectGpuProfile();

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
      pixelRatio: Math.min(rawDpr, 1.25),
      minTileCacheSize: 320,
      maxTileCacheSize: 1000,
      orthoBootFallbackMs: 1800,
    };
  }

  return {
    antialias: true,
    pixelRatio: Math.min(rawDpr, 1.5),
    minTileCacheSize: 400,
    maxTileCacheSize: 1200,
    orthoBootFallbackMs: DEFAULT_ORTHO_BOOT_FALLBACK_MS,
  };
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