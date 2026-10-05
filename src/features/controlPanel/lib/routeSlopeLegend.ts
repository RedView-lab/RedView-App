import { percentToDeg } from '@/features/slope/lib/slope-config';

export interface RouteSlopeLegendBand {
  id: string;
  minDeg: number;
  maxDeg: number;
  /** Mêmes bornes en % (borne basse incluse) : profil d'altitude du graphe central. */
  minPct: number;
  maxPct: number;
  color: string;
  label: string;
}

const ROUTE_SLOPE_PERCENT_BREAKPOINTS = [1, 4, 6, 9, 12, 15] as const;

const ROUTE_SLOPE_COLORS = {
  beyondNegative: '#680078',
  negative15to12: '#5200A9',
  negative12to9: '#2200A9',
  negative9to6: '#1447E6',
  negative6to4: '#2C7FFF',
  negative4to1: '#8EC6FF',
  neutral: '#D0D7DE',
  positive1to4: '#FFDA6A',
  positive4to6: '#F6BC1C',
  positive6to9: '#E66F14',
  positive9to12: '#C71700',
  positive12to15: '#9F0025',
  beyondPositive: '#3F001A',
} as const;

const [pct1, pct4, pct6, pct9, pct12, pct15] = ROUTE_SLOPE_PERCENT_BREAKPOINTS;
const [pct1Deg, pct4Deg, pct6Deg, pct9Deg, pct12Deg, pct15Deg] = ROUTE_SLOPE_PERCENT_BREAKPOINTS.map((value) => percentToDeg(value));

/** Classes de pente du tracé, de la descente la plus raide à la montée la plus raide. */
export const ROUTE_SLOPE_LEGEND_BANDS: readonly RouteSlopeLegendBand[] = [
  { id: 'route-slope-beyond-negative', minDeg: -90, maxDeg: -pct15Deg, minPct: -Infinity, maxPct: -pct15, color: ROUTE_SLOPE_COLORS.beyondNegative, label: '< -15%' },
  { id: 'route-slope-negative-15-12', minDeg: -pct15Deg, maxDeg: -pct12Deg, minPct: -pct15, maxPct: -pct12, color: ROUTE_SLOPE_COLORS.negative15to12, label: '-12% / -15%' },
  { id: 'route-slope-negative-12-9', minDeg: -pct12Deg, maxDeg: -pct9Deg, minPct: -pct12, maxPct: -pct9, color: ROUTE_SLOPE_COLORS.negative12to9, label: '-9% / -12%' },
  { id: 'route-slope-negative-9-6', minDeg: -pct9Deg, maxDeg: -pct6Deg, minPct: -pct9, maxPct: -pct6, color: ROUTE_SLOPE_COLORS.negative9to6, label: '-6% / -9%' },
  { id: 'route-slope-negative-6-4', minDeg: -pct6Deg, maxDeg: -pct4Deg, minPct: -pct6, maxPct: -pct4, color: ROUTE_SLOPE_COLORS.negative6to4, label: '-4% / -6%' },
  { id: 'route-slope-negative-4-1', minDeg: -pct4Deg, maxDeg: -pct1Deg, minPct: -pct4, maxPct: -pct1, color: ROUTE_SLOPE_COLORS.negative4to1, label: '-1% / -4%' },
  { id: 'route-slope-neutral', minDeg: -pct1Deg, maxDeg: pct1Deg, minPct: -pct1, maxPct: pct1, color: ROUTE_SLOPE_COLORS.neutral, label: '-1% / 1%' },
  { id: 'route-slope-positive-1-4', minDeg: pct1Deg, maxDeg: pct4Deg, minPct: pct1, maxPct: pct4, color: ROUTE_SLOPE_COLORS.positive1to4, label: '1% / 4%' },
  { id: 'route-slope-positive-4-6', minDeg: pct4Deg, maxDeg: pct6Deg, minPct: pct4, maxPct: pct6, color: ROUTE_SLOPE_COLORS.positive4to6, label: '4% / 6%' },
  { id: 'route-slope-positive-6-9', minDeg: pct6Deg, maxDeg: pct9Deg, minPct: pct6, maxPct: pct9, color: ROUTE_SLOPE_COLORS.positive6to9, label: '6% / 9%' },
  { id: 'route-slope-positive-9-12', minDeg: pct9Deg, maxDeg: pct12Deg, minPct: pct9, maxPct: pct12, color: ROUTE_SLOPE_COLORS.positive9to12, label: '9% / 12%' },
  { id: 'route-slope-positive-12-15', minDeg: pct12Deg, maxDeg: pct15Deg, minPct: pct12, maxPct: pct15, color: ROUTE_SLOPE_COLORS.positive12to15, label: '12% / 15%' },
  { id: 'route-slope-beyond-positive', minDeg: pct15Deg, maxDeg: 90, minPct: pct15, maxPct: Infinity, color: ROUTE_SLOPE_COLORS.beyondPositive, label: '15% <' },
] as const;
