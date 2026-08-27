import type { Map as MapboxMap } from 'mapbox-gl';
import type { AxisOption } from './AxisDropdown';
import {
  locateRoutePointAtX,
  type AxisMetricId,
  type AxisMode,
  type ChartSeries,
} from '../chart';
import {
  getItineraryEndDistanceKm,
} from '@/features/itineraryPanel/lineage/itineraryLineage';
import { createDefaultAnalysisPanelState } from '@/features/itineraryPanel/lib/project';
import type {
  AnalysisFiltersState,
  AnalysisPanelState,
  Itinerary,
} from '@/features/itineraryPanel/types';

export type FilterKey = keyof AnalysisFiltersState;

export interface CenterPanelAnalysisProps {
  map: MapboxMap | null;
}

export interface PreparedChartNode {
  itinerary: Itinerary;
  startDistanceKm: number;
  prediction: Itinerary['prediction'] | null;
  xOffset: number;
  axis1Points: ChartSeries['points'] | null;
  axis1ShiftedPoints: ChartSeries['points'] | null;
  axis2Points: ChartSeries['points'] | null;
  axis2ShiftedPoints: ChartSeries['points'] | null;
  altitudePoints: ChartSeries['points'] | null;
  altitudeShiftedPoints: ChartSeries['points'] | null;
}

export const filterDefs: ReadonlyArray<{ key: FilterKey; label: string }> = [
  { key: 'waypoint', label: 'Waypoint' },
  { key: 'poi', label: 'POI' },
  { key: 'pause', label: 'Pause' },
  { key: 'alertes', label: 'Alertes' },
  { key: 'pente', label: "Profil d'altitude" },
  { key: 'jourNuit', label: 'Jour/nuit' },
];

export const axisOptions: AxisOption[] = [
  { value: 'Altitude', label: 'Altitude', tone: 'primary' },
  { value: 'Vitesse', label: 'Vitesse', tone: 'primary' },
  { value: 'Vitesse moyenne', label: 'Vitesse moyenne', tone: 'primary' },
  { value: 'Puissance', label: 'Puissance', tone: 'primary' },
  { value: 'Puissance moyenne', label: 'Puissance moyenne', tone: 'primary' },
  { value: 'Inclinaison (°)', label: 'Inclinaison (°)', tone: 'primary' },
  { value: 'Inclinaison (%)', label: 'Inclinaison (%)', tone: 'primary' },
  { value: 'Surface', label: 'Surface', tone: 'primary' },
  { value: 'Température', label: 'Température', tone: 'secondary' },
  {
    value: 'Température ressentie (°)',
    label: 'Température ressentie (°)',
    tone: 'secondary',
  },
  { value: 'Pluie (mm)', label: 'Pluie (mm)', tone: 'secondary' },
  { value: 'Vent (km/h)', label: 'Vent (km/h)', tone: 'secondary' },
  {
    value: 'Couverture nuageuse (%)',
    label: 'Couverture nuageuse (%)',
    tone: 'secondary',
  },
  { value: 'Humidité (%)', label: 'Humidité (%)', tone: 'secondary' },
  { value: 'Ensoleillement (min)', label: 'Ensoleillement (min)', tone: 'secondary' },
  { value: 'Humidité (%)__bis', label: 'Humidité (%)', tone: 'secondary' },
];

export const DETAIL_ZOOM_STEP = 0.1;
const DETAIL_MIN_VISIBLE_FRACTION = 0.04;
export const VIEWPORT_COMMIT_DEBOUNCE_MS = 140;
export const CHART_CLICK_CAMERA_DURATION_MS = 950;
export const CHART_CLICK_FOCUS_ZOOM = 15.5;
export const CHART_CLICK_FOCUS_PITCH = 68;
export const DEFAULT_ANALYSIS_AXIS_COLORS = {
  axis1: '#D92D20',
  axis2: '#155EEF',
} as const;

