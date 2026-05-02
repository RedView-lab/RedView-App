export {
  buildSeriesFromPrediction,
  computeDomain,
  computeXDomain,
  locateRoutePointAtX,
} from './series/builders';

export {
  formatAxisValue,
  isInclinationMetric,
  isIntervalAverageMetric,
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
