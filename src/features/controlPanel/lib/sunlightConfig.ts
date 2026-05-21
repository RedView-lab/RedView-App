import type { SunlightBand, SunlightScaleSetting } from '../types';

const SUPPORTED_SUNLIGHT_SCALE_SETTINGS = ['2 couleurs', '3 couleurs', '4 couleurs', '6 couleurs'] as const;
const DEFAULT_SUNLIGHT_COLORS = ['#2DBF8C', '#FFD800', '#FF7200', '#E50C0C', '#E5261F', '#8B0000'] as const;
const DEFAULT_SUNLIGHT_MAX_MINUTES = 240;

export const DEFAULT_SUNLIGHT_SCALE_SETTING: SunlightScaleSetting = '4 couleurs';

function sunlightScaleCount(setting: SunlightScaleSetting): number {
  const match = /^(\d+)/u.exec(setting);
  const parsed = match ? Number(match[1]) : 4;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
}

function formatDurationShort(totalMinutes: number): string {
  if (totalMinutes <= 0) return '0';
  if (totalMinutes < 60) return `${totalMinutes} min`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes.toString().padStart(2, '0')}`;
}

function buildBandLabel(minMinutes: number, maxMinutes: number): string {
  return `${formatDurationShort(minMinutes)} - ${formatDurationShort(maxMinutes)}`;
}

function colorAt(index: number): string {
  return DEFAULT_SUNLIGHT_COLORS[Math.min(index, DEFAULT_SUNLIGHT_COLORS.length - 1)] ?? '#FFFFFF';
}

export function normalizeSunlightScaleSetting(setting: SunlightScaleSetting | undefined): SunlightScaleSetting {
  if (typeof setting !== 'string') return DEFAULT_SUNLIGHT_SCALE_SETTING;
  return SUPPORTED_SUNLIGHT_SCALE_SETTINGS.includes(setting as (typeof SUPPORTED_SUNLIGHT_SCALE_SETTINGS)[number])
    ? setting
    : DEFAULT_SUNLIGHT_SCALE_SETTING;
}

export function buildDefaultSunlightBands(scaleSetting: SunlightScaleSetting = DEFAULT_SUNLIGHT_SCALE_SETTING): SunlightBand[] {
  const count = sunlightScaleCount(normalizeSunlightScaleSetting(scaleSetting));
  const stepMinutes = DEFAULT_SUNLIGHT_MAX_MINUTES / count;

  return Array.from({ length: count }, (_, index) => {
    const minMinutes = Math.round(index * stepMinutes);
    const maxMinutes = Math.round((index + 1) * stepMinutes);
    return {
      id: `sunlight-band-${index}`,
      label: buildBandLabel(minMinutes, maxMinutes),
      color: colorAt(index),
      visible: true,
      minMinutes,
      maxMinutes,
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
    return {
      ...fallback,
      color: typeof current?.color === 'string' && current.color.trim() ? current.color : fallback.color,
      visible: typeof current?.visible === 'boolean' ? current.visible : fallback.visible,
    };
  });
}

export function resampleSunlightBands(
  bands: readonly SunlightBand[] | undefined,
  scaleSetting: SunlightScaleSetting,
): SunlightBand[] {
  const defaults = buildDefaultSunlightBands(scaleSetting);
  if (!Array.isArray(bands) || bands.length === 0) return defaults;

  return defaults.map((fallback, index) => {
    const sourceIndex = Math.min(
      bands.length - 1,
      Math.round((index / Math.max(1, defaults.length - 1)) * Math.max(0, bands.length - 1)),
    );
    const source = bands[sourceIndex];
    return {
      ...fallback,
      color: typeof source?.color === 'string' && source.color.trim() ? source.color : fallback.color,
      visible: typeof source?.visible === 'boolean' ? source.visible : fallback.visible,
    };
  });
}