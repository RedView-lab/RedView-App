import { useEffect } from 'react';
import type { Map as MapboxMap, MapboxGeoJSONFeature, PointLike } from 'mapbox-gl';

const IGNORED_LAYER_PREFIXES = [
  'route-',
  'tracer-',
  'draw-',
  'gl-draw',
  'mapbox-gl-draw',
  'elevation-',
  'lidar-',
  'redview-',
  'context-menu',
  'highlight',
  'selection',
  'custom-',
];

const POI_SOURCE_LAYERS = new Set([
  'poi_label',
  'place_label',
  'natural_label',
  'airport_label',
  'transit_label',
  'landuse_overlay',
  'road_label',
  'waterway_label',
  'motorway_junction',
]);

const POI_LAYER_PATTERNS = [
  /poi/i,
  /place/i,
  /settlement/i,
  /landmark/i,
  /park/i,
  /natural/i,
  /peak/i,
  /mountain/i,
  /town/i,
  /village/i,
  /hamlet/i,
  /suburb/i,
  /island/i,
  /locality/i,
  /label/i,
  /cave/i,
  /viewpoint/i,
  /attraction/i,
  /tourism/i,
  /food/i,
  /drink/i,
  /lodging/i,
  /hotel/i,
  /symbol/i,
];

export function getFeatureName(feature: MapboxGeoJSONFeature): string | null {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const candidateKeys = [
    'name_fr',
    'name:fr',
    'name',
    'name_en',
    'name:en',
    'name:latin',
    'name_de',
    'name_es',
    'name_it',
    'local_name',
    'title',
    'label',
    'alt_name',
    'ref',
    'brand',
    'description',
  ];

  for (const key of candidateKeys) {
    const val = props[key];
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
  }
  return null;
}

export function isPoiFeatureCandidate(feature: MapboxGeoJSONFeature): boolean {
  const layerId = feature.layer?.id ?? '';
  if (IGNORED_LAYER_PREFIXES.some((prefix) => layerId.startsWith(prefix))) {
    return false;
  }
  if (
    feature.layer?.type === 'background'
    || feature.layer?.type === 'raster'
    || feature.layer?.type === 'hillshade'
  ) {
    return false;
  }

  const name = getFeatureName(feature);
  if (!name) return false;

  const sourceLayer = (feature as unknown as { sourceLayer?: string }).sourceLayer ?? '';
  if (POI_SOURCE_LAYERS.has(sourceLayer)) {
    return true;
  }

  if (feature.layer?.type === 'symbol') {
    return true;
  }

  if (POI_LAYER_PATTERNS.some((pattern) => pattern.test(layerId) || pattern.test(sourceLayer))) {
    return true;
  }

  // Any named feature on a vector/geojson layer
  return true;
}

export function scorePoiFeature(feature: MapboxGeoJSONFeature): number {
  let score = 0;
  const layerId = feature.layer?.id?.toLowerCase() ?? '';
  const sourceLayer = ((feature as unknown as { sourceLayer?: string }).sourceLayer ?? '').toLowerCase();
  const props = (feature.properties ?? {}) as Record<string, unknown>;

  if (props.name_fr || props['name:fr']) score += 60;
  if (props.name) score += 50;
  if (props.name_en) score += 20;

  if (sourceLayer === 'poi_label') score += 120;
  else if (sourceLayer === 'natural_label') score += 110;
  else if (sourceLayer === 'place_label') score += 100;
  else if (sourceLayer === 'transit_label') score += 70;
  else if (sourceLayer === 'road_label') score += 40;

  if (layerId.includes('poi')) score += 60;
  if (layerId.includes('natural') || layerId.includes('cave')) score += 55;
  if (layerId.includes('peak') || layerId.includes('mountain')) score += 50;
  if (layerId.includes('place') || layerId.includes('settlement')) score += 45;

  if (feature.layer?.type === 'symbol') score += 30;

  return score;
}

export function findNamedPoiFeature(
  features: MapboxGeoJSONFeature[],
): { name: string; feature: MapboxGeoJSONFeature } | null {
  const candidates = features.filter(isPoiFeatureCandidate);
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => scorePoiFeature(b) - scorePoiFeature(a));
  const best = sorted[0]!;
  const name = getFeatureName(best);
  if (!name) return null;

  return { name, feature: best };
}

export function openGoogleSearchForPoi(name: string): void {
  const query = name.trim();
  if (!query) return;
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function useMapPoiExternalLink(map: MapboxMap | null): void {
  useEffect(() => {
    if (!map) return;

    let startPoint: { x: number; y: number } | null = null;

    const onMouseDown = (e: mapboxgl.MapMouseEvent) => {
      startPoint = { x: e.point.x, y: e.point.y };
    };

    const onMouseMove = (e: mapboxgl.MapMouseEvent) => {
      const canvas = map.getCanvas();
      const currentCursor = canvas.style.cursor;
      if (
        currentCursor
        && currentCursor !== 'pointer'
        && currentCursor !== 'grab'
        && currentCursor !== ''
      ) {
        return;
      }

      const bbox: [PointLike, PointLike] = [
        [e.point.x - 16, e.point.y - 16],
        [e.point.x + 16, e.point.y + 16],
      ];
      try {
        const features = map.queryRenderedFeatures(bbox);
        const match = findNamedPoiFeature(features);
        if (match) {
          canvas.style.cursor = 'pointer';
        } else if (canvas.style.cursor === 'pointer') {
          canvas.style.cursor = '';
        }
      } catch {
        // Query rendered features may throw during rapid style switches
      }
    };

    const onClick = (e: mapboxgl.MapMouseEvent) => {
      if (e.originalEvent.button !== 0) return;

      // Check movement tolerance (prevent accidental triggers during drag/pan)
      if (startPoint) {
        const dist = Math.hypot(e.point.x - startPoint.x, e.point.y - startPoint.y);
        if (dist > 8) return;
      }

      const currentCursor = map.getCanvas().style.cursor;
      if (currentCursor.includes('edit-04') || currentCursor.includes('crosshair')) {
        return;
      }

      // Try tight bbox first (16px), then broader bbox (26px)
      const primaryBbox: [PointLike, PointLike] = [
        [e.point.x - 16, e.point.y - 16],
        [e.point.x + 16, e.point.y + 16],
      ];
      try {
        let features = map.queryRenderedFeatures(primaryBbox);
        let match = findNamedPoiFeature(features);
        if (!match) {
          const secondaryBbox: [PointLike, PointLike] = [
            [e.point.x - 26, e.point.y - 26],
            [e.point.x + 26, e.point.y + 26],
          ];
          features = map.queryRenderedFeatures(secondaryBbox);
          match = findNamedPoiFeature(features);
        }
        if (match) {
          openGoogleSearchForPoi(match.name);
        }
      } catch {
        // Catch gracefully
      }
    };

    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('click', onClick);

    return () => {
      map.off('mousedown', onMouseDown);
      map.off('mousemove', onMouseMove);
      map.off('click', onClick);
    };
  }, [map]);
}
