export { AnalysisChart } from './AnalysisChart';
export {
  estimateScheduledSecondsAtDistance,
  formatScheduledDayClock,
} from './AnalysisChart/hoverMetrics';
export { ChartZoomNavigator } from './AnalysisChart/ChartZoomNavigator';
export type { ChartZoomNavigatorProps } from './AnalysisChart/ChartZoomNavigator';
export { useChartHover } from './useChartHover';
export { buildChartDayNightOverlay } from './dayNight';
export type { ChartHoverState } from './useChartHover';
export {
  buildSeriesFromPrediction,
  computeXDomain,
  getRoutePointDistances,
  interpolateRoutePointAtDistance,
  isInclinationMetric,
  isIntervalAverageMetric,
  isWeatherMetric,
  locateRoutePointAtX,
  metricIsAvailable,
  projectXToDistanceM,
  unitForMetric,
} from './series';
export { buildPoiAnnotationsForItinerary } from './annotations/buildPoiAnnotations';
export type {
  AxisDomain,
  ChartBackdropProfile,
  AxisMetricId,
  ChartMetricId,
  AxisMode,
  ChartPoint,
  RouteChartPoint,
  ChartSeries,
} from './series';
export type { ChartPoiAnnotation } from './annotations/buildPoiAnnotations';

export type {
  ChartDayNightMoonMarker,
  ChartDayNightOverlay,
  ChartDayNightWindow,
} from './dayNight';

export { buildChartPauseOverlay } from './pause';
export type {
  ChartPauseOverlay,
  ChartPauseWindow,
} from './pause';


export {
  buildAlertWindowsForItinerary,
  detectSteepAlertSegments,
  listItinerarySteepAlerts,
  steepAlertKey,
  STEEP_ALERT_RULES,
} from './alerts/buildSteepAlertOverlay';
export type {
  ChartAlertOverlay,
  ChartAlertWindow,
  ItinerarySteepAlert,
  SteepAlertRule,
  SteepAlertSegment,
} from './alerts/buildSteepAlertOverlay';
