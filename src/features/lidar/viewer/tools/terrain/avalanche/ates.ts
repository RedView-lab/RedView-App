// ============================================
// Outils du viewer LiDAR — classe ATES d'un point (classifieur AutoATES v2.0)
// ============================================
//
// Avalanche Terrain Exposure Scale v.2 (Statham & Campbell, 2025) : 0 terrain
// non avalancheux, 1 simple, 2 exigeant, 3 complexe, 4 extrême. Une note
// statique du terrain, quels que soient la neige et le temps du jour.
//
// AutoATES v2.0 (Toft et al., 2024) : la classe est la plus haute entre
//  - la classe de pente (≤ 15° → 0, 18°, 28°, puis > 39° sur la moyenne 3 × 3 → 4),
//  - la classe d'écoulement : atteint par l'écoulement peu fréquent (α 18°) → 1,
//    avec un angle de parcours ≥ 24° → 2, ≥ 33° → 3 (exposition par le haut),
// puis abaissée par la forêt (tableau 3) : canopée ouverte / clairsemée /
// moyenne / dense, les zones de départ étant moins abaissées que les zones d'écoulement.

import {
  ATES_ALPHA_THRESHOLDS_DEG,
  ATES_CANOPY_THRESHOLDS_PCT,
  ATES_SLOPE_THRESHOLDS_DEG,
} from './params';

export type AtesClass = 0 | 1 | 2 | 3 | 4;
export type CanopyClass = 'open' | 'sparse' | 'moderate' | 'dense';

export interface AtesInputs {
  slopeDeg: number;
  /** Pente moyennée sur 3 × 3 cellules (critère de la classe 4). */
  smoothedSlopeDeg: number;
  /** Angle de parcours de l'écoulement peu fréquent au point, `null` s'il n'est pas atteint. */
  runoutTravelAngleDeg: number | null;
  /** Couvert de canopée, %, `null` quand la forêt est inconnue (terrain ouvert supposé). */
  canopyPct: number | null;
  /** Le point est dans une zone de départ potentielle. */
  inReleaseArea: boolean;
}

export interface AtesRating {
  atesClass: AtesClass;
  slopeClass: AtesClass;
  runoutClass: AtesClass;
  /** Classe avant les critères de forêt. */
  terrainClass: AtesClass;
  canopyClass: CanopyClass | null;
}

/** Tableau 3 : classe après les critères de forêt, indexée par la classe avant (1–4). */
const FOREST_LOOKUP: Record<Exclude<CanopyClass, 'open'>, { release: AtesClass[]; runout: AtesClass[] }> = {
  sparse: { release: [0, 1, 1, 2, 3], runout: [0, 1, 1, 2, 3] },
  moderate: { release: [0, 1, 1, 2, 3], runout: [0, 1, 1, 1, 3] },
  dense: { release: [0, 1, 1, 1, 2], runout: [0, 1, 1, 1, 3] },
};

function canopyClassOf(canopyPct: number): CanopyClass {
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
