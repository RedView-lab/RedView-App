/**
 * Mapbox layers rendering the committed analysis zone: a translucent fill
 * plus a dashed accent outline, kept above the terrain overlays (`slot:
 * 'top'`) so the boundary stays readable over the slope / altitude / sunlight
 * rasters. Re-created after `style.load` (basemap switches) like every other
 * imperative layer in the app.
 */

import type { GeoJSONSource, Map as MapboxMap } from 'mapbox-gl';

import { analysisZoneRing, type AnalysisZone } from './geometry';

export const ANALYSIS_ZONE_SOURCE_ID = 'redview-analysis-zone-source';
export const ANALYSIS_ZONE_FILL_LAYER_ID = 'redview-analysis-zone-fill-layer';
export const ANALYSIS_ZONE_LINE_LAYER_ID = 'redview-analysis-zone-line-layer';

const ACCENT = '#890000';

function canMutateStyle(map: MapboxMap): boolean {
  try {
    return Boolean(map.getStyle());
  } catch {
    return false;
  }
}

function ensureAnalysisZoneLayers(map: MapboxMap): GeoJSONSource | null {
  if (!canMutateStyle(map)) return null;

  try {
    if (!map.getSource(ANALYSIS_ZONE_SOURCE_ID)) {
      map.addSource(ANALYSIS_ZONE_SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!map.getLayer(ANALYSIS_ZONE_FILL_LAYER_ID)) {
      map.addLayer({
        id: ANALYSIS_ZONE_FILL_LAYER_ID,
        type: 'fill',
        source: ANALYSIS_ZONE_SOURCE_ID,
        slot: 'top',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': ACCENT,
          'fill-opacity': 0.09,
        },
      } as Parameters<MapboxMap['addLayer']>[0]);
    }
    if (!map.getLayer(ANALYSIS_ZONE_LINE_LAYER_ID)) {
      map.addLayer({
        id: ANALYSIS_ZONE_LINE_LAYER_ID,
        type: 'line',
        source: ANALYSIS_ZONE_SOURCE_ID,
        slot: 'top',
        layout: { visibility: 'none' },
        paint: {
          'line-color': ACCENT,
          'line-width': 2,
          'line-dasharray': [2, 1.5],
        },
      } as Parameters<MapboxMap['addLayer']>[0]);
    }
    return map.getSource(ANALYSIS_ZONE_SOURCE_ID) as GeoJSONSource | null;
  } catch {
    return null;
  }
}

export function setAnalysisZoneLayerData(map: MapboxMap, zone: AnalysisZone | null): void {
  if (!canMutateStyle(map)) return;

  try {
    const source = ensureAnalysisZoneLayers(map);
    if (!source) return;

    if (zone) {
      source.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'Polygon',
              coordinates: [analysisZoneRing(zone)],
            },
          },
        ],
      });
      if (map.getLayer(ANALYSIS_ZONE_FILL_LAYER_ID)) {
        map.setLayoutProperty(ANALYSIS_ZONE_FILL_LAYER_ID, 'visibility', 'visible');
        map.moveLayer(ANALYSIS_ZONE_FILL_LAYER_ID);
      }
      if (map.getLayer(ANALYSIS_ZONE_LINE_LAYER_ID)) {
        map.setLayoutProperty(ANALYSIS_ZONE_LINE_LAYER_ID, 'visibility', 'visible');
        map.moveLayer(ANALYSIS_ZONE_LINE_LAYER_ID);
      }
      return;
    }

    source.setData({ type: 'FeatureCollection', features: [] });
    if (map.getLayer(ANALYSIS_ZONE_FILL_LAYER_ID)) {
      map.setLayoutProperty(ANALYSIS_ZONE_FILL_LAYER_ID, 'visibility', 'none');
    }
    if (map.getLayer(ANALYSIS_ZONE_LINE_LAYER_ID)) {
      map.setLayoutProperty(ANALYSIS_ZONE_LINE_LAYER_ID, 'visibility', 'none');
    }
  } catch {
    /* style may be transitioning */
  }
}

export function removeAnalysisZoneLayers(map: MapboxMap): void {
  try {
    if (map.getLayer(ANALYSIS_ZONE_LINE_LAYER_ID)) map.removeLayer(ANALYSIS_ZONE_LINE_LAYER_ID);
    if (map.getLayer(ANALYSIS_ZONE_FILL_LAYER_ID)) map.removeLayer(ANALYSIS_ZONE_FILL_LAYER_ID);
    if (map.getSource(ANALYSIS_ZONE_SOURCE_ID)) map.removeSource(ANALYSIS_ZONE_SOURCE_ID);
  } catch {
    /* style may be transitioning */
  }
}
