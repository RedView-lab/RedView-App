// ============================================
// LiDAR viewer tools — fall line wording (3D label)
// ============================================

import { formatDistance } from '../format';
import type { OverlayLabelTone } from '../overlay/toolsOverlay';
import type { FallExposure, FallScenarioResult } from '../terrain/fallLine';

export const FALL_EXPOSURE_TONES: Record<FallExposure, OverlayLabelTone> = {
  none: 'ok',
  E1: 'warning',
  E2: 'warning',
  E3: 'danger',
  E4: 'danger',
};

/** Toponeige exposure (consequence of a fall), "—" when nothing slides. */
export function fallExposureTag(exposure: FallExposure): string {
  return exposure === 'none' ? '—' : exposure;
}

/** Runout of the nominal trajectory, "> " when it leaves the loaded area. */
export function fallRunoutText(scenario: FallScenarioResult): string {
  const beyond = scenario.end === 'edge' || scenario.end === 'maxLength';
  const meters = scenario.lengthM;
  return `${beyond ? '> ' : ''}${meters < 10 ? `${Math.round(meters)} m` : formatDistance(meters)}`;
}
