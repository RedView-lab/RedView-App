import type { TracePointKind } from './traceEdits';

/**
 * Contrat DOM entre les marqueurs de tracé et les outils qui les manipulent.
 *
 * `useItineraryCheckpointMarkers` écrit ces `data-*` sur les poignées, et le
 * drag de l'outil Tracer les relit. Les deux côtés passent par ce module : la
 * conversion kebab-case → camelCase de `dataset` (source de panne silencieuse)
 * n'est donc écrite qu'une fois.
 */

/** Sélecteur des poignées déplaçables sur la carte. */
export const TRACE_POINT_SELECTOR = '[data-rv-trace-point]';

export interface TracePointHandle {
  itineraryId: string;
  rowId: string;
  kind: TracePointKind;
  lon: number;
  lat: number;
}

/** Marque une poignée comme déplaçable et publie son descriptif. */
export function writeTracePointDataset(
  dataset: DOMStringMap,
  handle: TracePointHandle,
): void {
  dataset.rvTracePoint = '1';
  dataset.rvItineraryId = handle.itineraryId;
  dataset.rvPointKind = handle.kind;
  dataset.rvRowId = handle.rowId;
  dataset.rvLon = handle.lon.toFixed(6);
  dataset.rvLat = handle.lat.toFixed(6);
}

/**
 * Relit le descriptif d'une poignée. Retourne `null` si l'élément n'est pas une
 * poignée de tracé, ou si son descriptif est incomplet / inexploitable.
 */
export function readTracePointDataset(dataset: DOMStringMap): TracePointHandle | null {
  const { rvItineraryId, rvRowId, rvPointKind, rvLon, rvLat } = dataset;
  if (!rvItineraryId || !rvRowId) return null;
  if (rvPointKind !== 'start' && rvPointKind !== 'end' && rvPointKind !== 'waypoint') return null;

  // Test explicite de vacuité : `Number('')` vaut 0, donc une coordonnée vide
  // serait sinon lue comme 0° — soit un point au large du golfe de Guinée.
  if (!rvLon || !rvLat) return null;
  const lon = Number(rvLon);
  const lat = Number(rvLat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

  return { itineraryId: rvItineraryId, rowId: rvRowId, kind: rvPointKind, lon, lat };
}
