import type { Map as MapboxMap } from 'mapbox-gl';
import { DEFAULT_ORTHO_BOOT_FALLBACK_MS } from './constants';

export interface MapRuntimeProfile {
  antialias: boolean;
  minTileCacheSize: number;
  maxTileCacheSize: number;
  orthoBootFallbackMs: number;
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

  const constrainedDevice = saveData
    || effectiveType === 'slow-2g'
    || effectiveType === '2g'
    || isMobile
    || (mem > 0 && mem <= 4)
    || (cores > 0 && cores <= 4);
  if (constrainedDevice) {
    return {
      antialias: false,
      minTileCacheSize: 240,
      maxTileCacheSize: 800,
      orthoBootFallbackMs: 2400,
    };
  }

  const balancedDevice = effectiveType === '3g'
    || (mem > 0 && mem <= 8)
    || (cores > 0 && cores <= 6);
  if (balancedDevice) {
    return {
      antialias: true,
      minTileCacheSize: 320,
      maxTileCacheSize: 1000,
      orthoBootFallbackMs: 1800,
    };
  }

  return {
    antialias: true,
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