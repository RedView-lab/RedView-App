import { useEffect, useMemo, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { Itinerary } from '@/features/itineraryPanel/types';
import { translateAppText } from '@/shared/i18n';
import { listItinerarySteepAlerts, type ItinerarySteepAlert } from '../chart';

const ALERT_ICON_SRC = '/svgv2/icone/search-filter-alertes.svg';

interface UseAnalysisAlertMapMarkersArgs {
  map: MapboxMap | null;
  itineraries: Itinerary[];
  enabled: boolean;
  /** Clic sur une icône : ouvre la popup du tronçon. */
  onSelect: (alert: ItinerarySteepAlert) => void;
}

function createAlertMarkerElement(alert: ItinerarySteepAlert, label: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `rvi-analysis-alert-marker rvi-analysis-alert-marker--${alert.kind}`;
  el.title = label;
  el.setAttribute('aria-label', label);
  el.setAttribute('role', 'button');
  const icon = document.createElement('img');
  icon.src = ALERT_ICON_SRC;
  icon.alt = '';
  icon.draggable = false;
  el.appendChild(icon);
  return el;
}

/**
 * Icônes de danger sur la carte 3D, au milieu de chaque tronçon « Alertes »
 * (pente ≥ 10 % sur ≥ 1 km ou ≥ 15 % sur ≥ 100 m) — mêmes zones que les colonnes rouges du graphe.
 * Les alertes ignorées sont absentes ; un clic ouvre la carte du tronçon.
 */
export function useAnalysisAlertMapMarkers({
  map,
  itineraries,
  enabled,
  onSelect,
}: UseAnalysisAlertMapMarkersArgs) {
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  const alerts = useMemo<ItinerarySteepAlert[]>(() => {
    if (!enabled) return [];
    return itineraries
      .filter((itinerary) => itinerary.visible !== false)
      .flatMap((itinerary) => listItinerarySteepAlerts(itinerary));
  }, [enabled, itineraries]);

  // Signature stable : les mutations de projet sans effet sur les alertes
  // (renommage, rythme…) ne recréent pas les marqueurs.
  const signature = useMemo(
    () => alerts
      .map((a) => `${a.id}@${a.key}|${a.kind}|${Math.round(a.segment.maxGradientPct)}|${Math.round(a.segment.endM - a.segment.startM)}`)
      .join(';'),
    [alerts],
  );

  useEffect(() => {
    if (!map || alerts.length === 0) return;
    const instances = alerts.map((alert) => {
      const label = `${translateAppText('Pente')} ${Math.round(alert.segment.maxGradientPct)} % · ${Math.round(alert.segment.endM - alert.segment.startM)} m`;
      const element = createAlertMarkerElement(alert, label);
      // Le clic ne doit pas atteindre la carte (outil tracé, fermeture des panneaux…).
      const stop = (event: Event) => event.stopPropagation();
      element.addEventListener('mousedown', stop);
      element.addEventListener('pointerdown', stop);
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        onSelectRef.current(alert);
      });
      return new mapboxgl.Marker({
        element,
        anchor: 'bottom',
        pitchAlignment: 'viewport',
        rotationAlignment: 'viewport',
      })
        .setLngLat([alert.mid.lon, alert.mid.lat])
        .addTo(map);
    });
    return () => {
      for (const instance of instances) instance.remove();
    };
    // `alerts` est couvert par `signature`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, signature]);
}
