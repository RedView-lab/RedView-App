import type { SlopeCategory, SlopeColorMode, SlopeState } from '../types';

// ── Slope categories ──────────────────────────────────────────────────

export const SLOPE_CATEGORIES: SlopeCategory[] = [
  { id: 'flat',      label: 'Modéré',     minDeg: 0,  maxDeg: 7,  color: '#2DBF8C', displayRange: '0% - 12%'    },
  { id: 'moderate',  label: 'Pentu',      minDeg: 7,  maxDeg: 15, color: '#FFD800', displayRange: '12% - 27%'   },
  { id: 'steep',     label: 'Très pentu', minDeg: 15, maxDeg: 25, color: '#FF7200', displayRange: '27% - 47%'   },
  { id: 'very-steep',label: 'Vertical',   minDeg: 25, maxDeg: 35, color: '#E50C0C', displayRange: '47% - 70%'   },
  { id: 'extreme',   label: 'Extrême',    minDeg: 35, maxDeg: 45, color: '#A30000', displayRange: '70% - 100%'  },
  { id: 'cliff',     label: 'Falaise',    minDeg: 45, maxDeg: 90, color: '#5C0000', displayRange: '>100%'       },
];

// ── Default state ─────────────────────────────────────────────────────

export const DEFAULT_SLOPE_STATE: SlopeState = {
  enabled: false,
  opacity: 0.5,
  colorMode: 'gradient',
};

// ── Build raster-color expression ─────────────────────────────────────
// Produces an interpolate or step expression mapping slope degrees → RGBA.
// The input is the decoded raster value via `raster-color-mix`.

// raster-value is normalised to [0, 1] by raster-color-range.
// With range [0, MAX_SLOPE_DEG], normalised = deg / MAX_SLOPE_DEG.
export const MAX_SLOPE_DEG = 90;

function degNorm(deg: number): number {
  return deg / MAX_SLOPE_DEG;
}

