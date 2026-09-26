import type { PredictionResult } from '@/features/fitPredictor';
import { getItineraryStartDistanceKm } from '@/features/itineraryPanel/lineage/itineraryLineage';
import {
  cumulativeRouteLengthsM,
  projectPointAlongRoute,
} from '@/features/itineraryPanel/lib/routes';
import type { Itinerary } from '@/features/itineraryPanel/types';
import type { ChartPoiAnnotation, AxisMode } from '@/features/centerPanel/components/chart';
import { xValueFromDistance } from '@/features/centerPanel/flyover/playback';

export interface SelectPoiOnChartPayload {
  id?: string | number;
  osmId?: string | number;
  lat?: number;
  lon?: number;
  distanceKm?: number | null;
  xValue?: number;
  category?: string;
  itineraryId?: string;
  source?: 'map' | 'timeline' | 'chart';
}

export const SELECT_POI_ON_CHART_EVENT = 'redview:select-poi-on-chart';
export const OPEN_POI_ON_MAP_EVENT = 'redview:open-poi-on-map';

export function dispatchSelectPoiOnChart(payload: SelectPoiOnChartPayload): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<SelectPoiOnChartPayload>(SELECT_POI_ON_CHART_EVENT, { detail: payload }),
  );
}

export function listenSelectPoiOnChart(
  listener: (payload: SelectPoiOnChartPayload) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const custom = e as CustomEvent<SelectPoiOnChartPayload>;
    if (custom.detail) listener(custom.detail);
  };
  window.addEventListener(SELECT_POI_ON_CHART_EVENT, handler as EventListener);
  return () => window.removeEventListener(SELECT_POI_ON_CHART_EVENT, handler as EventListener);
}

export function dispatchOpenPoiOnMap(payload: SelectPoiOnChartPayload): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<SelectPoiOnChartPayload>(OPEN_POI_ON_MAP_EVENT, { detail: payload }),
  );
}

export function listenOpenPoiOnMap(
  listener: (payload: SelectPoiOnChartPayload) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const custom = e as CustomEvent<SelectPoiOnChartPayload>;
    if (custom.detail) listener(custom.detail);
  };
  window.addEventListener(OPEN_POI_ON_MAP_EVENT, handler as EventListener);
  return () => window.removeEventListener(OPEN_POI_ON_MAP_EVENT, handler as EventListener);
}

const cumulativeLengthsCache = new WeakMap<object, number[]>();

function getCumulativeLengths(points: { lat: number; lon: number }[]): number[] {
  let lengths = cumulativeLengthsCache.get(points);
  if (!lengths) {
    lengths = cumulativeRouteLengthsM(points);
    cumulativeLengthsCache.set(points, lengths);
  }
  return lengths;
}

export function findChartXForPoi({
  poi,
  poiAnnotations,
  activeItinerary,
  visibleChartNodes,
  xMode,
  predictions,
}: {
  poi: SelectPoiOnChartPayload;
  poiAnnotations: ChartPoiAnnotation[];
  activeItinerary: Itinerary | null;
  visibleChartNodes: Array<{ itinerary: Itinerary; startDistanceKm: number }>;
  xMode: AxisMode;
  predictions: Record<string, unknown> | null;
}): number | null {
  if (Number.isFinite(poi.xValue)) {
    return poi.xValue as number;
  }

  const rawId = poi.id != null ? String(poi.id) : null;
  const rawOsmId = poi.osmId != null ? String(poi.osmId) : null;
  const cleanId = rawId ? rawId.replace(/^poi-/, '') : null;

  for (const annotation of poiAnnotations) {
    if (poi.itineraryId && annotation.itineraryId !== poi.itineraryId) continue;

    if (
      (rawId && (annotation.id === rawId || annotation.id.endsWith(`::${rawId}`))) ||
      (cleanId && annotation.id.endsWith(`::${cleanId}`)) ||
      (rawOsmId && annotation.id.endsWith(`::${rawOsmId}`))
    ) {
      return annotation.x;
    }
  }

  const targetNode =
    (poi.itineraryId
      ? visibleChartNodes.find((n) => n.itinerary.id === poi.itineraryId)
      : null) ??
    visibleChartNodes.find((n) => n.itinerary.id === activeItinerary?.id) ??
    visibleChartNodes[0] ??
    (activeItinerary ? { itinerary: activeItinerary, startDistanceKm: 0 } : null);

  if (!targetNode) return null;

  const targetItinerary = targetNode.itinerary;
  const startDistanceKm = targetNode.startDistanceKm ?? getItineraryStartDistanceKm(targetItinerary);
  const points = targetItinerary.gpxRoute?.points;
  if (!points || points.length < 2) return null;

  let distanceM: number | null = null;

  if (typeof poi.distanceKm === 'number' && Number.isFinite(poi.distanceKm)) {
    distanceM = poi.distanceKm * 1000;
  } else if (poi.lat != null && poi.lon != null) {
    const cumulativeLengths = getCumulativeLengths(points);
    const projected = projectPointAlongRoute({ lat: poi.lat, lon: poi.lon }, points, cumulativeLengths);
    if (projected) {
      distanceM = projected.distanceM;
    }
  }

  if (distanceM == null || !Number.isFinite(distanceM)) return null;

  if (xMode === 'distance') {
    return distanceM / 1000 + startDistanceKm;
  }

  const prediction =
    (predictions?.[targetItinerary.id] as PredictionResult | undefined) ??
    (targetItinerary.prediction as PredictionResult | null | undefined) ??
    null;
  const cumulativeLengths = getCumulativeLengths(points);
  const totalDistanceM =
    prediction?.total_distance_m && prediction.total_distance_m > 0
      ? prediction.total_distance_m
      : cumulativeLengths[cumulativeLengths.length - 1] ?? 0;

  return xValueFromDistance(distanceM, {
    prediction,
    totalDistanceM,
    xMode,
    startTime: targetItinerary.rhythm.startTime,
  });
}
