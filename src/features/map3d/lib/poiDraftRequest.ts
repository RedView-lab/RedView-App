/**
 * Opens the map's POI draft card (« Créer un POI » of the context menu) at a
 * point chosen outside the map — the analysis chart's « Ajouter › POI ». The
 * card belongs to `MapView`; it opens once the camera has landed on the point.
 */
const MAP_POI_DRAFT_REQUEST_EVENT = 'redview:map-poi-draft-request';

export interface MapPoiDraftRequest {
  lat: number;
  lon: number;
}

export function requestMapPoiDraft(detail: MapPoiDraftRequest): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<MapPoiDraftRequest>(MAP_POI_DRAFT_REQUEST_EVENT, { detail }));
}

export function listenMapPoiDraftRequest(listener: (detail: MapPoiDraftRequest) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const handler = (event: Event) => {
    const detail = (event as CustomEvent<MapPoiDraftRequest>).detail;
    if (!detail || !Number.isFinite(detail.lat) || !Number.isFinite(detail.lon)) return;
    listener(detail);
  };

  window.addEventListener(MAP_POI_DRAFT_REQUEST_EVENT, handler);
  return () => window.removeEventListener(MAP_POI_DRAFT_REQUEST_EVENT, handler);
}
