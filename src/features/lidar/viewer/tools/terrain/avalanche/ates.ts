// ============================================
// LiDAR viewer tools — ATES class of a point (AutoATES v2.0 classifier)
// ============================================
//
// Avalanche Terrain Exposure Scale v.2 (Statham & Campbell, 2025): 0 non-
// avalanche, 1 simple, 2 challenging, 3 complex, 4 extreme terrain. A
// static rating of the terrain, whatever the snow and weather of the day.
//
// AutoATES v2.0 (Toft et al., 2024): the class is the highest of
//  - the slope class (≤ 15° → 0, 18°, 28°, then > 39° on the 3 × 3 mean → 4),
//  - the runout class: reached by the infrequent (α 18°) runout → 1, with a
//    flow-path travel angle ≥ 24° → 2, ≥ 33° → 3 (overhead exposure),
// then lowered by the forest (Table 3): canopy open / sparse / moderate /
// dense, with release areas lowered less than runout zones.

import {
  ATES_ALPHA_THRESHOLDS_DEG,
  ATES_CANOPY_THRESHOLDS_PCT,
  ATES_SLOPE_THRESHOLDS_DEG,
} from './params';

export type AtesClass = 0 | 1 | 2 | 3 | 4;
export type CanopyClass = 'open' | 'sparse' | 'moderate' | 'dense';

export interface AtesInputs {
  slopeDeg: number;
  /** Slope averaged over 3 × 3 cells (class 4 criterion). */
  smoothedSlopeDeg: number;
  /** Flow-path travel angle of the infrequent runout at the point, `null` if not reached. */
  runoutTravelAngleDeg: number | null;
  /** Canopy cover, %, `null` when the forest is unknown (open terrain assumed). */
  canopyPct: number | null;
  /** The point lies in a potential release area. */
  inReleaseArea: boolean;
}

export interface AtesRating {
  atesClass: AtesClass;
  slopeClass: AtesClass;
  runoutClass: AtesClass;
  /** Class before the forest criteria. */
  terrainClass: AtesClass;
  canopyClass: CanopyClass | null;
}

/** Table 3: class after the forest criteria, indexed by the class before (1–4). */
const FOREST_LOOKUP: Record<Exclude<CanopyClass, 'open'>, { release: AtesClass[]; runout: AtesClass[] }> = {
  sparse: { release: [0, 1, 1, 2, 3], runout: [0, 1, 1, 2, 3] },
  moderate: { release: [0, 1, 1, 2, 3], runout: [0, 1, 1, 1, 3] },
  dense: { release: [0, 1, 1, 1, 2], runout: [0, 1, 1, 1, 3] },
};

export function canopyClassOf(canopyPct: number): CanopyClass {
  const { tree1, tree2, tree3 } = ATES_CANOPY_THRESHOLDS_PCT;
  if (canopyPct <= tree1) return 'open';
  if (canopyPct <= tree2) return 'sparse';
  if (canopyPct <= tree3) return 'moderate';
  return 'dense';
}

export function rateAtes(input: AtesInputs): AtesRating {
  const { sat01, sat12, sat23, sat34 } = ATES_SLOPE_THRESHOLDS_DEG;
  const slope = Number.isFinite(input.slopeDeg) ? input.slopeDeg : 0;
  let slopeClass: AtesClass = slope <= sat01 ? 0 : slope <= sat12 ? 1 : slope <= sat23 ? 2 : 3;
  if (input.smoothedSlopeDeg > sat34) slopeClass = 4;

  const angle = input.runoutTravelAngleDeg;
  const { aat12, aat23 } = ATES_ALPHA_THRESHOLDS_DEG;
  const runoutClass: AtesClass = angle == null ? 0 : angle >= aat23 ? 3 : angle >= aat12 ? 2 : 1;

  const terrainClass = Math.max(slopeClass, runoutClass) as AtesClass;
  const canopyClass = input.canopyPct == null ? null : canopyClassOf(input.canopyPct);
  let atesClass = terrainClass;
  if (canopyClass && canopyClass !== 'open') {
    const table = FOREST_LOOKUP[canopyClass];
    atesClass = (input.inReleaseArea ? table.release : table.runout)[terrainClass]!;
  }
  return { atesClass, slopeClass, runoutClass, terrainClass, canopyClass };
}
