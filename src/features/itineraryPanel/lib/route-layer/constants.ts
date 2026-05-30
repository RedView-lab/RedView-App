import type { Map as MapboxMap } from 'mapbox-gl';

export const SOURCE_PREFIX = 'brouter-route-source-';
export const GLOW_PREFIX = 'brouter-route-glow-';
export const LINE_PREFIX = 'brouter-route-line-';

export const START_SOURCE_ID = 'brouter-endpoints-source';
export const ENDPOINT_LAYER_ID = 'brouter-endpoints-layer';
/** Invisible, larger circle layer that makes the endpoint handles easy to grab + drag. */
export const ENDPOINT_HANDLE_HIT_LAYER_ID = 'brouter-endpoints-hit-layer';
/** Dashed rubber-band shown while dragging a handle (prev -> cursor -> next). */
export const WAYPOINT_DRAG_CONNECTOR_SOURCE_ID = 'brouter-waypoint-drag-connector-source';
export const WAYPOINT_DRAG_CONNECTOR_LAYER_ID = 'brouter-waypoint-drag-connector-layer';
export const ANALYSIS_HOVER_SOURCE_ID = 'brouter-analysis-hover-source';
export const ANALYSIS_HOVER_HALO_LAYER_ID = 'brouter-analysis-hover-halo-layer';
export const ANALYSIS_HOVER_POINT_LAYER_ID = 'brouter-analysis-hover-point-layer';
export const ANALYSIS_FLYOVER_PROGRESS_SOURCE_ID = 'brouter-analysis-flyover-progress-source';
export const ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID = 'brouter-analysis-flyover-progress-glow-layer';
export const ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID = 'brouter-analysis-flyover-progress-line-layer';
export const ROUTE_AUDIT_SOURCE_ID = 'brouter-route-audit-source';
export const ROUTE_AUDIT_GLOW_LAYER_ID = 'brouter-route-audit-glow-layer';
export const ROUTE_AUDIT_LINE_LAYER_ID = 'brouter-route-audit-line-layer';
export const FORBIDDEN_ZONE_SOURCE_ID = 'brouter-forbidden-zone-source';
export const FORBIDDEN_ZONE_FILL_LAYER_ID = 'brouter-forbidden-zone-fill-layer';
export const FORBIDDEN_ZONE_LINE_LAYER_ID = 'brouter-forbidden-zone-line-layer';
export const FORBIDDEN_ZONE_DRAFT_SOURCE_ID = 'brouter-forbidden-zone-draft-source';
export const FORBIDDEN_ZONE_DRAFT_FILL_LAYER_ID = 'brouter-forbidden-zone-draft-fill-layer';
export const FORBIDDEN_ZONE_DRAFT_LINE_LAYER_ID = 'brouter-forbidden-zone-draft-line-layer';
export const FORBIDDEN_ZONE_DRAFT_VERTEX_HALO_LAYER_ID = 'brouter-forbidden-zone-draft-vertex-halo-layer';
export const FORBIDDEN_ZONE_DRAFT_VERTEX_LAYER_ID = 'brouter-forbidden-zone-draft-vertex-layer';
export const FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID = 'brouter-forbidden-zone-draft-vertex-hit-layer';
export const FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID = 'brouter-forbidden-zone-draft-segment-hit-layer';

export function canMutateStyle(map: MapboxMap): boolean {
  try {
    // Mapbox 3.x can keep isStyleLoaded() false during repeated styledata
    // churn even though the style object is already usable for addSource /
    // addLayer / setData. Route replay runs on styledata specifically to
    // survive those transitions, so use the same lenient gate here.
    return Boolean(map.getStyle());
  } catch {
    return false;
  }
}

export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function ids(itineraryId: string) {
  const safe = sanitizeId(itineraryId);
  return {
    source: `${SOURCE_PREFIX}${safe}`,
    glow: `${GLOW_PREFIX}${safe}`,
    line: `${LINE_PREFIX}${safe}`,
  };
}