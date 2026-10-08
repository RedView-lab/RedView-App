/**
 * Règle de légende partagée par les rendus de l'ensoleillement cumulé (worker
 * de la surcouche de carte et visualiseur LiDAR), pour qu'une même exposition
 * tombe toujours dans la même bande : les bandes sont triées par `minMinutes`,
 * une valeur appartient à la première bande dont elle n'a pas atteint
 * `maxMinutes`, et tout ce qui dépasse reste dans la dernière bande. Zéro minute
 * est une vraie valeur (la première bande de la légende commence à 0).
 */
export interface SunlightBandRange {
  minMinutes: number;
  maxMinutes: number;
}

export function sortSunlightBands<T extends SunlightBandRange>(bands: readonly T[]): T[] {
  return [...bands].sort((a, b) => a.minMinutes - b.minMinutes);
}

/** Indice dans `sortedBands` (voir `sortSunlightBands`), -1 quand il n'y a pas de bande. */
export function sunlightBandIndex(minutes: number, sortedBands: readonly SunlightBandRange[]): number {
  const last = sortedBands.length - 1;
  for (let b = 0; b < last; b++) {
    if (minutes < sortedBands[b]!.maxMinutes) return b;
  }
  return last;
}
