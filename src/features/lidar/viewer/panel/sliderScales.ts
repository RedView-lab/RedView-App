/** Positions des curseurs (1–100) du panneau du viewer et les valeurs qu'elles représentent. */

export const POINT_SIZE_MIN = 0.02;
export const POINT_SIZE_MAX = 1.0;
const DENSITY_SCALE_MIN = 0.01;
const DENSITY_SCALE_MAX = 1.0;
const ELEVATION_EXAGGERATION_MIN = 0.5;
const ELEVATION_EXAGGERATION_MAX = 3.0;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function toSliderPercent(value: number): number {
  return clamp(Math.round(value), 1, 100);
}

function interpolateLog(min: number, max: number, normalized: number): number {
  return min * Math.pow(max / min, normalized);
}

function normalizeLog(value: number, min: number, max: number): number {
  return Math.log(value / min) / Math.log(max / min);
}

export function pointSizeToPercent(pointSize: number): number {
  const normalized = normalizeLog(
    clamp(pointSize, POINT_SIZE_MIN, POINT_SIZE_MAX),
    POINT_SIZE_MIN,
    POINT_SIZE_MAX,
  );
  return toSliderPercent(1 + normalized * 99);
}

export function percentToPointSize(percent: number): number {
  const normalized = (toSliderPercent(percent) - 1) / 99;
  return interpolateLog(POINT_SIZE_MIN, POINT_SIZE_MAX, normalized);
}

export function densityScaleToPercent(scale: number): number {
  return toSliderPercent(clamp(scale, DENSITY_SCALE_MIN, DENSITY_SCALE_MAX) * 100);
}

export function percentToDensityScale(percent: number): number {
  return toSliderPercent(percent) / 100;
}

export const FIXED_POINT_PX_MIN = 1;
export const FIXED_POINT_PX_MAX = 10;

export function percentToFixedPointPixels(percent: number): number {
  const normalized = (toSliderPercent(percent) - 1) / 99;
  return FIXED_POINT_PX_MIN + normalized * (FIXED_POINT_PX_MAX - FIXED_POINT_PX_MIN);
}

export function fixedPointPixelsToPercent(pixels: number): number {
  const normalized = (clamp(pixels, FIXED_POINT_PX_MIN, FIXED_POINT_PX_MAX) - FIXED_POINT_PX_MIN)
    / (FIXED_POINT_PX_MAX - FIXED_POINT_PX_MIN);
  return toSliderPercent(1 + normalized * 99);
}

/** Force de l'EDL : curseur à 50 ≈ 1,0, la valeur par défaut de CloudCompare/Potree. */
export function percentToEdlStrength(percent: number): number {
  return toSliderPercent(percent) / 50;
}

export function elevationPercentToFactor(percent: number): number {
  const normalized = (toSliderPercent(percent) - 1) / 99;
  return ELEVATION_EXAGGERATION_MIN + normalized * (ELEVATION_EXAGGERATION_MAX - ELEVATION_EXAGGERATION_MIN);
}

export function factorToElevationPercent(factor: number): number {
  const clamped = clamp(factor, ELEVATION_EXAGGERATION_MIN, ELEVATION_EXAGGERATION_MAX);
  const normalized = (clamped - ELEVATION_EXAGGERATION_MIN) / (ELEVATION_EXAGGERATION_MAX - ELEVATION_EXAGGERATION_MIN);
  return toSliderPercent(1 + normalized * 99);
}
