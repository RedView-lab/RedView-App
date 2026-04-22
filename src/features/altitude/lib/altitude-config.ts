import type {
  AltitudeCategory,
  AltitudeColorMode,
  AltitudeScaleSettingKey,
  AltitudeState,
} from '../types';

export const MAX_ALTITUDE_M = 5000;

const ALTITUDE_STOPS: Record<AltitudeScaleSettingKey, number[]> = {
  '2 couleurs': [0, 1500],
  '3 couleurs': [0, 1000, 2000],
  '4 couleurs': [0, 1000, 2000, 3000],
  '6 couleurs': [0, 500, 1000, 1500, 2000, 3000],
};

const ALTITUDE_COLOR_RAMP = ['#2DBF8C', '#7CD95F', '#FFD800', '#FFB000', '#FF7200', '#FF0000'];

export const DEFAULT_ALTITUDE_STATE: AltitudeState = {
  enabled: false,
  opacity: 0.2,
  colorMode: 'gradient',
  resolution: '0.40 m (LIDAR)',
  scaleSetting: '4 couleurs',
  hiddenBandIds: [],
  customColors: {},
};

function defaultColorAt(index: number, total: number): string {
  if (total <= 1) return ALTITUDE_COLOR_RAMP[0];
  const maxIndex = ALTITUDE_COLOR_RAMP.length - 1;
  const pos = (index / (total - 1)) * maxIndex;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, maxIndex);
  if (lo === hi) return ALTITUDE_COLOR_RAMP[lo];

  const t = pos - lo;
  const a = ALTITUDE_COLOR_RAMP[lo];
  const b = ALTITUDE_COLOR_RAMP[hi];
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`.toUpperCase();
}

export function buildAltitudeCategories(
  scaleSetting: AltitudeScaleSettingKey,
  customColors?: Record<string, string>,
): AltitudeCategory[] {
  const stops = ALTITUDE_STOPS[scaleSetting] ?? ALTITUDE_STOPS['4 couleurs'];
  return stops.map((minMeters, index) => {
    const maxMeters = stops[index + 1] ?? MAX_ALTITUDE_M;
    const id = `alt-${minMeters}`;
    return {
      id,
      label: `${minMeters} m - ${maxMeters} m`,
      minMeters,
      maxMeters,
      color: customColors?.[id] ?? defaultColorAt(index, stops.length),
      displayRange: `${minMeters} m - ${maxMeters} m`,
    };
  });
}

export function buildAltitudeColorExpression(
  categories: AltitudeCategory[],
  mode: AltitudeColorMode,
  hiddenIds?: ReadonlySet<string> | string[],
): unknown[] {
  const hidden = hiddenIds
    ? hiddenIds instanceof Set
      ? hiddenIds
      : new Set(hiddenIds)
    : new Set<string>();
  const colorOf = (cat: AltitudeCategory) => (hidden.has(cat.id) ? 'transparent' : cat.color);

  if (mode === 'step') {
    const expr: unknown[] = ['step', ['raster-value'], 'transparent'];
    for (const cat of categories) {
      expr.push(cat.minMeters, colorOf(cat));
    }
    return expr;
  }

  const expr: unknown[] = ['interpolate', ['linear'], ['raster-value']];
  for (const cat of categories) {
    expr.push(cat.minMeters, colorOf(cat));
  }
  const last = categories[categories.length - 1];
  if (last && last.maxMeters < MAX_ALTITUDE_M) {
    expr.push(MAX_ALTITUDE_M, colorOf(last));
  }
  return expr;
}