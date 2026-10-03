import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { computePanelPosition, resolvePanelArea, type MapOverlayInsets } from '../panelPlacement';
import type { MapPoiDraft } from './types';

const EDGE_PADDING = 8;

function isFiniteCoordinate(value: number): boolean {
  return Number.isFinite(value);
}

interface UsePoiDraftCardPositionArgs {
  draft: MapPoiDraft;
  map: MapboxMap | null;
  cardRef: RefObject<HTMLDivElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  overlayInsets?: MapOverlayInsets | null;
}

/**
 * Calcule et synchronise la position écran de la carte de brouillon POI ancrée sur le point 3D.
 */
export function usePoiDraftCardPosition({
  draft,
  map,
  cardRef,
  containerRef,
  overlayInsets,
}: UsePoiDraftCardPositionArgs) {
  const [position, setPosition] = useState({ left: EDGE_PADDING, top: EDGE_PADDING });

  const syncCardPosition = useCallback(() => {
    if (!cardRef.current || !containerRef.current) return;

    // Layout px of the map container, like `map.project()`, the insets and the
    // card's own left/top (the dashboard canvas may be CSS-zoomed:
    // getBoundingClientRect() would give on-screen px).
    const cardWidth = cardRef.current.offsetWidth;
    const cardHeight = cardRef.current.offsetHeight;
    const containerWidth = containerRef.current.clientWidth;
    const containerHeight = containerRef.current.clientHeight;
    // `screenPoint` is the click's `event.point`: already map-container px.
    const fallbackPoint = draft.screenPoint;
    const projectedPoint = map
      ? map.project([draft.point.lng, draft.point.lat])
      : fallbackPoint;
    const anchorX = isFiniteCoordinate(projectedPoint.x) ? projectedPoint.x : fallbackPoint.x;
    const anchorY = isFiniteCoordinate(projectedPoint.y) ? projectedPoint.y : fallbackPoint.y;

    if (
      !isFiniteCoordinate(anchorX)
      || !isFiniteCoordinate(anchorY)
      || !(containerWidth > 0)
      || !(containerHeight > 0)
    ) {
      return;
    }

    const area = resolvePanelArea(
      containerWidth,
      containerHeight,
      cardWidth,
      cardHeight,
      EDGE_PADDING,
      overlayInsets,
    );
    const areaPosition = computePanelPosition(
      anchorX - area.left,
      anchorY - area.top,
      cardWidth,
      cardHeight,
      area.width,
      area.height,
      EDGE_PADDING,
      draft.placement,
    );
    const nextPosition = { left: areaPosition.left + area.left, top: areaPosition.top + area.top };

    setPosition((current) => (
      current.left === nextPosition.left && current.top === nextPosition.top
        ? current
        : nextPosition
    ));
  }, [cardRef, containerRef, draft, map, overlayInsets]);

  useLayoutEffect(() => {
    syncCardPosition();
  }, [syncCardPosition]);

  useEffect(() => {
    if (!map) return;

    const handleMove = () => {
      syncCardPosition();
    };

    map.on('move', handleMove);
    map.on('resize', handleMove);

    return () => {
      map.off('move', handleMove);
      map.off('resize', handleMove);
    };
  }, [map, syncCardPosition]);

  return position;
}
