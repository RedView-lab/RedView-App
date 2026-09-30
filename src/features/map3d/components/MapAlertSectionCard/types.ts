import type { SteepAlertKind } from '@/features/itineraryPanel/types';

/** Données affichées par la popup d'un tronçon « Alertes » (pente). */
export interface MapAlertSection {
  /** Id de l'alerte (`<itineraryId>::alert::<index>`). */
  id: string;
  lng: number;
  lat: number;
  roadTypeLabel: string | null;
  coordinatesLabel: string;
  maxGradientPct: number;
  avgGradientPct: number;
  lengthM: number;
  elevationM: number | null;
  surfaceLabel: string | null;
  surfaceColor: string | null;
  itineraryColor: string;
  distanceLabel: string;
  durationLabel: string | null;
  clockLabel: string | null;
  kind: SteepAlertKind;
  /** « Retirer du parcours » n'a de sens que sur un tracé BRouter (zone interdite + recalcul). */
  canRemoveFromRoute: boolean;
}

export type MapAlertSectionActionId = 'change-kind' | 'remove-from-route' | 'ignore';

export interface MapAlertSectionActionPayload {
  action: MapAlertSectionActionId;
  section: MapAlertSection;
  kind?: SteepAlertKind;
}
