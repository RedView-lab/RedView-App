import type { TimelineItem } from '../../types';

/** Longueur maximale d'un nom saisi (un GPS n'en affiche que 15 caractères). */
export const MAX_TIMELINE_NAME_LENGTH = 120;

/** Ligne de POI : son nom est modifiable (horaires, nom court…) et repris par l'export GPS. */
export function isRenamableTimelineItem(item: TimelineItem): boolean {
  return item.kind === 'poi' || item.kind === 'water' || item.kind === 'supermarket';
}
