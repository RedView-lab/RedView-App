/**
 * Base route sample used by chart series builders and chart interactions.
 */
export interface RouteChartPoint {
  lat: number;
  lon: number;
  distanceM?: number;
  elevationM?: number | null;
  gradientPct?: number | null;
}

/**
 * Identifier of an axis option exposed by the analysis dropdowns. Keep in
 * sync with the labels rendered in CenterPanelAnalysis.
 */
export type AxisMetricId =
  | 'Vitesse'
  | 'Vitesse moyenne'
  | 'Puissance'
  | 'Puissance moyenne'
  | 'Inclinaison (°)'
  | 'Inclinaison (%)'
  | 'Surface'
  | 'Température'
  | 'Température ressentie (°)'
  | 'Pluie (mm)'
  | 'Vent (km/h)'
  | 'Couverture nuageuse (%)'
  | 'Humidité (%)'
  | 'Ensoleillement (min)';

export type ChartMetricId = AxisMetricId | 'Altitude';

export type AxisMode = 'distance' | 'temps' | 'heure';

/** Single point of a chart series, expressed in axis units (km / s / metric). */
export interface ChartPoint {
  x: number;
  y: number;
}

/** Plot-ready descriptor: one curve for one itinerary on one axis. */
export interface ChartSeries {
  id: string;
  itineraryId: string;
  itineraryName: string;
  metricId: ChartMetricId;
  color: string;
  axis: 1 | 2;
  unit: string;
  points: ChartPoint[];
}

/**
 * Soft background profile drawn behind the active metrics. Used for example
 * to show the route elevation profile when the user analyses slope.
 */
export interface ChartBackdropProfile {
  id: string;
  itineraryId: string;
  itineraryName: string;
  color: string;
  points: ChartPoint[];
}

/** Numeric domain (min/max) used for scaling the chart axes. */
export interface AxisDomain {
  min: number;
  max: number;
}

/** Returns the unit string displayed alongside a metric label. */
export function unitForMetric(metric: ChartMetricId): string {
  switch (metric) {
    case 'Vitesse':
    case 'Vitesse moyenne':
    case 'Vent (km/h)':
      return 'km/h';
    case 'Puissance':
    case 'Puissance moyenne':
      return 'W';
    case 'Altitude':
      return 'm';
    case 'Inclinaison (°)':
      return '°';
    case 'Inclinaison (%)':
      return '%';
    case 'Surface':
      return '';
    case 'Température':
    case 'Température ressentie (°)':
      return '°C';
    case 'Pluie (mm)':
      return 'mm';
    case 'Couverture nuageuse (%)':
    case 'Humidité (%)':
      return '%';
    case 'Ensoleillement (min)':
      return 'min';
    default:
      return '';
  }
}

export function isIntervalAverageMetric(metric: ChartMetricId): boolean {
  return metric === 'Vitesse moyenne' || metric === 'Puissance moyenne';
}

export function isInclinationMetric(metric: ChartMetricId): boolean {
  return metric === 'Inclinaison (°)' || metric === 'Inclinaison (%)';
}

/** Format a tick label according to the metric type. */
export function formatAxisValue(metric: ChartMetricId, value: number): string {
  if (!Number.isFinite(value)) return '--';
  const unit = unitForMetric(metric);
  let txt: string;
  if (Math.abs(value) >= 100 || Number.isInteger(value)) {
    txt = String(Math.round(value));
  } else if (Math.abs(value) >= 10) {
    txt = value.toFixed(1);
  } else {
    txt = value.toFixed(2).replace(/\.?0+$/u, '');
  }
  return unit ? `${txt} ${unit}` : txt;
}

/**
 * Whether a metric's running value can be computed from the prediction
 * timeline. Weather/surface metrics are not yet wired and return false so
 * the chart can show an empty plot rather than a flat zero line.
 */
export function metricIsAvailable(metric: ChartMetricId): boolean {
  switch (metric) {
    case 'Vitesse':
    case 'Vitesse moyenne':
    case 'Puissance':
    case 'Puissance moyenne':
    case 'Altitude':
    case 'Inclinaison (°)':
    case 'Inclinaison (%)':
      return true;
    default:
      return false;
  }
}