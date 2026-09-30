import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap, PopupOptions } from 'mapbox-gl';

import {
  formatCoordinates,
  MapAlertSectionCard,
  type MapAlertSection,
  type MapAlertSectionActionPayload,
} from '@/features/map3d';
import { useProjectStoreOptional } from '@/features/itineraryPanel';
import { buildPauseAwareSchedule } from '@/features/itineraryPanel/lib/schedule';
import type { Surface } from '@/features/itineraryPanel/lib/route-metrics/types';
import type { PredictionResult } from '@/features/fitPredictor';
import type { Itinerary, ItinerarySteepAlertOverride } from '@/features/itineraryPanel/types';

import {
  estimateScheduledSecondsAtDistance,
  formatScheduledDayClock,
  listItinerarySteepAlerts,
  locateRoutePointAtX,
  type ItinerarySteepAlert,
} from '../chart';

/** Tronçon « Alertes » sélectionné sur la carte. */
export interface AnalysisAlertSelection {
  itineraryId: string;
  key: string;
  roadTypeLabel: string | null;
}

const SURFACE_LABELS: Record<Surface, string | null> = {
  asphalt: 'Bitume',
  paved: 'Pavé / béton',
  gravel: 'Gravier',
  dirt: 'Terre',
  sand: 'Sable',
  unknown: null,
};

const SURFACE_COLORS: Record<Surface, string | null> = {
  asphalt: '#ff2a1f',
  paved: '#ff8a3d',
  gravel: '#e0b43a',
  dirt: '#a0703f',
  sand: '#e8d19a',
  unknown: null,
};

/** Revêtement majoritaire (pondéré par la distance) sur [startM, endM]. */
function dominantSurface(points: NonNullable<Itinerary['gpxRoute']>['points'], startM: number, endM: number): Surface | null {
  const totals = new Map<Surface, number>();
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a.distanceM == null || b.distanceM == null) continue;
    const overlap = Math.min(b.distanceM, endM) - Math.max(a.distanceM, startM);
    if (overlap <= 0) continue;
    const surface = b.surface ?? a.surface;
    if (!surface) continue;
    totals.set(surface, (totals.get(surface) ?? 0) + overlap);
  }
  let best: Surface | null = null;
  let bestLength = 0;
  for (const [surface, length] of totals) {
    if (length > bestLength) {
      best = surface;
      bestLength = length;
    }
  }
  return best;
}

function parseStartSecOfDay(startTime: string | null | undefined): number {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(startTime?.trim() || '08:00');
  const hours = match ? Number.parseInt(match[1]!, 10) : 8;
  const minutes = match ? Number.parseInt(match[2]!, 10) : 0;
  return hours * 3600 + minutes * 60;
}

