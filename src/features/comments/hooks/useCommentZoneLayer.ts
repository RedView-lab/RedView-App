import { useEffect, useRef } from 'react';
import type { GeoJSONSource, Map as MapboxMap } from 'mapbox-gl';

import type { ProjectCommentZone } from '@/features/itineraryPanel/types';
import { canMutateStyle } from '@/features/itineraryPanel/lib/route-layer/constants';

import { closedRing } from '../lib/zoneGeometry';

/**
 * Zones commentées sur la carte : celle du fil survolé ou ouvert, et celle en
 * cours de tracé (pointillés), drapées sur le relief (remplissage + contour).
 * Comme chez Figma, une zone n'est dessinée que quand on s'intéresse à son
 * fil : la carte reste propre.
 *
 * `styledata` : idempotent (rien n'est touché si la source et les calques
 * sont là) — une écriture inconditionnelle relancerait `styledata` à chaque
 * image et viderait le cache de drapage du relief.
 */

export const COMMENT_ZONE_SOURCE_ID = 'rv-comment-zones';
const FILL_LAYER_ID = 'rv-comment-zones-fill';
const LINE_LAYER_ID = 'rv-comment-zones-line';
const DRAFT_LINE_LAYER_ID = 'rv-comment-zones-draft-line';
const ZONE_COLOR = '#c50000';

export interface CommentZoneShape {
  zone: ProjectCommentZone;
  /** Zone en cours de tracé ou de saisie : contour en pointillés. */
  draft: boolean;
}

function featureCollection(shapes: readonly CommentZoneShape[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: shapes.map(({ zone, draft }) => ({
      type: 'Feature',
      properties: { draft: draft ? 1 : 0 },
      geometry: { type: 'Polygon', coordinates: [closedRing(zone)] },
    })),
  };
}

function ensureLayers(map: MapboxMap): GeoJSONSource | null {
  if (!canMutateStyle(map)) return null;
  try {
    if (!map.getSource(COMMENT_ZONE_SOURCE_ID)) {
      map.addSource(COMMENT_ZONE_SOURCE_ID, { type: 'geojson', data: featureCollection([]) });
    }
    if (!map.getLayer(FILL_LAYER_ID)) {
      map.addLayer({
        id: FILL_LAYER_ID,
        type: 'fill',
        source: COMMENT_ZONE_SOURCE_ID,
        paint: { 'fill-color': ZONE_COLOR, 'fill-opacity': ['case', ['==', ['get', 'draft'], 1], 0.1, 0.14] },
      });
    }
    // Deux calques de contour : `line-dasharray` ne dépend pas des données.
    if (!map.getLayer(LINE_LAYER_ID)) {
      map.addLayer({
        id: LINE_LAYER_ID,
        type: 'line',
        source: COMMENT_ZONE_SOURCE_ID,
        filter: ['==', ['get', 'draft'], 0],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ZONE_COLOR, 'line-width': 2 },
      });
    }
    if (!map.getLayer(DRAFT_LINE_LAYER_ID)) {
      map.addLayer({
        id: DRAFT_LINE_LAYER_ID,
        type: 'line',
        source: COMMENT_ZONE_SOURCE_ID,
        filter: ['==', ['get', 'draft'], 1],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': ZONE_COLOR, 'line-width': 2, 'line-dasharray': [2, 1.5] },
      });
    }
    return (map.getSource(COMMENT_ZONE_SOURCE_ID) as GeoJSONSource | undefined) ?? null;
  } catch {
    return null;
  }
}

export function useCommentZoneLayer(map: MapboxMap | null, shapes: readonly CommentZoneShape[]): void {
  const key = JSON.stringify(shapes);
  const appliedRef = useRef<{ map: MapboxMap; key: string } | null>(null);
  const shapesRef = useRef(shapes);
  useEffect(() => {
    shapesRef.current = shapes;
  });

  useEffect(() => {
    if (!map) return;
    const apply = () => {
      const applied = appliedRef.current;
      const sourceMissing = !map.getSource(COMMENT_ZONE_SOURCE_ID) || !map.getLayer(DRAFT_LINE_LAYER_ID);
      // Rien à dessiner et rien de dessiné : on ne touche pas au style.
      if (sourceMissing && shapesRef.current.length === 0) return;
      if (!sourceMissing && applied?.map === map && applied.key === key) return;
      const source = ensureLayers(map);
      if (!source) return;
      source.setData(featureCollection(shapesRef.current));
      appliedRef.current = { map, key };
    };
    apply();
    // Style rechargé (fond de carte changé) : source et calques reposés au besoin.
    const handleStyleData = () => {
      if (!map.getSource(COMMENT_ZONE_SOURCE_ID)) appliedRef.current = null;
      apply();
    };
    map.on('styledata', handleStyleData);
    return () => {
      map.off('styledata', handleStyleData);
    };
  }, [key, map]);
}
