import { percentToDeg } from '@/features/slope/lib/slope-config';

export interface RouteSlopeLegendBand {
  id: string;
  minDeg: number;
  maxDeg: number;
  color: string;
  label: string;
}

const ROUTE_SLOPE_PERCENT_BREAKPOINTS = [1, 4, 8, 12, 16] as const;

const ROUTE_SLOPE_COLORS = {
  beyondNegative: '#210561',
  negative16to12: '#2200A9',
  negative12to8: '#490CFF',
  negative8to4: '#5B87FF',
  negative4to1: '#9CAAD0',
  neutral: '#6F6F6F',
  positive1to4: '#C4B191',
  positive4to8: '#FFA25B',
  positive8to12: '#FF4E1D',
  positive12to16: '#C71700',
  beyondPositive: '#7C0F00',
} as const;

const [pct1Deg, pct4Deg, pct8Deg, pct12Deg, pct16Deg] = ROUTE_SLOPE_PERCENT_BREAKPOINTS.map((value) => percentToDeg(value));

export const ROUTE_SLOPE_LEGEND_BANDS: readonly RouteSlopeLegendBand[] = [
  { id: 'route-slope-beyond-negative', minDeg: -90, maxDeg: -pct16Deg, color: ROUTE_SLOPE_COLORS.beyondNegative, label: '< -16%' },
  { id: 'route-slope-negative-16-12', minDeg: -pct16Deg, maxDeg: -pct12Deg, color: ROUTE_SLOPE_COLORS.negative16to12, label: '-16% / -12%' },
  { id: 'route-slope-negative-12-8', minDeg: -pct12Deg, maxDeg: -pct8Deg, color: ROUTE_SLOPE_COLORS.negative12to8, label: '-12% / -8%' },
  { id: 'route-slope-negative-8-4', minDeg: -pct8Deg, maxDeg: -pct4Deg, color: ROUTE_SLOPE_COLORS.negative8to4, label: '-8% / -4%' },
  { id: 'route-slope-negative-4-1', minDeg: -pct4Deg, maxDeg: -pct1Deg, color: ROUTE_SLOPE_COLORS.negative4to1, label: '-4% / -1%' },
  { id: 'route-slope-neutral', minDeg: -pct1Deg, maxDeg: pct1Deg, color: ROUTE_SLOPE_COLORS.neutral, label: '-1% / 1%' },
  { id: 'route-slope-positive-1-4', minDeg: pct1Deg, maxDeg: pct4Deg, color: ROUTE_SLOPE_COLORS.positive1to4, label: '1% / 4%' },
  { id: 'route-slope-positive-4-8', minDeg: pct4Deg, maxDeg: pct8Deg, color: ROUTE_SLOPE_COLORS.positive4to8, label: '4% / 8%' },
  { id: 'route-slope-positive-8-12', minDeg: pct8Deg, maxDeg: pct12Deg, color: ROUTE_SLOPE_COLORS.positive8to12, label: '8% / 12%' },
  { id: 'route-slope-positive-12-16', minDeg: pct12Deg, maxDeg: pct16Deg, color: ROUTE_SLOPE_COLORS.positive12to16, label: '12% / 16%' },
  { id: 'route-slope-beyond-positive', minDeg: pct16Deg, maxDeg: 90, color: ROUTE_SLOPE_COLORS.beyondPositive, label: '16% <' },
] as const;