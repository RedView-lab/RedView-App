import { POI_LABELS } from '@/features/poi/types';
import { isRenamableTimelineItem, MAX_TIMELINE_NAME_LENGTH } from '../../sections/timeline/timelineNames';
import { kindLabel } from '../../sections/timeline/timelineKindLabels';
import type { Itinerary, TimelineItem } from '../../types';

/** Nom d'une ligne de POI avant toute saisie : celui du POI (OSM, import), sinon sa catégorie. */
function originalPoiRowLabel(itinerary: Itinerary, row: TimelineItem): string {
  const feature = row.osmId != null
    ? itinerary.poiFeatures?.find((candidate) => String(candidate.id) === String(row.osmId))
    : undefined;
  return feature?.name?.trim() || (feature ? POI_LABELS[feature.category] : undefined) || kindLabel(row.kind, row.poiCategory);
}

/**
 * Nom saisi dans la colonne « Nom » d'un POI (horaires, nom raccourci…) :
 * gardé tel quel, marqué `labelEdited` pour que la recherche POI ne
 * l'écrase pas et que l'export GPS le reprenne. Un nom vide ou identique au
 * nom d'origine rend la ligne à ce nom. Mute `itinerary` ; false si rien n'a
 * changé.
 */
export function renamePoiTimelineRow(itinerary: Itinerary, id: string, input: string): boolean {
  const row = itinerary.timeline.find((candidate) => candidate.id === id);
  if (!row || !isRenamableTimelineItem(row)) return false;
  // eslint-disable-next-line no-control-regex
  const label = input.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TIMELINE_NAME_LENGTH);
  const original = row.labelEdited ? originalPoiRowLabel(itinerary, row) : row.label;

  if (!label || label === original) {
    if (!row.labelEdited) return false;
    row.label = original;
    delete row.labelEdited;
    return true;
  }
  if (row.labelEdited && row.label === label) return false;
  row.label = label;
  row.labelEdited = true;
  return true;
}
