/**
 * Linear interpolation between two RGB colors expressed as `rgb(r,g,b)` strings.
 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

function rgb(r: number, g: number, b: number): RGB {
  return { r, g, b };
}

function rgbToString(c: RGB): string {
  return `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
}

function lerpRGB(a: RGB, b: RGB, t: number): RGB {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

/**
 * Picks a multi-stop color ramp based on a numeric value.
 * Stops are sorted ascending by `at`. Returns the smoothly interpolated color.
 */
function rampColor(stops: { at: number; color: RGB }[], value: number): RGB {
  if (value <= stops[0].at) return stops[0].color;
  const last = stops[stops.length - 1];
  if (value >= last.at) return last.color;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (value >= a.at && value <= b.at) {
      const t = smoothstep(a.at, b.at, value);
      return lerpRGB(a.color, b.color, t);
    }
  }
  return last.color;
}

/**
 * Atmospheric appearance computed from solar altitude (degrees above horizon).
 * Provides a continuous transition through dawn → day → dusk → night.
 */
export interface SkyAppearance {
  /** Color near the horizon. */
  color: string;
  /** Color of the upper atmosphere. */
  highColor: string;
  /** Background space color (above the atmosphere shell). */
  spaceColor: string;
  /** Star visibility, 0 = off, 1 = full. */
  starIntensity: number;
  /** Horizon blend amount (controls atmospheric haze near the horizon). */
  horizonBlend: number;
}

/**
 * Maps solar altitude (degrees) to a continuous sky appearance.
 *
 * Altitude breakpoints (chosen to match typical atmospheric phases):
 *   +60° .. zenith   : pure midday blue
 *   +10° .. +60°     : day blue with slight horizon haze
 *     0° .. +10°     : sunrise/sunset golden band
 *    -6° ..   0°     : civil twilight (deep blue, no stars)
 *   -12° ..  -6°     : nautical twilight (stars start appearing)
 *   -18° .. -12°     : astronomical twilight (full star field)
 *   below -18°       : full night
 */
export function getSkyAppearance(altitudeDeg: number): SkyAppearance {
  // Horizon haze color (used by Mapbox `fog.color`).
  const horizonColor = rampColor(
    [
      { at: -18, color: rgb(8, 12, 30) }, // night
      { at: -6, color: rgb(40, 50, 90) }, // twilight
      { at: 0, color: rgb(255, 150, 90) }, // sunrise/sunset
      { at: 10, color: rgb(225, 235, 245) }, // day haze
      { at: 60, color: rgb(200, 220, 240) }, // bright midday haze
    ],
    altitudeDeg,
  );

  // Upper sky color (`fog.high-color`).
  const highColor = rampColor(
    [
      { at: -18, color: rgb(2, 4, 14) },
      { at: -6, color: rgb(20, 30, 70) },
      { at: 0, color: rgb(80, 90, 160) },
      { at: 10, color: rgb(90, 150, 230) },
      { at: 60, color: rgb(40, 110, 220) },
    ],
    altitudeDeg,
  );

  // Background space color (visible at low pitch / above the atmosphere shell).
  const spaceColor = rampColor(
    [
      { at: -18, color: rgb(0, 0, 8) },
      { at: -6, color: rgb(8, 12, 30) },
      { at: 0, color: rgb(40, 60, 110) },
      { at: 10, color: rgb(120, 175, 235) },
      { at: 60, color: rgb(135, 200, 245) },
    ],
    altitudeDeg,
  );

  // Stars: invisible while the sun is above 0°; fade in through nautical
  // twilight; fully visible only well below the horizon.
  const starIntensity =
    altitudeDeg >= 0 ? 0 : altitudeDeg >= -18 ? smoothstep(0, -18, altitudeDeg) : 1;

  // Horizon haze blend: thicker during golden hour, thin at midday and night.
  const horizonBlend =
    altitudeDeg < -6
      ? 0.02
      : altitudeDeg < 10
        ? 0.05 + smoothstep(-6, 0, altitudeDeg) * 0.05
        : 0.02;

  return {
    color: rgbToString(horizonColor),
    highColor: rgbToString(highColor),
    spaceColor: rgbToString(spaceColor),
    starIntensity,
    horizonBlend,
  };
}
