import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { computePanelPosition } from '../panelPlacement';
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
}

/**
 * Calcule et synchronise la position écran de la carte de brouillon POI ancrée sur le point 3D.
 */
export function usePoiDraftCardPosition({
  draft,
  map,
  cardRef,
  containerRef,
}: UsePoiDraftCardPositionArgs) {
  const [position, setPosition] = useState({ left: EDGE_PADDING, top: EDGE_PADDING });

  const syncCardPosition = useCallback(() => {
    if (!cardRef.current || !containerRef.current) return;

    const cardRect = cardRef.current.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    const fallbackPoint = {
      x: draft.screenPoint.x - containerRect.left,
      y: draft.screenPoint.y - containerRect.top,
    };
    const projectedPoint = map
      ? map.project([draft.point.lng, draft.point.lat])
      : fallbackPoint;
    const anchorX = isFiniteCoordinate(projectedPoint.x) ? projectedPoint.x : fallbackPoint.x;
    const anchorY = isFiniteCoordinate(projectedPoint.y) ? projectedPoint.y : fallbackPoint.y;

    if (
      !isFiniteCoordinate(anchorX)
      || !isFiniteCoordinate(anchorY)
      || !isFiniteCoordinate(cardRect.width)
      || !isFiniteCoordinate(cardRect.height)
      || !isFiniteCoordinate(containerRect.width)
      || !isFiniteCoordinate(containerRect.height)
    ) {
      return;
    }

    const nextPosition = computePanelPosition(
      anchorX,
      anchorY,
      cardRect.width,
      cardRect.height,
      containerRect.width,
      containerRect.height,
      EDGE_PADDING,
      draft.placement,
    );

    setPosition((current) => (
      current.left === nextPosition.left && current.top === nextPosition.top
        ? current
        : nextPosition
    ));
  }, [cardRef, containerRef, draft, map]);

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
