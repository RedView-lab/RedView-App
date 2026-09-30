import { useEffect, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { Itinerary } from '@/features/itineraryPanel/types';
import { translateAppText } from '@/shared/i18n';
import { detectSteepAlertSegments, locateRoutePointAtX } from '../chart';

const ALERT_ICON_SRC = '/svgv2/icone/search-filter-alertes.svg';

interface AlertMapMarker {
  id: string;
  lon: number;
  lat: number;
  label: string;
}

interface UseAnalysisAlertMapMarkersArgs {
  map: MapboxMap | null;
  itineraries: Itinerary[];
  enabled: boolean;
}

function createAlertMarkerElement(label: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'rvi-analysis-alert-marker';
  el.title = label;
  el.setAttribute('aria-label', label);
  const icon = document.createElement('img');
  icon.src = ALERT_ICON_SRC;
  icon.alt = '';
  icon.draggable = false;
  el.appendChild(icon);
  return el;
}

/**
 * Icônes de danger sur la carte 3D, au milieu de chaque tronçon « Alertes »
 * (pente ≥ 12 % sur ≥ 100 m) — mêmes zones que les colonnes rouges du graphe.
 */
export function useAnalysisAlertMapMarkers({
  map,
  itineraries,
  enabled,
}: UseAnalysisAlertMapMarkersArgs) {
  const markers = useMemo<AlertMapMarker[]>(() => {
    if (!enabled) return [];
    const result: AlertMapMarker[] = [];
    for (const itinerary of itineraries) {
      if (itinerary.visible === false) continue;
      const points = itinerary.gpxRoute?.points;
      if (!points || points.length < 2) continue;
      detectSteepAlertSegments(points).forEach((segment, index) => {
        const midKm = (segment.startM + segment.endM) / 2000;
        const point = locateRoutePointAtX(points, null, 'distance', midKm);
        if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
        result.push({
          id: `${itinerary.id}::alert::${index}`,
          lon: point.lon,
          lat: point.lat,
          label: `${translateAppText('Pente')} ${Math.round(segment.maxGradientPct)} % · ${Math.round(segment.endM - segment.startM)} m`,
        });
      });
    }
    return result;
  }, [enabled, itineraries]);

  // Signature stable : les mutations de projet sans effet sur les alertes
  // (renommage, rythme…) ne recréent pas les marqueurs.
  const signature = useMemo(
    () => markers.map((m) => `${m.id}@${m.lon.toFixed(6)},${m.lat.toFixed(6)}|${m.label}`).join(';'),
    [markers],
  );

  useEffect(() => {
    if (!map || markers.length === 0) return;
    const instances = markers.map((marker) =>
      new mapboxgl.Marker({
        element: createAlertMarkerElement(marker.label),
        anchor: 'bottom',
        pitchAlignment: 'viewport',
        rotationAlignment: 'viewport',
      })
        .setLngLat([marker.lon, marker.lat])
        .addTo(map),
    );
    return () => {
      for (const instance of instances) instance.remove();
    };
    // `markers` est couvert par `signature`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, signature]);
}
