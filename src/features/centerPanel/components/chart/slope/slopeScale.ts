/**
 * Échelle de colorisation « Pente » du profil d'altitude.
 *
 * Six classes seulement, calées sur la lecture d'un profil de col : la pente
 * affichée est une moyenne par tronçon (voir `buildSlopeColorRuns`), donc des
 * paliers de 3 % suffisent et restent lisibles d'un coup d'œil. Descente et
 * plat restent neutres (et estompés au rendu) pour que les montées ressortent ;
 * au-delà de 12 %, le pourpre se détache nettement du rouge.
 */
export interface SlopeColorClass {
  id: string;
  /** Borne basse incluse (%) ; -Infinity pour la première classe. */
  minPct: number;
  /** Borne haute exclue (%) ; Infinity pour la dernière classe. */
  maxPct: number;
  color: string;
  /** Libellé source (FR), traduit via `t()`. */
  label: string;
  /** Classe de montée (comptée dans la répartition « montées »). */
  climb: boolean;
}

export const SLOPE_COLOR_CLASSES: ReadonlyArray<SlopeColorClass> = [
  { id: 'descent', minPct: -Infinity, maxPct: -3, color: '#5B8BC9', label: 'Descente', climb: false },
  { id: 'flat', minPct: -3, maxPct: 3, color: '#7D8590', label: 'Plat', climb: false },
  { id: '3-6', minPct: 3, maxPct: 6, color: '#F4D35E', label: '3–6 %', climb: true },
  { id: '6-9', minPct: 6, maxPct: 9, color: '#F7931E', label: '6–9 %', climb: true },
  { id: '9-12', minPct: 9, maxPct: 12, color: '#E5322D', label: '9–12 %', climb: true },
  { id: '12+', minPct: 12, maxPct: Infinity, color: '#B03CD0', label: '12 % +', climb: true },
];

/** Index de la classe « plat » : couleur neutre (pauses, données manquantes). */
export const SLOPE_NEUTRAL_CLASS_INDEX = 1;

/** Index de classe pour une pente (%) ; les bornes basses sont incluses (9 % → 9–12). */
export function classifyGradientPct(gradientPct: number): number {
  if (!Number.isFinite(gradientPct)) return SLOPE_NEUTRAL_CLASS_INDEX;
  for (let index = SLOPE_COLOR_CLASSES.length - 1; index >= 0; index -= 1) {
    if (gradientPct >= SLOPE_COLOR_CLASSES[index]!.minPct) return index;
  }
  return 0;
}
