import { ROUTE_SLOPE_LEGEND_BANDS } from '@/features/controlPanel/lib/routeSlopeLegend';

/**
 * Échelle de colorisation « Pente » du profil d'altitude : la même que la
 * légende du tracé sur la carte (`ROUTE_SLOPE_LEGEND_BANDS`, -15 % → 15 %),
 * pour qu'un tronçon ait la même couleur sur le graphe et sur la carte.
 * La pente affichée est une moyenne par tronçon (voir `buildSlopeColorRuns`).
 * Descentes et plat restent estompés au remplissage pour que les montées
 * ressortent ; la ligne garde partout la couleur de la légende.
 */
export interface SlopeColorClass {
  id: string;
  /** Borne basse incluse (%) ; -Infinity pour la première classe. */
  minPct: number;
  /** Borne haute exclue (%) ; Infinity pour la dernière classe. */
  maxPct: number;
  color: string;
  /** Libellé (numérique, identique à la légende du tracé). */
  label: string;
  /** Classe de montée (pente ≥ 1 %) : remplissage plein, légende mise en avant. */
  climb: boolean;
}

export const SLOPE_COLOR_CLASSES: ReadonlyArray<SlopeColorClass> = ROUTE_SLOPE_LEGEND_BANDS.map((band) => ({
  id: band.id,
  minPct: band.minPct,
  maxPct: band.maxPct,
  color: band.color,
  label: band.label,
  climb: band.minPct > 0,
}));

/** Index de la classe « plat » (contient 0 %) : couleur neutre (pauses, données manquantes). */
export const SLOPE_NEUTRAL_CLASS_INDEX = Math.max(
  0,
  SLOPE_COLOR_CLASSES.findIndex((entry) => entry.minPct <= 0 && entry.maxPct > 0),
);

/** Index de classe pour une pente (%) ; les bornes basses sont incluses (9 % → 9–12). */
export function classifyGradientPct(gradientPct: number): number {
  if (!Number.isFinite(gradientPct)) return SLOPE_NEUTRAL_CLASS_INDEX;
  for (let index = SLOPE_COLOR_CLASSES.length - 1; index >= 0; index -= 1) {
    if (gradientPct >= SLOPE_COLOR_CLASSES[index]!.minPct) return index;
  }
  return 0;
}
