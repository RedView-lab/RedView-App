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