export function buildSlopeColorExpression(
  categories: SlopeCategory[],
  mode: SlopeColorMode,
): unknown[] {
  if (mode === 'step') {
    // Step: flat bands of color
    const expr: unknown[] = ['step', ['raster-value'], 'transparent'];
    for (const cat of categories) {
      expr.push(degNorm(cat.minDeg), cat.color);
    }
    return expr;
  }

  // Gradient: smooth interpolation between midpoints
  const expr: unknown[] = [
    'interpolate', ['linear'], ['raster-value'],
  ];

  for (const cat of categories) {
    expr.push(degNorm(cat.minDeg), cat.color);
  }
  // Extend the last color to 90°
  const last = categories[categories.length - 1];
  if (last.maxDeg < MAX_SLOPE_DEG) {
    expr.push(1, last.color);
  }

  return expr;
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Convert degrees to approximate percentage (tan). Caps at 90° → ∞ */
export function degToPercent(deg: number): string {
  if (deg >= 90) return '∞';
  return String(Math.round(Math.tan((deg * Math.PI) / 180) * 100));
}

// ── Color ramp for dynamic bands ──────────────────────────────────────

/** Base color ramp from green (flat) → dark red (cliff). */
const COLOR_RAMP = [
  '#2DBF8C', // green — flat
  '#8DD35F', // light green
  '#FFD800', // yellow
  '#FFA500', // orange
  '#FF7200', // dark orange
  '#E50C0C', // red
  '#C40000', // dark red
  '#A30000', // darker red
  '#7B0000', // very dark red
  '#5C0000', // near-black red
];

/** Interpolate a hex color between two hex colors. t ∈ [0, 1]. */
function lerpColor(a: string, b: string, t: number): string {
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`.toUpperCase();
}

/** Pick a color from the ramp for position t ∈ [0, 1]. */
function rampColor(t: number): string {
  const n = COLOR_RAMP.length - 1;
  const i = Math.min(Math.floor(t * n), n - 1);
  const frac = t * n - i;
  return lerpColor(COLOR_RAMP[i], COLOR_RAMP[i + 1], frac);
}

/** Category labels assigned by slope severity. */
const SEVERITY_LABELS = [
  'Plat', 'Modéré', 'Pentu', 'Très pentu', 'Raide',
  'Très raide', 'Vertical', 'Extrême', 'Falaise', 'Surplomb',
];

function severityLabel(index: number, total: number): string {
  // Map band index onto the severity labels array
  const i = Math.round((index / Math.max(total - 1, 1)) * (SEVERITY_LABELS.length - 1));
  return SEVERITY_LABELS[Math.min(i, SEVERITY_LABELS.length - 1)];
}

// ── Breakpoint validation ─────────────────────────────────────────────
// Robust clamping & deduplication for user-entered breakpoints.
//
// Rules enforced:
//   1. First breakpoint is always 0° (immutable)
//   2. Last band always ends at 90° (immutable)
//   3. All breakpoints clamped to [0, 90]
//   4. Breakpoints must be strictly ascending — if the user sets a value
//      that violates ordering we push neighbours up/down by ≥1° each
//   5. Minimum 1° gap between consecutive breakpoints
//   6. If full correction is impossible (too many bands for the 0–90 range)
//      we fall back to evenly-spaced breakpoints

/**
 * Given `count` bands, produce the default evenly-spaced internal breakpoints.
 * Returns an array of length `count - 1` (the boundaries between bands).
 * The implicit boundaries are 0° on the left and 90° on the right.
 */
export function generateBreakpointsForCount(count: number): number[] {
  const step = 90 / count;
  const bp: number[] = [];
  for (let i = 1; i < count; i++) {
    bp.push(Math.round(step * i));
  }
  return bp;
}

/**
 * Validate and clamp an array of internal breakpoints.
 *
 * @param breakpoints  Raw user-edited breakpoints (length = bandCount - 1).
 *                     Implicit: band[0] starts at 0°, band[last] ends at 90°.
 * @param bandCount    Total number of bands.
 * @returns            Sanitised breakpoints, guaranteed strictly ascending in (0, 90).
 */
export function clampBreakpoints(breakpoints: number[], bandCount: number): number[] {
  const n = bandCount - 1; // number of internal breakpoints

  // Degenerate: single band → no internal breakpoints
  if (n <= 0) return [];

  // Too many bands to fit with ≥1° gaps? Fall back to even spacing.
  if (n >= 90) return generateBreakpointsForCount(bandCount);

  // 1. Clamp each value individually to [1, 89]
  const bp = breakpoints.slice(0, n).map((v) => {
    const rounded = Math.round(v);
    return Math.max(1, Math.min(89, Number.isFinite(rounded) ? rounded : 1));
  });

  // Pad with defaults if too few values provided
  while (bp.length < n) {
    const defaults = generateBreakpointsForCount(bandCount);
    bp.push(defaults[bp.length] ?? bp[bp.length - 1] + 1);
  }

  // 2. Forward pass: ensure strictly ascending with ≥1° gap
  for (let i = 1; i < n; i++) {
    if (bp[i] <= bp[i - 1]) {
      bp[i] = bp[i - 1] + 1;
    }
  }

  // 3. If last breakpoint overflows 89°, backward pass to compress
  if (bp[n - 1] > 89) {
    bp[n - 1] = 89;
    for (let i = n - 2; i >= 0; i--) {
      if (bp[i] >= bp[i + 1]) {
        bp[i] = bp[i + 1] - 1;
      }
    }
  }

  // 4. If first breakpoint underflows 1°, it means the space is too cramped.
  //    Fall back to evenly-spaced.
  if (bp[0] < 1) {
    return generateBreakpointsForCount(bandCount);
  }

  return bp;
}

/**
 * Generate N slope categories from an array of internal breakpoints.
 * breakpoints.length must equal count - 1.
 * If no breakpoints are provided, evenly-spaced defaults are used.
 */
export function generateDynamicCategories(
  count: number,
  customBreakpoints?: number[],
): SlopeCategory[] {
  // Build the full boundary array: [0, bp1, bp2, ..., 90]
  const bp = customBreakpoints && customBreakpoints.length === count - 1
    ? clampBreakpoints(customBreakpoints, count)
    : generateBreakpointsForCount(count);

  const boundaries = [0, ...bp, 90];

  return Array.from({ length: count }, (_, i) => {
    const minDeg = boundaries[i];
    const maxDeg = boundaries[i + 1];
    const minPct = degToPercent(minDeg);
    const maxPct = degToPercent(maxDeg);
    const pctRange = maxDeg >= 90 ? `>${minPct}%` : `${minPct}% - ${maxPct}%`;
    const label = severityLabel(i, count);

    return {
      id: `band-${i}`,
      label,
      minDeg,
      maxDeg,
      color: rampColor(i / Math.max(count - 1, 1)),
      displayRange: pctRange,
    };
  });
}
