import type { Map as MapboxMap } from 'mapbox-gl';

export const SOURCE_PREFIX = 'brouter-route-source-';
export const CASING_PREFIX = 'brouter-route-casing-';
export const GLOW_PREFIX = 'brouter-route-glow-';
export const PAVED_PATTERN_PREFIX = 'brouter-route-paved-pattern-';
export const GRAVEL_PATTERN_PREFIX = 'brouter-route-gravel-pattern-';
export const DIRT_PATTERN_PREFIX = 'brouter-route-dirt-pattern-';
export const SAND_PATTERN_PREFIX = 'brouter-route-sand-pattern-';
export const LINE_PREFIX = 'brouter-route-line-';

export const ANALYSIS_HOVER_SOURCE_ID = 'brouter-analysis-hover-source';
export const ANALYSIS_HOVER_HALO_LAYER_ID = 'brouter-analysis-hover-halo-layer';
export const ANALYSIS_HOVER_POINT_LAYER_ID = 'brouter-analysis-hover-point-layer';

/**
 * Hover-preview marker shown while a central-panel tool (split / trace) is
 * armed. Distinct from ANALYSIS_HOVER_* so a chart-driven hover and a
 * tool-driven hover can coexist without clobbering each other.
 */
export const ROUTE_HOVER_PREVIEW_SOURCE_ID = 'brouter-route-hover-preview-source';
export const ROUTE_HOVER_PREVIEW_HALO_LAYER_ID = 'brouter-route-hover-preview-halo-layer';
export const ROUTE_HOVER_PREVIEW_POINT_LAYER_ID = 'brouter-route-hover-preview-point-layer';
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
    casing: `${CASING_PREFIX}${safe}`,
    glow: `${GLOW_PREFIX}${safe}`,
    pavedPattern: `${PAVED_PATTERN_PREFIX}${safe}`,
    gravelPattern: `${GRAVEL_PATTERN_PREFIX}${safe}`,
    dirtPattern: `${DIRT_PATTERN_PREFIX}${safe}`,
    sandPattern: `${SAND_PATTERN_PREFIX}${safe}`,
    line: `${LINE_PREFIX}${safe}`,
  };
}