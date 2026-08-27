import type { GeoJSONSource, Map as MapboxMap } from 'mapbox-gl';
import type { FeatureCollection, Geometry } from 'geojson';

export const ANALYSIS_ZONE_DRAFT_SOURCE_ID = 'redview-analysis-zone-draft-source';
export const ANALYSIS_ZONE_DRAFT_FILL_LAYER_ID = 'redview-analysis-zone-draft-fill';
export const ANALYSIS_ZONE_DRAFT_LINE_LAYER_ID = 'redview-analysis-zone-draft-line';
export const ANALYSIS_ZONE_DRAFT_VERTEX_HALO_LAYER_ID = 'redview-analysis-zone-draft-vertex-halo';
export const ANALYSIS_ZONE_DRAFT_VERTEX_LAYER_ID = 'redview-analysis-zone-draft-vertex';
export const ANALYSIS_ZONE_DRAFT_FIRST_VERTEX_LAYER_ID = 'redview-analysis-zone-draft-first-vertex';

const ACCENT = '#890000';

function canMutateStyle(map: MapboxMap): boolean {
  try {
    return Boolean(map.getStyle());
  } catch {
    return false;
  }
}

function ensureDraftLayers(map: MapboxMap): GeoJSONSource | null {
  if (!canMutateStyle(map)) return null;

  try {
    if (!map.getSource(ANALYSIS_ZONE_DRAFT_SOURCE_ID)) {
      map.addSource(ANALYSIS_ZONE_DRAFT_SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }

    if (!map.getLayer(ANALYSIS_ZONE_DRAFT_FILL_LAYER_ID)) {
      map.addLayer({
        id: ANALYSIS_ZONE_DRAFT_FILL_LAYER_ID,
        type: 'fill',
        source: ANALYSIS_ZONE_DRAFT_SOURCE_ID,
        slot: 'top',
        filter: ['==', '$type', 'Polygon'],
        layout: { visibility: 'visible' },
        paint: {
          'fill-color': ACCENT,
          'fill-opacity': 0.14,
        },
      } as Parameters<MapboxMap['addLayer']>[0]);
    }

    if (!map.getLayer(ANALYSIS_ZONE_DRAFT_LINE_LAYER_ID)) {
      map.addLayer({
        id: ANALYSIS_ZONE_DRAFT_LINE_LAYER_ID,
        type: 'line',
        source: ANALYSIS_ZONE_DRAFT_SOURCE_ID,
        slot: 'top',
        filter: ['==', '$type', 'LineString'],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          visibility: 'visible',
        },
        paint: {
          'line-color': ACCENT,
          'line-width': 2,
          'line-dasharray': [2, 1.5],
        },
      } as Parameters<MapboxMap['addLayer']>[0]);
    }

    if (!map.getLayer(ANALYSIS_ZONE_DRAFT_VERTEX_HALO_LAYER_ID)) {
      map.addLayer({
        id: ANALYSIS_ZONE_DRAFT_VERTEX_HALO_LAYER_ID,
        type: 'circle',
        source: ANALYSIS_ZONE_DRAFT_SOURCE_ID,
        slot: 'top',
        filter: ['all', ['==', '$type', 'Point'], ['!=', 'isFirst', true]],
        layout: { visibility: 'visible' },
        paint: {
          'circle-radius': 5.5,
          'circle-color': '#ffffff',
          'circle-opacity': 0.95,
        },
      } as Parameters<MapboxMap['addLayer']>[0]);
    }

    if (!map.getLayer(ANALYSIS_ZONE_DRAFT_VERTEX_LAYER_ID)) {
      map.addLayer({
        id: ANALYSIS_ZONE_DRAFT_VERTEX_LAYER_ID,
        type: 'circle',
        source: ANALYSIS_ZONE_DRAFT_SOURCE_ID,
        slot: 'top',
        filter: ['all', ['==', '$type', 'Point'], ['!=', 'isFirst', true]],
        layout: { visibility: 'visible' },
        paint: {
          'circle-radius': 3.5,
          'circle-color': ACCENT,
        },
      } as Parameters<MapboxMap['addLayer']>[0]);
    }

    if (!map.getLayer(ANALYSIS_ZONE_DRAFT_FIRST_VERTEX_LAYER_ID)) {
      map.addLayer({
        id: ANALYSIS_ZONE_DRAFT_FIRST_VERTEX_LAYER_ID,
        type: 'circle',
        source: ANALYSIS_ZONE_DRAFT_SOURCE_ID,
        slot: 'top',
        filter: ['all', ['==', '$type', 'Point'], ['==', 'isFirst', true]],
        layout: { visibility: 'visible' },
        paint: {
          'circle-radius': ['case', ['boolean', ['get', 'isNear'], false], 9, 6.5],
          'circle-color': '#ffffff',
          'circle-stroke-color': ACCENT,
          'circle-stroke-width': ['case', ['boolean', ['get', 'isNear'], false], 3, 2],
        },
      } as Parameters<MapboxMap['addLayer']>[0]);
    }

    return map.getSource(ANALYSIS_ZONE_DRAFT_SOURCE_ID) as GeoJSONSource | null;
  } catch {
    return null;
  }
}

