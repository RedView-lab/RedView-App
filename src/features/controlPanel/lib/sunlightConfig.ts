import type { SunlightBand, SunlightScaleSetting } from '../types';

export const SUPPORTED_SUNLIGHT_SCALE_SETTINGS = [
  '2 couleurs',
  '3 couleurs',
  '4 couleurs',
  '6 couleurs',
  '8 couleurs',
  '10 couleurs',
  '12 couleurs',
] as const;

export const DEFAULT_SUNLIGHT_COLORS = [
  '#2DBF8C',
  '#5FD37A',
  '#9EE364',
  '#D4E84B',
  '#FFEB3B',
  '#FFD800',
  '#FFAE00',
  '#FF7200',
  '#FF4500',
  '#E50C0C',
  '#C40808',
  '#8B0000',
] as const;

export const DEFAULT_SUNLIGHT_MAX_MINUTES = 240; // 4 heures par défaut

export const DEFAULT_SUNLIGHT_SCALE_SETTING: SunlightScaleSetting = '4 couleurs';

export function sunlightScaleCount(setting: SunlightScaleSetting): number {
  const match = /^(\d+)/u.exec(setting);
  const parsed = match ? Number(match[1]) : 4;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
}

export function formatDurationShort(totalMinutes: number): string {
  if (totalMinutes <= 0) return '0';
  if (totalMinutes < 60) return `${Math.round(totalMinutes)} min`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.round(totalMinutes % 60);
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes.toString().padStart(2, '0')}`;
}

export function parseDurationInput(input: string): number | null {
  const clean = input.trim().toLowerCase().replace(',', '.');
  if (!clean) return null;

  // Format "1h20" or "1h 20" or "1h20m"
  const hmMatch = /^(\d+)\s*h\s*(\d+)?\s*m?$/i.exec(clean);
  if (hmMatch) {
    const h = parseInt(hmMatch[1], 10);
    const m = hmMatch[2] ? parseInt(hmMatch[2], 10) : 0;
    return h * 60 + m;
  }

  // Format "1.5h"
  const decHMatch = /^(\d+(?:\.\d+)?)\s*h$/i.exec(clean);
  if (decHMatch) {
    return Math.round(parseFloat(decHMatch[1]) * 60);
  }

  // Format "20min" or "20m" or "20 min"
  const minMatch = /^(\d+)\s*(?:min|m)$/i.exec(clean);
  if (minMatch) {
    return parseInt(minMatch[1], 10);
  }

  // Format "1:30"
  const colonMatch = /^(\d+):(\d{2})$/.exec(clean);
  if (colonMatch) {
    return parseInt(colonMatch[1], 10) * 60 + parseInt(colonMatch[2], 10);
  }

  // Pure number (assume minutes if >= 10, or hours if <= 6)
  const num = parseFloat(clean);
  if (Number.isFinite(num)) {
    if (num <= 12 && clean.includes('.')) {
      return Math.round(num * 60);
    }
    return Math.round(num);
  }

  return null;
}

export function buildBandLabel(minMinutes: number, maxMinutes: number): string {
  return `${formatDurationShort(minMinutes)} - ${formatDurationShort(maxMinutes)}`;
}

function lerpColor(a: string, b: string, t: number): string {
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`.toUpperCase();
}

export function colorAt(index: number, count: number): string {
  if (count <= 1) return DEFAULT_SUNLIGHT_COLORS[0];
  const maxIdx = DEFAULT_SUNLIGHT_COLORS.length - 1;
  const pos = (index / (count - 1)) * maxIdx;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, maxIdx);
  if (lo === hi) return DEFAULT_SUNLIGHT_COLORS[lo];
  const t = pos - lo;
  return lerpColor(DEFAULT_SUNLIGHT_COLORS[lo], DEFAULT_SUNLIGHT_COLORS[hi], t);
}

