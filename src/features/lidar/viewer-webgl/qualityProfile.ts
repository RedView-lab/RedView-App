import { detectCrs } from '../lib/coordConvert';
import type { PointCloudBounds, DetectedCrs } from '../types';

export type DeviceTier = 'masterpiece' | 'high' | 'medium' | 'low' | 'minimal';

export interface QualityProfile {
  tier: DeviceTier;
  maxGrid: number;
  minResM: number;
  textureCap: number;
  dprCap: number;
  lowPower: boolean;
  reason: string;
}

export interface ParsedHeader {
  bounds: PointCloudBounds;
  crs: DetectedCrs;
}

export function detectDeviceTier(): QualityProfile {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { mobile?: boolean; platform?: string };
  };
  const ua = (nav.userAgent || '').toLowerCase();
  const mem = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 0;
  const cores = nav.hardwareConcurrency || 0;
  const isMobile = !!nav.userAgentData?.mobile || /android|iphone|ipad|ipod|mobile/.test(ua);
  const isMacIntel = /macintosh|mac os x/.test(ua) && /intel/.test(ua);

  let rendererStr = '';
  let maxTexProbe = 0;
  try {
    const probe = document.createElement('canvas').getContext('webgl2', {
      failIfMajorPerformanceCaveat: false,
    }) as WebGL2RenderingContext | null;
    if (probe) {
      maxTexProbe = (probe.getParameter(probe.MAX_TEXTURE_SIZE) as number) || 0;
      const dbg = probe.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        rendererStr = String(probe.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '').toLowerCase();
      }
      const lose = probe.getExtension('WEBGL_lose_context');
      lose?.loseContext();
    }
  } catch { /* noop */ }

  const isSoftware = /(swiftshader|llvmpipe|lavapipe|microsoft basic|warp|software)/.test(rendererStr);
  const isAppleSilicon = /apple m\d/.test(rendererStr) || (/apple gpu/.test(rendererStr) && !isMacIntel);
  const isMobileGPU = /(adreno|mali|powervr|videocore)/.test(rendererStr);
  const isOldIntel = /(hd graphics (3000|4000|4400|4600)|intel\(r\) hd)/.test(rendererStr);

  const profile = (tier: DeviceTier, reason: string, extra: { lowPower: boolean }): QualityProfile => {
    const matrix: Record<DeviceTier, { maxGrid: number; minResM: number; textureCap: number; dprCap: number }> = {
      masterpiece: { maxGrid: 2048, minResM: 0.25, textureCap: 8192, dprCap: 2.0 },
      high: { maxGrid: 1536, minResM: 0.35, textureCap: 8192, dprCap: 2.0 },
      medium: { maxGrid: 1024, minResM: 0.50, textureCap: 4096, dprCap: 1.5 },
      low: { maxGrid: 640, minResM: 0.80, textureCap: 4096, dprCap: 1.25 },
      minimal: { maxGrid: 384, minResM: 1.20, textureCap: 2048, dprCap: 1.0 },
    };
    const m = matrix[tier];
    const textureCap = maxTexProbe ? Math.min(m.textureCap, maxTexProbe) : m.textureCap;
    return { tier, ...m, textureCap, lowPower: extra.lowPower, reason };
  };

  if (isSoftware) return profile('minimal', 'software renderer', { lowPower: true });
  if (isMobile || isMobileGPU) return profile('low', 'mobile GPU', { lowPower: true });
  if (isOldIntel || (isMacIntel && (mem && mem < 4))) return profile('low', 'old Intel iGPU / small Mac', { lowPower: true });
  if (isMacIntel) return profile('medium', 'Intel Mac', { lowPower: false });
  if (mem && mem < 4) return profile('low', `low RAM (${mem} GB)`, { lowPower: true });
  if (mem && mem < 8) return profile('medium', `medium RAM (${mem} GB)`, { lowPower: false });
  if (cores && cores < 4) return profile('medium', `${cores} cores`, { lowPower: false });

  if (isAppleSilicon) return profile('masterpiece', 'Apple Silicon', { lowPower: false });
  if (mem >= 16 || (mem >= 8 && cores >= 8)) return profile('masterpiece', `${mem || '?'} GB RAM, ${cores} cores`, { lowPower: false });
  return profile('high', 'default high tier', { lowPower: false });
}

export function readBoundsFromLasHeader(buffer: ArrayBuffer): ParsedHeader | null {
  try {
    const view = new DataView(buffer);
    if (view.getUint32(0, false) !== 0x4C415346) return null;
    const maxX = view.getFloat64(179, true);
    const minX = view.getFloat64(187, true);
    const maxY = view.getFloat64(195, true);
    const minY = view.getFloat64(203, true);
    const maxZ = view.getFloat64(211, true);
    const minZ = view.getFloat64(219, true);
    if (![minX, maxX, minY, maxY, minZ, maxZ].every(Number.isFinite)) return null;
    if (maxX <= minX || maxY <= minY) return null;
    const bounds: PointCloudBounds = { minX, maxX, minY, maxY, minZ, maxZ };
    const crs = detectCrs(minY, maxY);
    return { bounds, crs };
  } catch {
    return null;
  }
}
