import { translateAppText } from '@/shared/i18n';
import type { PoiCategory, TimelineItemKind } from '../../types';

/** French labels for the timeline type column. */
export function kindLabel(kind: TimelineItemKind, poiCategory?: PoiCategory): string {
  switch (kind) {
    case 'start':       return translateAppText('Départ');
    case 'end':         return translateAppText('Arrivée');
    case 'waypoint':    return translateAppText('Waypoint');
    case 'water':       return 'POI';
    case 'supermarket': return 'POI';
    case 'poi':         return poiCategory ? poiLabel(poiCategory) : 'POI';
    case 'pause':       return translateAppText('Pause');
    default:            return '';
  }
}

/** POI label (FR). */
export function poiLabel(category: PoiCategory): string {
  switch (category) {
    case 'fountains':    return translateAppText('Eau');
    case 'toilets':      return translateAppText('Toilettes');
    case 'supermarkets': return translateAppText('Supermarché');
    case 'gasStations':  return translateAppText('Carburant');
    case 'bakeries':     return translateAppText('Boulangerie');
    case 'fastFood':     return translateAppText('Fast-food');
    case 'cafes':        return translateAppText('Café');
    case 'bars':         return translateAppText('Bar');
    case 'restaurants':  return translateAppText('Restaurant');
    case 'bikeShops':    return translateAppText('Vélo');
    case 'hotels':       return translateAppText('Hôtel');
    case 'refuges':      return translateAppText('Refuge');
    case 'passes':       return translateAppText('Col');
    case 'health':       return translateAppText('Santé');
    case 'transport':    return translateAppText('Transport');
  }
}
