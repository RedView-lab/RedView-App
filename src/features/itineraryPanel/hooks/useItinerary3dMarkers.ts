import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import mapboxgl from 'mapbox-gl';

import type { Itinerary } from '../types';
import '@/features/poi/styles/floating-markers.css';

const MARKER_MIN_SCALE_ZOOM = 8.25;
const MARKER_MAX_SCALE_ZOOM = 15.1;
const MARKER_MIN_SCREEN_SCALE = 0.42;
const MARKER_MAX_SCREEN_SCALE = 1;
const MARKER_MIN_LIFT_M = 7;
const MARKER_MAX_LIFT_M = 10.5;

const ITINERARY_MARKER_ICON_URLS = {
  start: '/svgv2/icone/itinerary-3d/start.svg',
  end: '/svgv2/icone/itinerary-3d/finish.svg',
  pause: '/svgv2/icone/itinerary-3d/pause.svg',
} as const;

type ItineraryMarkerKind = keyof typeof ITINERARY_MARKER_ICON_URLS | 'waypoint';

type RoutePoint = NonNullable<Itinerary['gpxRoute']>['points'][number];

interface ItineraryMarkerPoint {
  id: string;
  kind: ItineraryMarkerKind;
  label: string;
  lat: number;
  lon: number;
}

interface ItineraryMarkerEntry {
  marker: mapboxgl.Marker;
  signature: string;
}

export function useItinerary3dMarkers(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  active: Itinerary | null,
): void {
  const markerRegistryRef = useRef<Map<string, ItineraryMarkerEntry>>(new Map());
  const lastMapRef = useRef<MapboxMap | null>(null);

  const markerPoints = useMemo(() => buildMarkerPoints(active), [active]);
  const markerSignature = useMemo(
    () => markerPoints.map((point) => `${point.id}:${getMarkerSignature(point)}`).join('|'),
    [markerPoints],
  );

  const clearMarkers = useCallback(() => {
    for (const { marker } of markerRegistryRef.current.values()) {
      marker.remove();
    }
    markerRegistryRef.current.clear();
  }, []);

  const syncMarkerVisualState = useCallback((currentMap: MapboxMap) => {
    const zoom = currentMap.getZoom();
    const visualState = getMarkerVisualState(zoom);
    for (const { marker } of markerRegistryRef.current.values()) {
      marker.getElement().style.setProperty(
        '--rv-itinerary-marker-scale',
        visualState.scale.toFixed(3),
      );
      marker.setAltitude(visualState.altitude);
    }
  }, []);

  const syncMarkers = useCallback((currentMap: MapboxMap, points: ItineraryMarkerPoint[]) => {
    const registry = markerRegistryRef.current;
    const nextKeys = new Set(points.map((point) => point.id));

    for (const [key, entry] of registry) {
      if (nextKeys.has(key)) continue;
      entry.marker.remove();
      registry.delete(key);
    }

    for (const point of points) {
      const signature = getMarkerSignature(point);
      const existing = registry.get(point.id);

      if (existing && existing.signature === signature) continue;

      existing?.marker.remove();
      registry.set(point.id, createMarker(currentMap, point));
    }

    syncMarkerVisualState(currentMap);
  }, [syncMarkerVisualState]);

  useEffect(() => {
    if (lastMapRef.current && lastMapRef.current !== map) {
      clearMarkers();
    }
    lastMapRef.current = map;

    if (!map || !isMapLoaded) {
      clearMarkers();
      return;
    }

    syncMarkers(map, markerPoints);
  }, [clearMarkers, isMapLoaded, map, markerPoints, markerSignature, syncMarkers]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    let frameId: number | null = null;

    const scheduleVisualRefresh = () => {
      if (frameId != null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        syncMarkerVisualState(map);
      });
    };

    scheduleVisualRefresh();
    map.on('zoom', scheduleVisualRefresh);

    return () => {
      if (frameId != null) {
        window.cancelAnimationFrame(frameId);
      }
      map.off('zoom', scheduleVisualRefresh);
    };
  }, [isMapLoaded, map, syncMarkerVisualState]);

  useEffect(() => clearMarkers, [clearMarkers]);
}

function buildMarkerPoints(active: Itinerary | null): ItineraryMarkerPoint[] {
  if (!active) return [];
  if (active.gpxRoute?.source === 'brouter') {
    return buildPauseMarkerPoints(active);
  }

  const routePoints = active.gpxRoute?.points ?? [];
  const totalDistanceM = routePoints[routePoints.length - 1]?.distanceM ?? 0;
  const markers: ItineraryMarkerPoint[] = [];
  const start = active.timeline.find((row) => row.kind === 'start');
  const startPoint = resolveTimelinePoint(start ?? null, routePoints, totalDistanceM);
  if (startPoint) {
    markers.push({
      id: start ? `start:${start.id}` : 'start:route',
      kind: 'start',
      label: start?.label?.trim() || 'Depart',
      lat: startPoint.lat,
      lon: startPoint.lon,
    });
  }

  const end = active.timeline.find((row) => row.kind === 'end');
  const endPoint = resolveTimelinePoint(end ?? null, routePoints, totalDistanceM);
  if (endPoint) {
    markers.push({
      id: end ? `end:${end.id}` : 'end:route',
      kind: 'end',
      label: end?.label?.trim() || 'Arrivee',
      lat: endPoint.lat,
      lon: endPoint.lon,
    });
  }

  markers.push(...buildPauseMarkerPoints(active, routePoints, totalDistanceM));

  return markers;
}

