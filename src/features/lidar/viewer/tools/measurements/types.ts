// ============================================
// LiDAR viewer tools — measurement records
// ============================================

import type { AreaStats } from '../terrain/areaStats';
import type { AvalancheTerrainResult } from '../terrain/avalanche/exposure';
import type { FallLineResult, FallScenarioId } from '../terrain/fallLine';
import type { ProfileResult } from '../terrain/profile';
import type { ViewshedResult } from '../terrain/viewshed';
import type { ScenePick } from '../types';

interface MeasurementBase {
  id: string;
}

export type Measurement = MeasurementBase & (
  | { kind: 'distance'; vertices: ScenePick[]; profile: ProfileResult | null }
  | { kind: 'height'; a: ScenePick; b: ScenePick }
  | { kind: 'area'; vertices: ScenePick[]; stats: AreaStats | null }
  | { kind: 'profile'; vertices: ScenePick[]; profile: ProfileResult }
  | { kind: 'fallLine'; origin: ScenePick; result: FallLineResult; scenario: FallScenarioId }
  | { kind: 'avalanche'; origin: ScenePick; result: AvalancheTerrainResult }
  | { kind: 'viewshed'; origin: ScenePick; result: ViewshedResult }
  | { kind: 'pin'; at: ScenePick }
);

