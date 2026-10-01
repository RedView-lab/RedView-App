import type { Itinerary } from '@/features/itineraryPanel/types';
import type { PredictionResult } from '@/features/fitPredictor';
import type { ChartPoiAnnotation } from '../annotations/buildPoiAnnotations';
import type { ChartDayNightOverlay } from '../dayNight';
import type { ChartPauseOverlay } from '../pause';
import type { ChartAlertOverlay } from '../alerts/buildSteepAlertOverlay';
import type { ChartSlopeOverlay, ChartSlopeSegment } from '../slope';
import type {
  AxisDomain,
  AxisMetricId,
  AxisMode,
  ChartBackdropProfile,
  ChartMetricId,
  ChartPoint,
  ChartSeries,
} from '../series';

export const Y_MAJOR_TARGET_PX = 26;
export const X_MAJOR_TARGET_PX = 80;
export const DEFAULT_TICK_COUNT = 6;
export const POI_MARKER_SIZE_PX = 30;
export const POI_FAVORITE_MARKER_SIZE_PX = 44;
export const POI_MARKER_SPREAD_STEP_PX = 0;
export const MULTI_POI_MARKER_WIDTH_PX = 34;
export const MULTI_POI_MARKER_HEIGHT_PX = 38;
export const POI_CLUSTER_DISTANCE_WINDOW_KM = 1.0;
export const POI_CLUSTER_MIN_COUNT = 10;
export const POI_CLUSTER_OVERLAP_X_PX = 36;
export const POI_CLUSTER_OVERLAP_Y_PX = 22;
export const POI_CLUSTER_OVERLAP_X_PX_COMPACT = 40;
export const POI_CLUSTER_OVERLAP_Y_PX_COMPACT = 32;
export const POI_CLUSTER_COMPACT_VISIBLE_FRACTION = 0.88;

export interface ChartItineraryNode {
  itinerary: Itinerary;
  startDistanceKm: number;
  prediction?: PredictionResult | null;
  xOffset: number;
  altitudeShiftedPoints?: ChartPoint[] | null;
  altitudePoints?: ChartPoint[] | null;
  axis1ShiftedPoints?: ChartPoint[] | null;
  axis2ShiftedPoints?: ChartPoint[] | null;
}

export interface AnalysisChartProps {
  series: ChartSeries[];
  chartNodes?: ChartItineraryNode[];
  backdropProfiles?: ChartBackdropProfile[];
  poiAnnotations?: ChartPoiAnnotation[];
  dayNightOverlay?: ChartDayNightOverlay | null;
  pauseOverlay?: ChartPauseOverlay | null;
  /** Colonnes rouges « Alertes » (pente ≥ 12 % sur ≥ 500 m ou ≥ 18 % sur ≥ 200 m). */
  alertOverlay?: ChartAlertOverlay | null;
  /** Colorisation « Pente » de la courbe d'altitude de l'itinéraire actif. */
  slopeOverlay?: ChartSlopeOverlay | null;
  axis1Metric: AxisMetricId;
  axis2Metric: AxisMetricId | null;
  xMode: AxisMode;
  detailZoom: number;
  detailOffset: number;
  yZoom?: number;
  yOffset?: number;
  xDomainClamp?: AxisDomain | null;
  onViewportChange?: (next: { detailZoom: number; detailOffset: number }) => void;
  onYViewportChange?: (next: { yZoom: number; yOffset: number }) => void;
  onDetailOffsetChange?: (value: number) => void;
  onHoverXValueChange?: (xValue: number | null) => void;
  controlledHoverXValue?: number | null;
  onPlotClick?: (xValue: number) => void;
  onPoiClick?: (annotation: ChartPoiAnnotation) => void;
  onPlotRangeSelect?: (range: { startX: number; endX: number }) => void;
  selectedXRange?: { startX: number; endX: number } | null;
  onClearSelectedXRange?: () => void;
  showSeriesRows?: boolean;
}

export interface CanvasBackdropLayer {
  id: string;
  fillColor: string;
  lineColor: string;
  points: { x: number; y: number }[];
  /** Tronçons de pente : la couche est alors colorée par classe. */
  slopeSegments?: ChartSlopeSegment[];
}

export interface VisiblePoiAnnotation extends ChartPoiAnnotation {
  xRatio: number;
  yRatio: number;
}

export interface PoiMarkerGroup {
  id: string;
  kind: 'single' | 'cluster';
  count: number;
  xRatio: number;
  yRatio: number;
  members: VisiblePoiAnnotation[];
}

export interface CanvasSeriesLayer {
  id: string;
  color: string;
  fillColor?: string;
  lineWidth: number;
  points: { x: number; y: number }[];
  yDomain: AxisDomain;
  /** Tronçons de pente : la couche est alors colorée par classe. */
  slopeSegments?: ChartSlopeSegment[];
}

export interface HoverCardRow {
  id: string;
  itineraryName: string;
  color: string;
  axis: 1 | 2 | null;
  axisLabel: string;
  metric: ChartMetricId;
  value: number;
  distanceFormatted?: string;
  gainM?: number;
  lossM?: number;
  durationFormatted?: string;
  timeFormatted?: string;
  /** Libellé d'alerte pente affiché dans la carte de survol. */
  alertLabel?: string;
  /** Pente locale (colorisation « Pente ») et couleur de sa classe. */
  slopeLabel?: string;
  slopeColor?: string;
}