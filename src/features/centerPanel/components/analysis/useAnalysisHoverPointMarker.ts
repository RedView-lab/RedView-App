import { useCallback, useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';
import type { Itinerary } from '@/features/itineraryPanel/types';
import type { PredictionResult } from '@/features/fitPredictor';
import { getItineraryStartDistanceKm } from '@/features/itineraryPanel/lineage/itineraryLineage';
import { clearAnalysisHoverPoint } from '@/features/itineraryPanel/lib/route-layer';
import {
  cumulativeRouteLengthsM,
  projectPointAlongRoute,
  type ProjectedRoutePoint,
  type RouteDistancePoint,
} from '@/features/itineraryPanel/lib/routes';
import { xValueFromDistance } from '../../flyover/playback';
import { locateRoutePointAtX, type AxisMode } from '../chart';
import { selectInteractiveItineraryForChartX } from './shared';

const ENTER_ROUTE_HOVER_DISTANCE_PX = 36;
const EXIT_ROUTE_HOVER_DISTANCE_PX = 48;

const cumulativeLengthsCache = new WeakMap<object, number[]>();

function getCumulativeLengths(points: RouteDistancePoint[]): number[] {
  let lengths = cumulativeLengthsCache.get(points);
  if (!lengths) {
    lengths = cumulativeRouteLengthsM(points);
    cumulativeLengthsCache.set(points, lengths);
  }
  return lengths;
}

function renderHoverMarker(
  activeMap: MapboxMap,
  markerRef: React.MutableRefObject<mapboxgl.Marker | null>,
  lon: number,
  lat: number,
  color: string,
) {
  if (!markerRef.current) {
    const el = document.createElement('div');
    el.className = 'rvi-analysis-hover-dot';
    el.style.width = '14px';
    el.style.height = '14px';
    el.style.boxSizing = 'border-box';
    el.style.borderRadius = '50%';
    el.style.backgroundColor = '#ffffff';
    el.style.border = `3px solid ${color}`;
    el.style.boxShadow = '0 0 0 1.5px rgba(0, 0, 0, 0.75), 0 2px 8px rgba(0, 0, 0, 0.85)';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '1';

    const marker = new mapboxgl.Marker({
      element: el,
      anchor: 'center',
      pitchAlignment: 'viewport',
      rotationAlignment: 'viewport',
      occludedOpacity: 1,
    })
      .setLngLat([lon, lat])
      .addTo(activeMap);

    const markerWrapper = marker.getElement();
    if (markerWrapper) {
      markerWrapper.style.pointerEvents = 'none';
    }
    markerRef.current = marker;
  } else {
    markerRef.current.setLngLat([lon, lat]);
    const el = markerRef.current.getElement();
    if (el) {
      el.style.pointerEvents = 'none';
      const inner = (el.classList.contains('rvi-analysis-hover-dot')
        ? el
        : el.querySelector('.rvi-analysis-hover-dot')) as HTMLElement | null;
      if (inner) {
        inner.style.borderColor = color;
      }
    }
  }
}

interface UseAnalysisHoverPointMarkerArgs {
  map: MapboxMap | null;
  visibleChartNodes: Array<{ itinerary: Itinerary; startDistanceKm: number }>;
  activeItinerary: Itinerary | null;
  xMode: AxisMode;
  predictions: Record<string, unknown> | null;
  onMapHoverXValueChange?: (xValue: number | null) => void;
  disabled?: boolean;
}

/**
 * Gère l'affichage en direct d'un point animé sur la carte 3D lors du survol du graphique d'analyse,
 * ainsi que la synchronisation inverse : le survol du tracé sur la carte 3D positionne le point
 * sur la carte et synchronise le graphique du panneau central.
 */
export function useAnalysisHoverPointMarker({
  map,
  visibleChartNodes,
  activeItinerary,
  xMode,
  predictions,
  onMapHoverXValueChange,
  disabled = false,
}: UseAnalysisHoverPointMarkerArgs) {
  const domMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const lastEmittedXValueRef = useRef<number | null>(null);
  const pendingEventRef = useRef<MapMouseEvent | null>(null);
  const rafRef = useRef<number | null>(null);

  const stateRef = useRef({
    map,
    visibleChartNodes,
    activeItinerary,
    xMode,
    predictions,
    onMapHoverXValueChange,
    disabled,
  });

  useEffect(() => {
    stateRef.current = {
      map,
      visibleChartNodes,
      activeItinerary,
      xMode,
      predictions,
      onMapHoverXValueChange,
      disabled,
    };
  });

  const updateHoverPoint = useCallback((xValue: number | null) => {
    const {
      map: activeMap,
      visibleChartNodes: activeNodes,
      activeItinerary: currentItinerary,
      xMode: currentXMode,
      predictions: currentPredictions,
    } = stateRef.current;

    if (!activeMap) return;

    if (!Number.isFinite(xValue)) {
      if (domMarkerRef.current) {
        domMarkerRef.current.remove();
        domMarkerRef.current = null;
      }
      clearAnalysisHoverPoint(activeMap);
      return;
    }

    const targetItinerary =
      selectInteractiveItineraryForChartX(
        activeNodes,
        currentItinerary?.id ?? null,
        currentXMode,
        xValue as number,
      ) ?? currentItinerary;

    if (!targetItinerary) {
      if (domMarkerRef.current) {
        domMarkerRef.current.remove();
        domMarkerRef.current = null;
      }
      clearAnalysisHoverPoint(activeMap);
      return;
    }

    const xOffset = currentXMode === 'distance' ? getItineraryStartDistanceKm(targetItinerary) : 0;
    const localXValue = currentXMode === 'distance' ? (xValue as number) - xOffset : (xValue as number);
    const prediction =
      (currentPredictions?.[targetItinerary.id] as never) ?? targetItinerary.prediction ?? null;
    const routePoints = targetItinerary.gpxRoute?.points ?? null;

    const point = locateRoutePointAtX(
      routePoints,
      prediction,
      currentXMode,
      localXValue,
      targetItinerary.rhythm.startTime,
    );

    if (!point) {
      if (domMarkerRef.current) {
        domMarkerRef.current.remove();
        domMarkerRef.current = null;
      }
      clearAnalysisHoverPoint(activeMap);
      return;
    }

    const color = targetItinerary.color || '#ff4d4f';
    renderHoverMarker(activeMap, domMarkerRef, point.lon, point.lat, color);
  }, []);

  useEffect(() => {
    if (!map || disabled) {
      if (domMarkerRef.current) {
        domMarkerRef.current.remove();
        domMarkerRef.current = null;
      }
      if (lastEmittedXValueRef.current !== null) {
        lastEmittedXValueRef.current = null;
        stateRef.current.onMapHoverXValueChange?.(null);
      }
      return;
    }

    const clearMapHover = () => {
      if (lastEmittedXValueRef.current !== null) {
        lastEmittedXValueRef.current = null;
        stateRef.current.onMapHoverXValueChange?.(null);
      }
      if (domMarkerRef.current) {
        domMarkerRef.current.remove();
        domMarkerRef.current = null;
      }
      if (map) {
        clearAnalysisHoverPoint(map);
      }
    };

    const applyHover = (event: MapMouseEvent) => {
      const {
        map: activeMap,
        visibleChartNodes: activeNodes,
        activeItinerary: currentItinerary,
        xMode: currentXMode,
        predictions: currentPredictions,
        onMapHoverXValueChange: notifyHoverXValue,
        disabled: isDisabled,
      } = stateRef.current;

      if (!activeMap || isDisabled) return;

      // Mouse button pressed -> user is dragging/panning the map or dragging a waypoint
      if (event.originalEvent && (event.originalEvent.buttons > 0 || event.originalEvent.which > 0)) {
        clearMapHover();
        return;
      }

      // If hovering over interactive overlay elements (POI markers, popups, controls, buttons)
      const target = event.originalEvent?.target as HTMLElement | null;
      if (
        target?.closest(
          '.rv-poi-marker, .mapboxgl-popup, .mapboxgl-ctrl, button, input, [role="button"]',
        )
      ) {
        clearMapHover();
        return;
      }

      if (!event.lngLat || !Number.isFinite(event.lngLat.lng) || !Number.isFinite(event.lngLat.lat)) {
        clearMapHover();
        return;
      }

      const candidates =
        activeNodes.length > 0
          ? activeNodes
          : currentItinerary
            ? [{ itinerary: currentItinerary, startDistanceKm: 0 }]
            : [];

      if (candidates.length === 0) {
        clearMapHover();
        return;
      }

      let bestCandidate: {
        itinerary: Itinerary;
        startDistanceKm: number;
        projected: ProjectedRoutePoint;
        screenDistPx: number;
      } | null = null;

      const queryPoint: RouteDistancePoint = { lat: event.lngLat.lat, lon: event.lngLat.lng };
      const maxDistancePx =
        lastEmittedXValueRef.current !== null
          ? EXIT_ROUTE_HOVER_DISTANCE_PX
          : ENTER_ROUTE_HOVER_DISTANCE_PX;

      for (const node of candidates) {
        const points = node.itinerary.gpxRoute?.points;
        if (!points || points.length < 2) continue;

        const cumulativeLengths = getCumulativeLengths(points);
        const projected = projectPointAlongRoute(queryPoint, points, cumulativeLengths);
        if (!projected) continue;

        const screenPoint = activeMap.project([projected.lon, projected.lat]);
        const screenDistPx = Math.hypot(
          screenPoint.x - event.point.x,
          screenPoint.y - event.point.y,
        );

        if (screenDistPx > maxDistancePx) continue;

        if (!bestCandidate || screenDistPx < bestCandidate.screenDistPx) {
          bestCandidate = {
            itinerary: node.itinerary,
            startDistanceKm: node.startDistanceKm,
            projected,
            screenDistPx,
          };
        }
      }

      if (!bestCandidate) {
        clearMapHover();
        return;
      }

      const { itinerary: targetItinerary, startDistanceKm, projected } = bestCandidate;
      const color = targetItinerary.color || '#ff4d4f';

      // 1. Move or create map marker
      renderHoverMarker(activeMap, domMarkerRef, projected.lon, projected.lat, color);

      // 2. Compute chart xValue
      let xValue: number | null = null;
      if (currentXMode === 'distance') {
        xValue = projected.distanceM / 1000 + startDistanceKm;
      } else {
        const prediction =
          (currentPredictions?.[targetItinerary.id] as PredictionResult | undefined) ??
          (targetItinerary.prediction as PredictionResult | null | undefined) ??
          null;
        const points = targetItinerary.gpxRoute?.points ?? [];
        const cumulativeLengths = getCumulativeLengths(points);
        const totalDistanceM =
          prediction?.total_distance_m && prediction.total_distance_m > 0
            ? prediction.total_distance_m
            : cumulativeLengths[cumulativeLengths.length - 1] ?? 0;

        xValue = xValueFromDistance(projected.distanceM, {
          prediction,
          totalDistanceM,
          xMode: currentXMode,
          startTime: targetItinerary.rhythm.startTime,
        });
      }

      if (Number.isFinite(xValue)) {
        if (
          lastEmittedXValueRef.current === null ||
          Math.abs(lastEmittedXValueRef.current - (xValue as number)) > 1e-4
        ) {
          lastEmittedXValueRef.current = xValue as number;
          notifyHoverXValue?.(xValue as number);
        }
      }
    };

    const scheduleSync = (event: MapMouseEvent) => {
      pendingEventRef.current = event;
      if (rafRef.current !== null) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        const pending = pendingEventRef.current;
        pendingEventRef.current = null;
        if (!pending) return;
        applyHover(pending);
      });
    };

    const handleMouseLeave = () => {
      pendingEventRef.current = null;
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      clearMapHover();
    };

    map.on('mousemove', scheduleSync);
    map.on('mouseleave', handleMouseLeave);
    map.on('mouseout', handleMouseLeave);
    window.addEventListener('blur', handleMouseLeave);

    return () => {
      map.off('mousemove', scheduleSync);
      map.off('mouseleave', handleMouseLeave);
      map.off('mouseout', handleMouseLeave);
      window.removeEventListener('blur', handleMouseLeave);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      pendingEventRef.current = null;
      clearMapHover();
    };
  }, [disabled, map]);

  return { updateHoverPoint };
}
