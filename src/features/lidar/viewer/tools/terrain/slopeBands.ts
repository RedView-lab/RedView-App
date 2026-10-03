// ============================================
// LiDAR viewer tools — avalanche slope classes
// ============================================
//
// Classes of avalanche-terrain slope maps: most slab avalanches release on
// 30–45° slopes, with a peak at 35–40°; above 45° snow sluffs more than it
// builds slabs, and the consequence of a slip becomes the main hazard.

import type { Rgba } from '../types';

export interface SlopeBand {
  minDeg: number;
  color: string;
  rgba: Rgba;
}

export const SLOPE_BANDS: readonly SlopeBand[] = [
  { minDeg: 0, color: '#d9d9d9', rgba: [217, 217, 217, 255] },
  { minDeg: 30, color: '#f5d33f', rgba: [245, 211, 63, 255] },
  { minDeg: 35, color: '#f28a2e', rgba: [242, 138, 46, 255] },
  { minDeg: 40, color: '#e2342b', rgba: [226, 52, 43, 255] },
  { minDeg: 45, color: '#9b3fc4', rgba: [155, 63, 196, 255] },
];

export function slopeBandOf(slopeDeg: number): SlopeBand {
  for (let k = SLOPE_BANDS.length - 1; k > 0; k--) {
    if (slopeDeg >= SLOPE_BANDS[k]!.minDeg) return SLOPE_BANDS[k]!;
  }
  return SLOPE_BANDS[0]!;
}
