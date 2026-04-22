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
  customBreakpoints?: number[],
): AltitudeCategory[] {
  const defaultStops = ALTITUDE_STOPS[scaleSetting] ?? ALTITUDE_STOPS['4 couleurs'];
  const count = defaultStops.length;
  const breakpoints = customBreakpoints && customBreakpoints.length === count - 1
    ? clampAltitudeBreakpoints(customBreakpoints, count)
    : defaultStops.slice(1);
  const stops = [0, ...breakpoints];
  return stops.map((minMeters, index) => {
    const maxMeters = stops[index + 1] ?? MAX_ALTITUDE_M;
    const id = `alt-band-${index}`;
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

export function altitudeBandCountFromSetting(setting: AltitudeScaleSettingKey | string): number {
  const match = /^(\d+)/.exec(setting);
  return match ? Number(match[1]) : 4;
}

export function generateAltitudeBreakpointsForCount(count: number): number[] {
  const defaults = ALTITUDE_STOPS[`${count} couleurs` as AltitudeScaleSettingKey];
  if (defaults) return defaults.slice(1);

  const step = MAX_ALTITUDE_M / count;
  const out: number[] = [];
  for (let index = 1; index < count; index++) out.push(Math.round(step * index));
  return out;
}

export function clampAltitudeBreakpoints(breakpoints: number[], bandCount: number): number[] {
  const count = bandCount - 1;
  if (count <= 0) return [];
  if (count >= MAX_ALTITUDE_M) return generateAltitudeBreakpointsForCount(bandCount);

  const bp = breakpoints.slice(0, count).map((value) => {
    const rounded = Math.round(value);
    return Math.max(1, Math.min(MAX_ALTITUDE_M - 1, Number.isFinite(rounded) ? rounded : 1));
  });

  while (bp.length < count) {
    const defaults = generateAltitudeBreakpointsForCount(bandCount);
    bp.push(defaults[bp.length] ?? bp[bp.length - 1] + 1);
  }

  for (let index = 1; index < count; index++) {
    if (bp[index] <= bp[index - 1]) bp[index] = bp[index - 1] + 1;
  }

  if (bp[count - 1] > MAX_ALTITUDE_M - 1) {
    bp[count - 1] = MAX_ALTITUDE_M - 1;
    for (let index = count - 2; index >= 0; index--) {
      if (bp[index] >= bp[index + 1]) bp[index] = bp[index + 1] - 1;
    }
  }

  if (bp[0] < 1) return generateAltitudeBreakpointsForCount(bandCount);
  return bp;
}