function formatDurationHm(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}h${String(total % 60).padStart(2, '0')}`;
}

const METERS_PER_DEG_LAT = 111_320;
/** Demi-longueur (le long du tracé) et demi-largeur de la zone interdite posée au milieu du tronçon. */
const NOGO_HALF_LENGTH_M = 20;
const NOGO_HALF_WIDTH_M = 15;

/**
 * Rectangle orienté selon le tracé, centré sur le milieu du tronçon : suffit à
 * couper la route pour BRouter sans bloquer les voies voisines.
 */
function buildSectionNogoPolygon(itinerary: Itinerary, alert: ItinerarySteepAlert): Array<{ lat: number; lon: number }> | null {
  const points = itinerary.gpxRoute?.points;
  if (!points) return null;
  const midM = (alert.segment.startM + alert.segment.endM) / 2;
  const before = locateRoutePointAtX(points, null, 'distance', (midM - NOGO_HALF_LENGTH_M) / 1000);
  const after = locateRoutePointAtX(points, null, 'distance', (midM + NOGO_HALF_LENGTH_M) / 1000);
  if (!before || !after) return null;

  const { lat, lon } = alert.mid;
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  let dx = (after.lon - before.lon) * metersPerDegLon;
  let dy = (after.lat - before.lat) * METERS_PER_DEG_LAT;
  const norm = Math.hypot(dx, dy);
  if (!Number.isFinite(norm) || norm < 1e-6) {
    dx = 1;
    dy = 0;
  } else {
    dx /= norm;
    dy /= norm;
  }
  // Axe du tracé (dx, dy) et perpendiculaire (-dy, dx), en mètres.
  const corner = (along: number, across: number) => ({
    lat: lat + (dy * along + dx * across) / METERS_PER_DEG_LAT,
    lon: lon + (dx * along - dy * across) / metersPerDegLon,
  });
  return [
    corner(-NOGO_HALF_LENGTH_M, -NOGO_HALF_WIDTH_M),
    corner(NOGO_HALF_LENGTH_M, -NOGO_HALF_WIDTH_M),
    corner(NOGO_HALF_LENGTH_M, NOGO_HALF_WIDTH_M),
    corner(-NOGO_HALF_LENGTH_M, NOGO_HALF_WIDTH_M),
  ];
}

/**
 * Décalage de la popup selon son ancrage auto : le marqueur d'alerte (22 px)
 * est posé au-dessus du point (`anchor: 'bottom'`).
 */
const ALERT_POPUP_OFFSET: PopupOptions['offset'] = {
  center: [0, -11],
  top: [0, 4],
  'top-left': [0, 4],
  'top-right': [0, 4],
  bottom: [0, -26],
  'bottom-left': [0, -26],
  'bottom-right': [0, -26],
  left: [14, -11],
  right: [-14, -11],
};

interface AnalysisAlertSectionPopoverProps {
  map: MapboxMap;
  selection: AnalysisAlertSelection;
  itineraries: Itinerary[];
  predictions: Record<string, unknown> | null;
  onClose: () => void;
}

/**
 * Popup Mapbox d'un tronçon « Alertes », mêmes options et même gabarit que le
 * menu POI : infos (pente, altitude, revêtement, passage) et actions (type,
 * retirer du parcours, ignorer). Fermeture au clic carte, comme les POI.
 */
export function AnalysisAlertSectionPopover({
  map,
  selection,
  itineraries,
  predictions,
  onClose,
}: AnalysisAlertSectionPopoverProps) {
  const projectStore = useProjectStoreOptional();
  const [host] = useState(() => document.createElement('div'));
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const itinerary = itineraries.find((it) => it.id === selection.itineraryId) ?? null;
  const alert = useMemo(
    () => (itinerary ? listItinerarySteepAlerts(itinerary).find((a) => a.key === selection.key) ?? null : null),
    [itinerary, selection.key],
  );

  // Tronçon disparu (ignoré, tracé recalculé, itinéraire masqué) : on ferme.
  useEffect(() => {
    if (!alert) onClose();
  }, [alert, onClose]);

  // Une popup par sélection ; `close` (clic carte) remonte à l'état parent.
  useEffect(() => {
    let disposed = false;
    const popup = new mapboxgl.Popup({
      className: 'rv-poi-popup',
      closeButton: false,
      closeOnClick: true,
      focusAfterOpen: false,
      maxWidth: 'none',
      offset: ALERT_POPUP_OFFSET,
    }).setDOMContent(host);
    popup.on('close', () => {
      if (!disposed) onCloseRef.current();
    });
    popupRef.current = popup;
    return () => {
      disposed = true;
      popupRef.current = null;
      popup.remove();
    };
  }, [host, map, selection.itineraryId, selection.key]);

  const lng = alert?.mid.lon ?? null;
  const lat = alert?.mid.lat ?? null;
  useEffect(() => {
    const popup = popupRef.current;
    if (!popup || lng == null || lat == null) return;
    popup.setLngLat([lng, lat]);
    if (!popup.isOpen()) popup.addTo(map);
  }, [lat, lng, map, selection.itineraryId, selection.key]);

  const section = useMemo<MapAlertSection | null>(() => {
    if (!itinerary || !alert) return null;
    const { segment, mid } = alert;
    const points = itinerary.gpxRoute?.points ?? [];
    const surface = dominantSurface(points, segment.startM, segment.endM);

    const prediction = ((predictions?.[itinerary.id] as PredictionResult | null | undefined) ?? itinerary.prediction ?? null);
    let durationLabel: string | null = null;
    let clockLabel: string | null = null;
    if (prediction && prediction.points.length >= 2) {
      const pauseSchedule = buildPauseAwareSchedule(itinerary, prediction);
      const scheduledSeconds = estimateScheduledSecondsAtDistance(itinerary, prediction, pauseSchedule, segment.startM);
      durationLabel = formatDurationHm(scheduledSeconds);
      clockLabel = formatScheduledDayClock(parseStartSecOfDay(itinerary.rhythm?.startTime), scheduledSeconds);
    }

    return {
      id: alert.id,
      lng: mid.lon,
      lat: mid.lat,
      roadTypeLabel: selection.roadTypeLabel,
      coordinatesLabel: formatCoordinates(mid.lat, mid.lon),
      maxGradientPct: segment.maxGradientPct,
      avgGradientPct: segment.avgGradientPct,
      lengthM: segment.endM - segment.startM,
      elevationM: mid.elevationM ?? null,
      surfaceLabel: surface ? SURFACE_LABELS[surface] : null,
      surfaceColor: surface ? SURFACE_COLORS[surface] : null,
      itineraryColor: itinerary.color,
      distanceLabel: `${(segment.startM / 1000).toFixed(2)}km`,
      durationLabel,
      clockLabel,
      kind: alert.kind,
      canRemoveFromRoute: Boolean(projectStore) && itinerary.gpxRoute?.source === 'brouter',
    };
  }, [alert, itinerary, predictions, projectStore, selection.roadTypeLabel]);

  const setOverride = useCallback((patch: ItinerarySteepAlertOverride) => {
    projectStore?.setProject((prev) => ({
      ...prev,
      itineraries: prev.itineraries.map((it) => {
        if (it.id !== selection.itineraryId) return it;
        const overrides = it.steepAlertOverrides ?? {};
        return {
          ...it,
          steepAlertOverrides: { ...overrides, [selection.key]: { ...overrides[selection.key], ...patch } },
        };
      }),
    }));
  }, [projectStore, selection.itineraryId, selection.key]);

  const handleAction = useCallback((payload: MapAlertSectionActionPayload) => {
    switch (payload.action) {
      case 'change-kind':
        if (payload.kind) setOverride({ kind: payload.kind });
        return;
      case 'ignore':
        setOverride({ ignored: true });
        onClose();
        return;
      case 'remove-from-route':
        if (projectStore && itinerary && alert) {
          const polygon = buildSectionNogoPolygon(itinerary, alert);
          if (polygon) projectStore.addForbiddenZone(itinerary.id, polygon);
        }
        onClose();
    }
  }, [alert, itinerary, onClose, projectStore, setOverride]);

  if (!section) return null;

  return createPortal(<MapAlertSectionCard section={section} onAction={handleAction} />, host);
}
