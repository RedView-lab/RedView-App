import { formatPaceSeconds } from '@/shared/lib/pace';

/**
 * Échantillon de tracé de base utilisé par les constructeurs de séries et les interactions du graphique.
 */
export interface RouteChartPoint {
  lat: number;
  lon: number;
  distanceM?: number;
  elevationM?: number | null;
  gradientPct?: number | null;
}

/**
 * Identifiant d'une option d'axe proposée par les menus déroulants de l'analyse.
 * À garder synchronisé avec les libellés rendus dans CenterPanelAnalysis.
 */
export type AxisMetricId =
  | 'Altitude'
  | 'Vitesse'
  | 'Vitesse moyenne'
  | 'Allure'
  | 'Allure moyenne'
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

export type ChartMetricId = AxisMetricId;

export type AxisMode = 'distance' | 'temps' | 'heure';

/** Point unique d'une série du graphique, exprimé dans les unités de l'axe (km / s / métrique). */
export interface ChartPoint {
  x: number;
  y: number;
}

/** Descripteur prêt à tracer : une courbe pour un itinéraire sur un axe. */
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
 * Profil de fond discret dessiné derrière les métriques actives. Sert par
 * exemple à montrer le profil d'altitude du tracé quand l'utilisateur analyse la pente.
 */
export interface ChartBackdropProfile {
  id: string;
  itineraryId: string;
  itineraryName: string;
  color: string;
  points: ChartPoint[];
}

/** Domaine numérique (min/max) utilisé pour mettre à l'échelle les axes du graphique. */
export interface AxisDomain {
  min: number;
  max: number;
}

/** Renvoie l'unité affichée à côté du libellé d'une métrique. */
export function unitForMetric(metric: ChartMetricId): string {
  switch (metric) {
    case 'Vitesse':
    case 'Vitesse moyenne':
    case 'Vent (km/h)':
      return 'km/h';
    case 'Allure':
    case 'Allure moyenne':
      return '/km';
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

/** Allure de course, stockée dans la série en minutes décimales par km. */
export function isPaceMetric(metric: ChartMetricId): boolean {
  return metric === 'Allure' || metric === 'Allure moyenne';
}

export function isPowerMetric(metric: ChartMetricId): boolean {
  return metric === 'Puissance' || metric === 'Puissance moyenne';
}

/** « 5:32 /km » à partir de minutes décimales par km. */
export function formatPaceMinutes(minutesPerKm: number, withUnit = true): string {
  return formatPaceSeconds(minutesPerKm * 60, { unit: withUnit });
}

export function isInclinationMetric(metric: ChartMetricId): boolean {
  return metric === 'Inclinaison (°)' || metric === 'Inclinaison (%)';
}

/** Met en forme un libellé de graduation selon le type de métrique. */
export function formatAxisValue(metric: ChartMetricId, value: number): string {
  if (!Number.isFinite(value)) return '--';
  if (isPaceMetric(metric)) return formatPaceMinutes(value);
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

export function isWeatherMetric(metric: ChartMetricId): boolean {
  switch (metric) {
    case 'Température':
    case 'Température ressentie (°)':
    case 'Pluie (mm)':
    case 'Vent (km/h)':
    case 'Couverture nuageuse (%)':
    case 'Humidité (%)':
    case 'Ensoleillement (min)':
      return true;
    default:
      return false;
  }
}

/**
 * Indique si la valeur de course d'une métrique peut être calculée. Vrai pour
 * les métriques du modèle physique (vitesse, puissance, altitude, pente) et pour
 * toutes les métriques météo de tracé prises en charge.
 */
export function metricIsAvailable(metric: ChartMetricId): boolean {
  switch (metric) {
    case 'Vitesse':
    case 'Vitesse moyenne':
    case 'Allure':
    case 'Allure moyenne':
    case 'Puissance':
    case 'Puissance moyenne':
    case 'Altitude':
    case 'Inclinaison (°)':
    case 'Inclinaison (%)':
    case 'Température':
    case 'Température ressentie (°)':
    case 'Pluie (mm)':
    case 'Vent (km/h)':
    case 'Couverture nuageuse (%)':
    case 'Humidité (%)':
    case 'Ensoleillement (min)':
      return true;
    default:
      return false;
  }
}