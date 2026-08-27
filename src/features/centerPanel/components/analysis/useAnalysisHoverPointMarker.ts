import { useCallback, useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { Itinerary } from '@/features/itineraryPanel/types';
import { getItineraryStartDistanceKm } from '@/features/itineraryPanel/lineage/itineraryLineage';
import { clearAnalysisHoverPoint } from '@/features/itineraryPanel/lib/route-layer';
import { locateRoutePointAtX, type AxisMode } from '../chart';
import { selectInteractiveItineraryForChartX } from './shared';

interface UseAnalysisHoverPointMarkerArgs {
  map: MapboxMap | null;
  visibleChartNodes: Array<{ itinerary: Itinerary; startDistanceKm: number }>;
  activeItinerary: Itinerary | null;
  xMode: AxisMode;
  predictions: Record<string, unknown> | null;
}

/**
 * Gère l'affichage en direct d'un point animé sur la carte 3D lors du survol du graphique d'analyse.
 */
export function useAnalysisHoverPointMarker({
  map,
  visibleChartNodes,
  activeItinerary,
  xMode,
  predictions,
}: UseAnalysisHoverPointMarkerArgs) {
  const domMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const stateRef = useRef({ map, visibleChartNodes, activeItinerary, xMode, predictions });

  useEffect(() => {
    stateRef.current = { map, visibleChartNodes, activeItinerary, xMode, predictions };
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

    // ── Single clean 14px dot on Mapbox (no radar animation, no extra layers) ──
    if (!domMarkerRef.current) {
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
        .setLngLat([point.lon, point.lat])
        .addTo(activeMap);
      domMarkerRef.current = marker;
    } else {
      domMarkerRef.current.setLngLat([point.lon, point.lat]);
      const el = domMarkerRef.current.getElement();
      if (el) {
        el.style.borderColor = color;
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      if (domMarkerRef.current) {
        domMarkerRef.current.remove();
        domMarkerRef.current = null;
      }
      if (map) {
        clearAnalysisHoverPoint(map);
      }
    };
  }, [map]);

  return { updateHoverPoint };
}
