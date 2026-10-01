/**
 * Échelle de colorisation « Pente » du profil d'altitude (façon Komoot).
 *
 * Les paliers au-delà de 10 % sont resserrés (2 %) et changent à la fois de
 * teinte et de luminosité : 10–12 (vermillon), 12–14 (rouge écarlate),
 * 14–16 (cramoisi sombre) et 16 + (pourpre) restent distinguables d'un coup
 * d'œil, y compris sur le fond sombre du graphe. Les descentes et le plat
 * restent neutres pour que les montées ressortent.
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
  { id: 'descent', minPct: -Infinity, maxPct: -4, color: '#5B8BC9', label: 'Descente', climb: false },
  { id: 'flat', minPct: -4, maxPct: 4, color: '#7D8590', label: 'Plat', climb: false },
  { id: '4-6', minPct: 4, maxPct: 6, color: '#F4D35E', label: '4–6 %', climb: true },
  { id: '6-8', minPct: 6, maxPct: 8, color: '#F7A93B', label: '6–8 %', climb: true },
  { id: '8-10', minPct: 8, maxPct: 10, color: '#F57C2B', label: '8–10 %', climb: true },
  { id: '10-12', minPct: 10, maxPct: 12, color: '#EE4B23', label: '10–12 %', climb: true },
  { id: '12-14', minPct: 12, maxPct: 14, color: '#D9141E', label: '12–14 %', climb: true },
  { id: '14-16', minPct: 14, maxPct: 16, color: '#A3082E', label: '14–16 %', climb: true },
  { id: '16+', minPct: 16, maxPct: Infinity, color: '#7B1E7A', label: '16 % +', climb: true },
];

/** Index de la classe « plat » : couleur neutre (pauses, données manquantes). */
export const SLOPE_NEUTRAL_CLASS_INDEX = 1;

/** Index de classe pour une pente (%) ; les bornes basses sont incluses (12 % → 12–14). */
export function classifyGradientPct(gradientPct: number): number {
  if (!Number.isFinite(gradientPct)) return SLOPE_NEUTRAL_CLASS_INDEX;
  for (let index = SLOPE_COLOR_CLASSES.length - 1; index >= 0; index -= 1) {
    if (gradientPct >= SLOPE_COLOR_CLASSES[index]!.minPct) return index;
  }
  return 0;
}
