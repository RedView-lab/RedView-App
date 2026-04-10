import { clamp, lerp } from './types';

// ── Nullschool / Windy-inspired color ramp ─────────────────────────────
// 12 stops for buttery-smooth gradients. Colors calibrated to match
// professional meteorological visualization palettes.

const COLOR_STOPS: Array<{ speed: number; color: [number, number, number] }> = [
  { speed: 0,  color: [0.40, 0.55, 0.90] }, // soft periwinkle (calm)
  { speed: 1,  color: [0.28, 0.58, 0.96] }, // light blue
  { speed: 3,  color: [0.12, 0.72, 0.92] }, // cyan
  { speed: 5,  color: [0.06, 0.82, 0.65] }, // teal-green
  { speed: 7,  color: [0.08, 0.85, 0.35] }, // green
  { speed: 10, color: [0.50, 0.90, 0.12] }, // lime
  { speed: 13, color: [0.78, 0.92, 0.08] }, // yellow-green
  { speed: 16, color: [0.98, 0.82, 0.05] }, // gold
  { speed: 20, color: [0.98, 0.55, 0.05] }, // orange
  { speed: 25, color: [0.95, 0.28, 0.08] }, // red-orange
  { speed: 32, color: [0.88, 0.12, 0.15] }, // red
  { speed: 40, color: [0.72, 0.06, 0.42] }, // magenta (storm)
];

/**
 * Interpolate the wind-speed color ramp with speed-adaptive alpha.
 * Returns [r, g, b, alpha] where alpha rises with speed for visual emphasis.
 *
 * The tip highlight factor brightens the arrowhead center by ~15% for the
 * characteristic Nullschool "glowing tip" effect.
 */
export function interpolateColor(speed: number, tipHighlight = false): [number, number, number, number] {
  let r: number, g: number, b: number;

  if (speed <= COLOR_STOPS[0].speed) {
    [r, g, b] = COLOR_STOPS[0].color;
  } else if (speed >= COLOR_STOPS[COLOR_STOPS.length - 1].speed) {
    [r, g, b] = COLOR_STOPS[COLOR_STOPS.length - 1].color;
  } else {
    // Find surrounding stops and interpolate
    r = COLOR_STOPS[0].color[0];
    g = COLOR_STOPS[0].color[1];
    b = COLOR_STOPS[0].color[2];
    for (let i = 1; i < COLOR_STOPS.length; i++) {
      const left = COLOR_STOPS[i - 1];
      const right = COLOR_STOPS[i];
      if (speed <= right.speed) {
        const t = (speed - left.speed) / (right.speed - left.speed);
        r = lerp(left.color[0], right.color[0], t);
        g = lerp(left.color[1], right.color[1], t);
        b = lerp(left.color[2], right.color[2], t);
        break;
      }
    }
  }

  // Speed-adaptive alpha: calm wind → more transparent, strong → more opaque
  const alpha = clamp(0.60 + speed * 0.015, 0.60, 0.92);

  // Nullschool-style bright tip: push color toward white
  if (tipHighlight) {
    const boost = 0.15;
    r = Math.min(1, r + boost);
    g = Math.min(1, g + boost);
    b = Math.min(1, b + boost);
  }

  return [r, g, b, alpha];
}

/**
 * Compute trail alpha at parametric position t (0 = tail, 1 = head).
 * Uses t² gradient for smooth tail→head transition with head glow.
 */
export function trailAlpha(
  t: number,
  baseAlpha: number,
  fade: number,
  lifeRatio: number,
): number {
  // Fade-out in last 15% of life to prevent pop-out
  const fadeOut = lifeRatio > 0.85 ? clamp((1 - lifeRatio) / 0.15, 0, 1) : 1;
  // Head glow: boost last 10%
  const headGlow = t > 0.9 ? 1.2 : 1.0;
  // Square-root gradient: fills more of the trail than t² while keeping smooth tail fade
  return baseAlpha * Math.sqrt(t) * fade * fadeOut * headGlow;
}