function buildPauseMarkerPoints(
  active: Itinerary,
  routePoints: RoutePoint[] = active.gpxRoute?.points ?? [],
  totalDistanceM: number = routePoints[routePoints.length - 1]?.distanceM ?? 0,
): ItineraryMarkerPoint[] {
  const markers: ItineraryMarkerPoint[] = [];
  for (const item of active.timeline) {
    if (item.kind !== 'pause' || item.visible === false) continue;
    const point = resolveTimelinePoint(item, routePoints, totalDistanceM);
    if (!point) continue;
    markers.push({
      id: `pause:${item.id}`,
      kind: 'pause',
      label: item.label?.trim() || 'Pause',
      lat: point.lat,
      lon: point.lon,
    });
  }
  return markers;
}

function resolveTimelinePoint(
  item: Pick<Itinerary['timeline'][number], 'kind' | 'lat' | 'lon' | 'distanceKm'> | null,
  routePoints: RoutePoint[],
  totalDistanceM: number,
): { lat: number; lon: number } | null {
  if (item?.lat != null && item.lon != null) {
    return { lat: item.lat, lon: item.lon };
  }

  if (routePoints.length === 0) return null;

  let distanceM: number | null = null;
  if (item?.kind === 'start') distanceM = 0;
  else if (item?.kind === 'end') distanceM = totalDistanceM;
  else if (item?.distanceKm != null && Number.isFinite(item.distanceKm)) {
    distanceM = item.distanceKm * 1000;
  }

  if (!Number.isFinite(distanceM)) return null;

  const clampedDistanceM = Math.max(0, Math.min(totalDistanceM, distanceM as number));
  return sampleRoutePointAtDistance(routePoints, clampedDistanceM);
}

function sampleRoutePointAtDistance(
  routePoints: RoutePoint[],
  distanceM: number,
): { lat: number; lon: number } {
  const first = routePoints[0]!;
  const firstDistanceM = first.distanceM ?? 0;
  if (distanceM <= firstDistanceM) {
    return { lat: first.lat, lon: first.lon };
  }

  const last = routePoints[routePoints.length - 1]!;
  const lastDistanceM = last.distanceM ?? firstDistanceM;
  if (distanceM >= lastDistanceM) {
    return { lat: last.lat, lon: last.lon };
  }

  let lo = 0;
  let hi = routePoints.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const midDistanceM = routePoints[mid]!.distanceM ?? firstDistanceM;
    if (midDistanceM <= distanceM) lo = mid;
    else hi = mid;
  }

  const start = routePoints[lo]!;
  const end = routePoints[hi]!;
  const startDistanceM = start.distanceM ?? firstDistanceM;
  const endDistanceM = end.distanceM ?? startDistanceM;
  const span = endDistanceM - startDistanceM;
  if (span <= 0) return { lat: start.lat, lon: start.lon };

  const t = (distanceM - startDistanceM) / span;
  return {
    lat: start.lat + (end.lat - start.lat) * t,
    lon: start.lon + (end.lon - start.lon) * t,
  };
}

function createMarker(currentMap: MapboxMap, point: ItineraryMarkerPoint): ItineraryMarkerEntry {
  const marker = new mapboxgl.Marker({
    element: createMarkerElement(point),
    anchor: 'bottom',
    pitchAlignment: 'viewport',
    rotationAlignment: 'viewport',
    occludedOpacity: 0,
    altitude: MARKER_MIN_LIFT_M,
  })
    .setLngLat([point.lon, point.lat])
    .addTo(currentMap);

  return {
    marker,
    signature: getMarkerSignature(point),
  };
}

function createMarkerElement(point: ItineraryMarkerPoint): HTMLDivElement {
  const element = document.createElement('div');
  element.className = `rv-itinerary-marker rv-itinerary-marker--${point.kind}`;
  element.dataset.kind = point.kind;
  element.setAttribute('aria-hidden', 'true');

  if (point.kind !== 'waypoint') {
    const image = document.createElement('img');
    image.className = 'rv-itinerary-marker__img';
    image.src = ITINERARY_MARKER_ICON_URLS[point.kind];
    image.alt = '';
    image.draggable = false;
    image.decoding = 'async';
    element.appendChild(image);
  }

  if (point.kind === 'start' || point.kind === 'end' || point.kind === 'waypoint') {
    const handle = document.createElement('span');
    handle.className = 'rv-itinerary-marker__handle';
    element.appendChild(handle);
  }

  return element;
}

function getMarkerSignature(point: ItineraryMarkerPoint): string {
  return [point.kind, point.label, point.lat, point.lon].join('|');
}

function getMarkerVisualState(zoom: number): { scale: number; altitude: number } {
  const progress = smoothstep(MARKER_MIN_SCALE_ZOOM, MARKER_MAX_SCALE_ZOOM, zoom);
  return {
    scale: lerp(MARKER_MIN_SCREEN_SCALE, MARKER_MAX_SCREEN_SCALE, progress),
    altitude: lerp(MARKER_MAX_LIFT_M, MARKER_MIN_LIFT_M, progress),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const progress = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return progress * progress * (3 - 2 * progress);
}