export function lightenColor(hex: string, amount: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const value = parseInt(match[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  const t = Math.max(0, Math.min(1, amount));
  const lr = Math.round(r + (255 - r) * t);
  const lg = Math.round(g + (255 - g) * t);
  const lb = Math.round(b + (255 - b) * t);
  return `#${((lr << 16) | (lg << 8) | lb).toString(16).padStart(6, '0')}`;
}

export function findSplitIndexForChartX(
  routePoints: Array<{ lat: number; lon: number; distanceM?: number }> | null | undefined,
  prediction: Parameters<typeof locateRoutePointAtX>[1],
  xMode: AxisMode,
  xValue: number,
  startTime?: string | null,
): number | null {
  if (!routePoints || routePoints.length < 4) return null;

  const targetPoint = locateRoutePointAtX(routePoints, prediction, xMode, xValue, startTime);
  const targetDistanceM = targetPoint?.distanceM;
  if (!Number.isFinite(targetDistanceM)) return null;

  const distances = getRoutePointDistances(routePoints);
  let lo = 0;
  let hi = distances.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (distances[mid] <= (targetDistanceM as number)) lo = mid;
    else hi = mid;
  }

  const loDistance = Math.abs(distances[lo] - (targetDistanceM as number));
  const hiDistance = Math.abs(distances[hi] - (targetDistanceM as number));
  const bestIndex = hiDistance < loDistance ? hi : lo;
  return Math.max(1, Math.min(bestIndex, routePoints.length - 2));
}

export function normalizeAnalysisState(
  state?: Partial<AnalysisPanelState> | null,
): AnalysisPanelState {
  const fallback = createDefaultAnalysisPanelState();
  const filters = {
    ...fallback.filters,
    ...(state?.filters ?? {}),
  };
  if (filters.poi) filters.pente = true;
  return {
    xMode: state?.xMode ?? fallback.xMode,
    axis1: migrateAxisMetric(state?.axis1 ?? fallback.axis1),
    axis2: migrateAxisMetric(state?.axis2 ?? fallback.axis2),
    axis1Color: normalizeAnalysisColor(state?.axis1Color),
    axis2Color: normalizeAnalysisColor(state?.axis2Color),
    filters,
    detailZoom: normalizeUnitInterval(state?.detailZoom, fallback.detailZoom),
    detailOffset: normalizeUnitInterval(state?.detailOffset, fallback.detailOffset),
  };
}

export function normalizeUnitInterval(value: number | undefined, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value ?? fallback));
}

export function detailZoomToVisibleFraction(detailZoom: number): number {
  return 1 - normalizeUnitInterval(detailZoom) * (1 - DETAIL_MIN_VISIBLE_FRACTION);
}

export function detailOffsetForCenter(center: number, visibleFraction: number): number {
  const remainingSpan = 1 - visibleFraction;
  if (remainingSpan <= 1e-6) return 0;
  return normalizeUnitInterval((center - visibleFraction / 2) / remainingSpan);
}

export function selectInteractiveItineraryForChartX(
  visibleChartNodes: Array<{ itinerary: Itinerary; startDistanceKm: number }>,
  activeItineraryId: string | null,
  xMode: AxisMode,
  xValue: number,
): Itinerary | null {
  if (visibleChartNodes.length === 0) return null;

  const activeNode = activeItineraryId
    ? visibleChartNodes.find(({ itinerary }) => itinerary.id === activeItineraryId) ?? null
    : null;
  if (xMode !== 'distance') return activeNode?.itinerary ?? visibleChartNodes[0]?.itinerary ?? null;

  const inRangeNodes = visibleChartNodes.filter(({ itinerary, startDistanceKm }) => {
    const endDistanceKm = getItineraryEndDistanceKm(itinerary);
    return xValue >= startDistanceKm - 1e-6 && xValue <= endDistanceKm + 1e-6;
  });

  if (activeNode && inRangeNodes.some(({ itinerary }) => itinerary.id === activeNode.itinerary.id)) {
    return activeNode.itinerary;
  }

  return inRangeNodes[0]?.itinerary ?? activeNode?.itinerary ?? visibleChartNodes[0]?.itinerary ?? null;
}

export function sameViewportValue(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-4;
}

function normalizeAnalysisColor(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const match = /^#?([0-9a-f]{6})$/i.exec(trimmed);
  if (!match) return undefined;
  return `#${match[1].toUpperCase()}`;
}

function migrateAxisMetric(value: string): AxisMetricId {
  if (value === 'Dénivelé') return 'Inclinaison (%)';
  return value as AxisMetricId;
}

function getRoutePointDistances(
  routePoints: Array<{ lat: number; lon: number; distanceM?: number }>,
): number[] {
  if (routePoints.length === 0) return [];

  const distances: number[] = [0];
  let cumulativeDistanceM = 0;
  for (let index = 1; index < routePoints.length; index += 1) {
    const point = routePoints[index];
    const nextDistance = point.distanceM;
    if (Number.isFinite(nextDistance) && (nextDistance as number) >= cumulativeDistanceM) {
      cumulativeDistanceM = nextDistance as number;
    } else {
      cumulativeDistanceM += haversineM(routePoints[index - 1]!, point);
    }
    distances.push(cumulativeDistanceM);
  }
  return distances;
}

function haversineM(
  start: { lat: number; lon: number },
  end: { lat: number; lon: number },
): number {
  const lat1 = (start.lat * Math.PI) / 180;
  const lat2 = (end.lat * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((end.lon - start.lon) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 12_742_017.6 * Math.asin(Math.min(1, Math.sqrt(h)));
}