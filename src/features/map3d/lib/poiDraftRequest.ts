/**
 * Ouvre la carte de brouillon de POI de la carte (« Créer un POI » du menu
 * contextuel) en un point choisi hors de la carte — le « Ajouter › POI » du
 * graphique d'analyse. La carte de brouillon appartient à `MapView` ; elle
 * s'ouvre une fois que la caméra s'est posée sur le point.
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
