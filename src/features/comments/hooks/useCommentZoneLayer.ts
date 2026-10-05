import { useEffect, useRef } from 'react';
import type { GeoJSONSource, Map as MapboxMap } from 'mapbox-gl';

import type { ProjectCommentZone } from '@/features/itineraryPanel/types';
import { canMutateStyle } from '@/features/itineraryPanel/lib/route-layer/constants';

import { zoneDrawingFeatures, type CommentZoneDrawing } from '../lib/zoneDrawing';
import { closedRing } from '../lib/zoneGeometry';

/**
 * Zones commentées sur la carte : celle du fil survolé ou ouvert, et celle en
 * cours de tracé (pointillés), drapées sur le relief (remplissage + contour),
 * et la zone polygonale en cours de pose (pointillés + sommets).
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
const VERTEX_LAYER_ID = 'rv-comment-zones-vertices';
const ZONE_COLOR = '#c50000';

export interface CommentZoneShape {
  zone: ProjectCommentZone;
  /** Zone en cours de tracé ou de saisie : contour en pointillés. */
  draft: boolean;
}

function featureCollection(shapes: readonly CommentZoneShape[], drawing: CommentZoneDrawing | null): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = shapes.map(({ zone, draft }) => ({
    type: 'Feature',
    properties: { draft: draft ? 1 : 0 },
    geometry: { type: 'Polygon', coordinates: [closedRing(zone)] },
  }));
  if (drawing) features.push(...zoneDrawingFeatures(drawing));
  return { type: 'FeatureCollection', features };
}

function ensureLayers(map: MapboxMap): GeoJSONSource | null {
  if (!canMutateStyle(map)) return null;
  try {
    if (!map.getSource(COMMENT_ZONE_SOURCE_ID)) {
      map.addSource(COMMENT_ZONE_SOURCE_ID, { type: 'geojson', data: featureCollection([], null) });
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
    // Sommets de la zone en cours de pose ; celui qu'un clic fermerait, cerclé plus large.
    if (!map.getLayer(VERTEX_LAYER_ID)) {
      map.addLayer({
        id: VERTEX_LAYER_ID,
        type: 'circle',
        source: COMMENT_ZONE_SOURCE_ID,
        filter: ['==', ['get', 'vertex'], 1],
        paint: {
          // Taille fixe à l'écran : en vue inclinée, la perspective grossissait les sommets proches.
          'circle-pitch-scale': 'viewport',
          'circle-pitch-alignment': 'viewport',
          'circle-color': '#fff',
          'circle-radius': ['case', ['==', ['get', 'close'], 1], 6, 4],
          'circle-stroke-color': ZONE_COLOR,
          'circle-stroke-width': ['case', ['==', ['get', 'close'], 1], 3, 2],
        },
      });
    }
    return (map.getSource(COMMENT_ZONE_SOURCE_ID) as GeoJSONSource | undefined) ?? null;
  } catch {
    return null;
  }
}

export function useCommentZoneLayer(
  map: MapboxMap | null,
  shapes: readonly CommentZoneShape[],
  drawing: CommentZoneDrawing | null = null,
): void {
  const key = JSON.stringify([shapes, drawing]);
  const appliedRef = useRef<{ map: MapboxMap; key: string } | null>(null);
  const shapesRef = useRef({ shapes, drawing });
  useEffect(() => {
    shapesRef.current = { shapes, drawing };
  });

  useEffect(() => {
    if (!map) return;
    const apply = () => {
      const applied = appliedRef.current;
      const sourceMissing = !map.getSource(COMMENT_ZONE_SOURCE_ID) || !map.getLayer(VERTEX_LAYER_ID);
      // Rien à dessiner et rien de dessiné : on ne touche pas au style.
      if (sourceMissing && shapesRef.current.shapes.length === 0 && !shapesRef.current.drawing) return;
      if (!sourceMissing && applied?.map === map && applied.key === key) return;
      const source = ensureLayers(map);
      if (!source) return;
      source.setData(featureCollection(shapesRef.current.shapes, shapesRef.current.drawing));
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
