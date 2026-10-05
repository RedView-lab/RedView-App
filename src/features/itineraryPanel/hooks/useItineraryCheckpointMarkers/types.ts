import type { Marker, Popup } from 'mapbox-gl';

export type CheckpointKind = 'start' | 'end' | 'pause' | 'waypoint';

export interface CheckpointData {
  key: string;
  kind: CheckpointKind;
  coord: [number, number];
  label: string;
  itineraryId: string;
  signature: string;
  pauseId?: string;
  waypointId?: string;
  /** Id de la ligne de timeline portée par ce marqueur (départ / arrivée / waypoint). */
  rowId?: string;
  durationMin?: number | null;
  distanceKm?: number | null;
  favorite?: boolean;
  /** Départ : heure de départ ; arrivée : heure d'arrivée estimée (pauses incluses). */
  timeLabel?: string | null;
  /** Arrivée : durée totale estimée (pauses incluses). */
  durationLabel?: string | null;
  /** Départ / arrivée : une étape placée peut prendre sa place, le point est supprimable. */
  removable?: boolean;
}

/** Données courantes d'un marqueur, relues par sa popup à chaque ouverture. */
export interface CheckpointDataRef {
  current: CheckpointData;
}

export interface CheckpointPopupHandle {
  popup: Popup;
  /** Resynchronise le contenu depuis `CheckpointDataRef` (si la popup est ouverte). */
  sync: () => void;
}

/**
 * Ouvre la popup d'un marqueur de checkpoint. `scope` restreint la recherche à
 * un itinéraire : sans lui, « start » / « end » tombaient sur le premier
 * itinéraire du registre, pas forcément l'actif.
 */
export type OpenCheckpointMarker = (
  checkpointId: string,
  coords?: { lat: number; lon: number },
  scope?: { itineraryId?: string | null; kind?: CheckpointKind },
) => boolean;

export interface MarkerRegistryEntry {
  marker: Marker;
  popup?: Popup;
  syncPopup?: () => void;
  dataRef: CheckpointDataRef;
  signature: string;
  element: HTMLElement;
  kind: CheckpointKind;
}
