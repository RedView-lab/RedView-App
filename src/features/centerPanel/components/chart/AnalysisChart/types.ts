import type { ChartAlertAnnotation } from '../annotations/buildRouteAuditAnnotations';
import type { ChartPoiAnnotation } from '../annotations/buildPoiAnnotations';
import type { ChartDayNightOverlay } from '../dayNight';
import type {
  AxisDomain,
  AxisMetricId,
  AxisMode,
  ChartBackdropProfile,
  ChartMetricId,
  ChartSeries,
} from '../series';

export const Y_MAJOR_TARGET_PX = 26;
export const X_MAJOR_TARGET_PX = 80;
export const DEFAULT_TICK_COUNT = 6;
export const POI_MARKER_SIZE_PX = 44;
export const POI_MARKER_SPREAD_STEP_PX = 36;
export const MULTI_POI_MARKER_WIDTH_PX = 44;
export const MULTI_POI_MARKER_HEIGHT_PX = 48;
export const POI_CLUSTER_OVERLAP_X_PX = 38;
export const POI_CLUSTER_OVERLAP_Y_PX = 16;
export const POI_CLUSTER_OVERLAP_X_PX_COMPACT = 46;
export const POI_CLUSTER_OVERLAP_Y_PX_COMPACT = 40;
export const POI_CLUSTER_COMPACT_VISIBLE_FRACTION = 0.88;

export interface AnalysisChartProps {
  series: ChartSeries[];
  backdropProfiles?: ChartBackdropProfile[];
  poiAnnotations?: ChartPoiAnnotation[];
  alertAnnotations?: ChartAlertAnnotation[];
  dayNightOverlay?: ChartDayNightOverlay | null;
  axis1Metric: AxisMetricId;
  axis2Metric: AxisMetricId;
  xMode: AxisMode;
  detailZoom: number;
  detailOffset: number;
  xDomainClamp?: AxisDomain | null;
  onViewportChange?: (next: { detailZoom: number; detailOffset: number }) => void;
  onDetailOffsetChange?: (value: number) => void;
  onHoverXValueChange?: (xValue: number | null) => void;
  controlledHoverXValue?: number | null;
  onPlotClick?: (xValue: number) => void;
  showSeriesRows?: boolean;
}

export interface CanvasBackdropLayer {
  id: string;
  fillColor: string;
  lineColor: string;
  points: { x: number; y: number }[];
}

export interface VisiblePoiAnnotation extends ChartPoiAnnotation {
  xRatio: number;
  yRatio: number;
  xPx: number;
  yPx: number;
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
  lineWidth: number;
  points: { x: number; y: number }[];
  yDomain: AxisDomain;
}

export interface HoverCardRow {
  id: string;
  itineraryName: string;
  color: string;
  axis: 1 | 2 | null;
  axisLabel: string;
  metric: ChartMetricId;
  value: number;
}