export function buildDraftGeoJson(
  points: Array<{ lon: number; lat: number }>,
  cursor: { lon: number; lat: number } | null,
  isNearFirstPoint = false,
): FeatureCollection<Geometry> {
  const features: FeatureCollection<Geometry>['features'] = [];

  if (points.length === 0) {
    return { type: 'FeatureCollection', features };
  }

  // Full coordinate sequence including live cursor
  const lineCoords: [number, number][] = points.map((p) => [p.lon, p.lat]);
  if (cursor) {
    lineCoords.push([cursor.lon, cursor.lat]);
  }

  // 1. Polygon Fill preview when we have at least 2 points + cursor, or >= 3 points
  if (lineCoords.length >= 3) {
    const polygonCoords = [...lineCoords, lineCoords[0]];
    features.push({
      type: 'Feature',
      properties: { kind: 'draft-fill' },
      geometry: {
        type: 'Polygon',
        coordinates: [polygonCoords],
      },
    });
  }

  // 2. LineString connecting the points + rubberband
  if (lineCoords.length >= 2) {
    features.push({
      type: 'Feature',
      properties: { kind: 'draft-line' },
      geometry: {
        type: 'LineString',
        coordinates: lineCoords,
      },
    });

    // If >= 3 points, also draw a faint closing dashed line back to origin
    if (lineCoords.length >= 3) {
      features.push({
        type: 'Feature',
        properties: { kind: 'closing-line' },
        geometry: {
          type: 'LineString',
          coordinates: [lineCoords[lineCoords.length - 1], lineCoords[0]],
        },
      });
    }
  }

  // 3. Vertices
  points.forEach((p, idx) => {
    const isFirst = idx === 0;
    features.push({
      type: 'Feature',
      properties: {
        kind: 'vertex',
        index: idx,
        isFirst,
        isNear: isFirst && isNearFirstPoint,
      },
      geometry: {
        type: 'Point',
        coordinates: [p.lon, p.lat],
      },
    });
  });

  return { type: 'FeatureCollection', features };
}

export function setAnalysisZoneDraftData(
  map: MapboxMap,
  points: Array<{ lon: number; lat: number }>,
  cursor: { lon: number; lat: number } | null = null,
  isNearFirstPoint = false,
): void {
  if (!canMutateStyle(map)) return;

  try {
    const source = ensureDraftLayers(map);
    if (!source) return;

    const data = buildDraftGeoJson(points, cursor, isNearFirstPoint);
    source.setData(data);
  } catch {
    /* style transitioning */
  }
}

export function clearAnalysisZoneDraft(map: MapboxMap): void {
  if (!canMutateStyle(map)) return;

  try {
    const source = ensureDraftLayers(map);
    source?.setData({ type: 'FeatureCollection', features: [] });
  } catch {
    /* noop */
  }
}

export function removeAnalysisZoneDraftLayers(map: MapboxMap): void {
  try {
    if (map.getLayer(ANALYSIS_ZONE_DRAFT_FIRST_VERTEX_LAYER_ID)) {
      map.removeLayer(ANALYSIS_ZONE_DRAFT_FIRST_VERTEX_LAYER_ID);
    }
    if (map.getLayer(ANALYSIS_ZONE_DRAFT_VERTEX_LAYER_ID)) {
      map.removeLayer(ANALYSIS_ZONE_DRAFT_VERTEX_LAYER_ID);
    }
    if (map.getLayer(ANALYSIS_ZONE_DRAFT_VERTEX_HALO_LAYER_ID)) {
      map.removeLayer(ANALYSIS_ZONE_DRAFT_VERTEX_HALO_LAYER_ID);
    }
    if (map.getLayer(ANALYSIS_ZONE_DRAFT_LINE_LAYER_ID)) {
      map.removeLayer(ANALYSIS_ZONE_DRAFT_LINE_LAYER_ID);
    }
    if (map.getLayer(ANALYSIS_ZONE_DRAFT_FILL_LAYER_ID)) {
      map.removeLayer(ANALYSIS_ZONE_DRAFT_FILL_LAYER_ID);
    }
    if (map.getSource(ANALYSIS_ZONE_DRAFT_SOURCE_ID)) {
      map.removeSource(ANALYSIS_ZONE_DRAFT_SOURCE_ID);
    }
  } catch {
    /* noop */
  }
}