export function normalizeSunlightScaleSetting(setting: SunlightScaleSetting | undefined): SunlightScaleSetting {
  if (typeof setting !== 'string') return DEFAULT_SUNLIGHT_SCALE_SETTING;
  return SUPPORTED_SUNLIGHT_SCALE_SETTINGS.includes(setting as (typeof SUPPORTED_SUNLIGHT_SCALE_SETTINGS)[number])
    ? setting
    : DEFAULT_SUNLIGHT_SCALE_SETTING;
}

export function buildDefaultSunlightBands(
  scaleSetting: SunlightScaleSetting = DEFAULT_SUNLIGHT_SCALE_SETTING,
  maxMinutes: number = DEFAULT_SUNLIGHT_MAX_MINUTES,
): SunlightBand[] {
  const count = sunlightScaleCount(normalizeSunlightScaleSetting(scaleSetting));
  const stepMinutes = maxMinutes / count;

  return Array.from({ length: count }, (_, index) => {
    const minM = Math.round(index * stepMinutes);
    const maxM = Math.round((index + 1) * stepMinutes);
    return {
      id: `sunlight-band-${index}`,
      label: buildBandLabel(minM, maxM),
      color: colorAt(index, count),
      visible: true,
      minMinutes: minM,
      maxMinutes: maxM,
    } satisfies SunlightBand;
  });
}

export function normalizeSunlightBands(
  bands: readonly SunlightBand[] | undefined,
  scaleSetting: SunlightScaleSetting = DEFAULT_SUNLIGHT_SCALE_SETTING,
): SunlightBand[] {
  const defaults = buildDefaultSunlightBands(scaleSetting);
  if (!Array.isArray(bands) || bands.length !== defaults.length) return defaults;

  return defaults.map((fallback, index) => {
    const current = bands[index];
    const minMinutes = typeof current?.minMinutes === 'number' ? current.minMinutes : fallback.minMinutes;
    const maxMinutes = typeof current?.maxMinutes === 'number' ? current.maxMinutes : fallback.maxMinutes;
    return {
      ...fallback,
      color: typeof current?.color === 'string' && current.color.trim() ? current.color : fallback.color,
      visible: typeof current?.visible === 'boolean' ? current.visible : fallback.visible,
      minMinutes,
      maxMinutes,
      label: buildBandLabel(minMinutes, maxMinutes),
    };
  });
}

export function resampleSunlightBands(
  bands: readonly SunlightBand[] | undefined,
  scaleSetting: SunlightScaleSetting,
): SunlightBand[] {
  const count = sunlightScaleCount(normalizeSunlightScaleSetting(scaleSetting));
  const defaults = buildDefaultSunlightBands(scaleSetting);
  if (!Array.isArray(bands) || bands.length === 0) return defaults;

  return defaults.map((fallback, index) => {
    const sourceIndex = Math.min(
      bands.length - 1,
      Math.round((index / Math.max(1, count - 1)) * Math.max(0, bands.length - 1)),
    );
    const source = bands[sourceIndex];
    return {
      ...fallback,
      color: fallback.color,
      visible: typeof source?.visible === 'boolean' ? source.visible : fallback.visible,
    };
  });
}

export function updateSunlightBandBreakpoint(
  bands: SunlightBand[],
  bandIndex: number,
  field: 'min' | 'max',
  valueMinutes: number,
): SunlightBand[] {
  const clamped = Math.max(0, Math.min(1440, Math.round(valueMinutes)));
  return bands.map((band, idx) => {
    let nextMin = band.minMinutes;
    let nextMax = band.maxMinutes;

    if (idx === bandIndex) {
      if (field === 'min') nextMin = clamped;
      if (field === 'max') nextMax = clamped;
    } else if (idx === bandIndex + 1 && field === 'max') {
      nextMin = clamped;
    } else if (idx === bandIndex - 1 && field === 'min') {
      nextMax = clamped;
    }

    return {
      ...band,
      minMinutes: nextMin,
      maxMinutes: nextMax,
      label: buildBandLabel(nextMin, nextMax),
    };
  });
}