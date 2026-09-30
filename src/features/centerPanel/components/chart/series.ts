export {
  buildSeriesFromPrediction,
  computeDomain,
  computeXDomain,
  locateRoutePointAtX,
  projectXToDistanceM,
} from './series/builders';

export {
  getRoutePointDistances,
  interpolateRoutePointAtDistance,
} from './series/routeProfile';

export {
  formatAxisValue,
  formatPaceMinutes,
  isInclinationMetric,
  isIntervalAverageMetric,
  isPaceMetric,
  isPowerMetric,
  isWeatherMetric,
  metricIsAvailable,
  unitForMetric,
} from './seriesCommon';
export type {
  AxisDomain,
  AxisMetricId,
  AxisMode,
  ChartBackdropProfile,
  ChartMetricId,
  ChartPoint,
  ChartSeries,
  RouteChartPoint,
} from './seriesCommon';
