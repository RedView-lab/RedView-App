import type { SlopeCategory, SlopeColorMode, SlopeState } from '../types';

// ── Default state ─────────────────────────────────────────────────────

export const DEFAULT_SLOPE_STATE: SlopeState = {
  enabled: false,
  opacity: 0.5,
  colorMode: 'gradient',
  resolution: 'auto',
};

// ── Build raster-color expression ─────────────────────────────────────
// Produces an interpolate or step expression mapping slope degrees → RGBA.
// The input is the decoded raster value via `raster-color-mix`.

// `["raster-value"]` returns the value decoded by raster-color-mix and
// clamped to raster-color-range, **in the same units as the range**
// (NOT normalised to [0, 1]). With the sqrt-gamma encoding (see
// slope-source.ts), the SW writes R = round(sqrt(deg/90) * 255) and the
// raster-color-mix decodes that to V = sqrt(deg/90) * 90 ∈ [0, 90]. So the
// stop positions in the interpolate/step expression must be expressed in
// the same V-space, not raw degrees: a category breakpoint at deg_k must
// be placed at V_k = sqrt(deg_k/90) * 90 = sqrt(deg_k * 90).
//
// The sqrt gamma concentrates the encoding precision in the low-slope range
// (the part the user actually scrutinises). Mapbox, however, lerps colours
// linearly in raster-value space, i.e. along sqrt(deg): at 2.5° between stops
// at 0° and 5° it would already be 71 % of the way. The gradient therefore
// gets GRADIENT_SUBSTEPS degree-spaced sub-stops per band, so the colour is
// linear in degrees (as in the legend and the LiDAR viewer's ramp) to within
// a few percent of a band, while the encoding keeps its precision.
export const MAX_SLOPE_DEG = 90;
const GRADIENT_SUBSTEPS = 6;

function degStop(deg: number): number {
  // Map a degree breakpoint to the raster-value (sqrt-gamma) space.
  // Identity at 0° and at 90° (the two anchors), monotonic in between.
  if (deg <= 0) return 0;
  if (deg >= MAX_SLOPE_DEG) return MAX_SLOPE_DEG;
  return Math.sqrt(deg * MAX_SLOPE_DEG);
}

type Rgba = [number, number, number, number];

/** '#RRGGBB' → straight RGBA (alpha 0..1); null for anything else. */
function parseHexRgba(hex: string, alpha: number): Rgba | null {
  const match = /^#([0-9a-f]{6})$/iu.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, alpha];
}

function rgbaString([r, g, b, a]: Rgba): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(a * 1000) / 1000})`;
}

/**
 * Build a Mapbox raster-color expression from a list of categories.
 *
 * @param categories  Sorted slope bands (ascending minDeg).
 * @param mode        'gradient' = smooth lerp between band colors;
 *                    'step'     = flat color per band.
 * @param hiddenIds   Optional category ids whose pixels must render fully
 *                    transparent (band-visibility toggles in the panel).
 *                    Hidden bands are emitted as `'transparent'` stops, so
 *                    visibility changes never invalidate any tile — they
 *                    swap the paint expression in-place.
 */
export function buildSlopeColorExpression(
  categories: SlopeCategory[],
  mode: SlopeColorMode,
  hiddenIds?: ReadonlySet<string> | string[],
): unknown[] {
  const hidden = hiddenIds
    ? (hiddenIds instanceof Set ? hiddenIds : new Set(hiddenIds))
    : new Set<string>();
  const colorOf = (cat: SlopeCategory) =>
    hidden.has(cat.id) ? 'transparent' : cat.color;

  if (mode === 'step') {
    // Step: hard-edged bands. First band starts at 0°, each stop fixes the
    // color from there until the next breakpoint.
    const expr: unknown[] = ['step', ['raster-value'], 'transparent'];
    for (const cat of categories) {
      expr.push(degStop(cat.minDeg), colorOf(cat));
    }
    return expr;
  }

  // Gradient: linear interpolation (in degrees) across band-start colors.
  // Hidden bands keep their colour at alpha 0 — the fade in/out at the
  // boundary is the LiDAR viewer's, visually nicer than a hard cut.
  const expr: unknown[] = ['interpolate', ['linear'], ['raster-value']];
  categories.forEach((cat, index) => {
    expr.push(degStop(cat.minDeg), colorOf(cat));
    const next = categories[index + 1];
    if (!next || !(next.minDeg > cat.minDeg)) return;
    const from = parseHexRgba(cat.color, hidden.has(cat.id) ? 0 : 1);
    const to = parseHexRgba(next.color, hidden.has(next.id) ? 0 : 1);
    if (!from || !to) return;
    for (let k = 1; k < GRADIENT_SUBSTEPS; k++) {
      const t = k / GRADIENT_SUBSTEPS;
      const deg = cat.minDeg + (next.minDeg - cat.minDeg) * t;
      const rgba = from.map((channel, i) => channel + (to[i]! - channel) * t) as Rgba;
      expr.push(degStop(deg), rgbaString(rgba));
    }
  });
  // Extend the last color out to 90° so we never get a black/transparent tail
  const last = categories[categories.length - 1];
  if (last.maxDeg < MAX_SLOPE_DEG) {
    expr.push(degStop(MAX_SLOPE_DEG), colorOf(last));
  }

  return expr;
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Convert degrees to approximate percentage (tan). Caps at 90° → ∞ */
function degToPercent(deg: number): string {
  if (deg >= 90) return '∞';
  return String(Math.round(Math.tan((deg * Math.PI) / 180) * 100));
}

export function percentToDeg(percent: number): number {
  if (!(percent > 0)) return 0;
  return Math.round((((Math.atan(percent / 100) * 180) / Math.PI) * 10)) / 10;
}

export function formatSlopeDegreeLabel(deg: number): string {
  const rounded = Math.round(deg * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// ── Color ramp for dynamic bands ──────────────────────────────────────

/**
 * Palettes dédiées par nombre de bandes : un échantillonnage uniforme d'une
 * seule rampe donne des extrêmes brutaux à faible N (vert → noir en 2
 * couleurs). Chaque palette part d'un vert émeraude, passe par jaune/ambre
 * puis rouge, et termine sur un bordeaux-prune (lisible sur fond satellite,
 * contrairement au noir).
 */
const SLOPE_PALETTES_BY_COUNT: Record<number, string[]> = {
  2: ['#2FB67C', '#E5484D'],
  3: ['#34B96A', '#F5B83D', '#D92D4A'],
  4: ['#34B96A', '#EFD43E', '#F0782E', '#B3204F'],
  5: ['#2FAF6A', '#A6D146', '#F5C93D', '#EF7430', '#B3204F'],
  6: ['#24A46A', '#8CCB45', '#F2D63F', '#F59A35', '#E24A3B', '#9E1C55'],
  8: ['#1E9A63', '#4DB960', '#A6D146', '#F2D63F', '#F6AE38', '#F07A2F', '#D93A40', '#8E1B58'],
  10: [
    '#17915F',
    '#35AD62',
    '#7DC54B',
    '#C3D843',
    '#F2D63F',
    '#F6B53A',
    '#F48A32',
    '#E65A36',
    '#C42A45',
    '#7A1A57',
  ],
};

/** Rampe continue de secours pour les nombres de bandes sans palette dédiée. */
const COLOR_RAMP = SLOPE_PALETTES_BY_COUNT[10];

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
  'Quasi plat', 'Roulant', 'Soutenu', 'Raide', 'Mur', 'Extrême',
];

function severityLabel(index: number, total: number, minDeg?: number): string {
  if (minDeg !== undefined) {
    if (minDeg < 10) return 'Quasi plat';
    if (minDeg < 20) return 'Roulant';
    if (minDeg < 30) return 'Soutenu';
    if (minDeg < 40) return 'Raide';
    if (minDeg < 50) return 'Mur';
    return 'Extrême';
  }
  const i = Math.round((index / Math.max(total - 1, 1)) * (SEVERITY_LABELS.length - 1));
  return SEVERITY_LABELS[Math.min(i, SEVERITY_LABELS.length - 1)];
}

const DEFAULT_DEGREE_BREAKPOINTS_BY_COUNT: Record<number, number[]> = {
  2: [30],
  3: [15, 30],
  4: [15, 30, 45],
  5: [10, 20, 30, 45],
  6: [10, 20, 30, 40, 50],
  8: [10, 20, 25, 30, 35, 40, 50],
  10: [5, 10, 15, 20, 25, 30, 35, 40, 50],
};

const BREAKPOINT_STEP_DEG = 0.1;

function roundBreakpointDeg(value: number): number {
  return Math.round(value / BREAKPOINT_STEP_DEG) * BREAKPOINT_STEP_DEG;
}

// ── Breakpoint validation ─────────────────────────────────────────────

/**
 * Given `count` bands, produce clean, intuitive degree breakpoints.
 * Returns an array of length `count - 1` (the boundaries between bands).
 * The implicit boundaries are 0° on the left and 90° on the right.
 */
function generateBreakpointsForCount(count: number): number[] {
  const preset = DEFAULT_DEGREE_BREAKPOINTS_BY_COUNT[count];
  if (preset) return [...preset];

  const step = 50 / count;
  const bp: number[] = [];
  for (let i = 1; i < count; i += 1) {
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

  // Too many bands to fit with ≥0.1° gaps? Fall back to even spacing.
  if (n >= 900) return generateBreakpointsForCount(bandCount);

  // 1. Clamp each value individually to [0.1, 89.9]
  const bp = breakpoints.slice(0, n).map((v) => {
    const rounded = roundBreakpointDeg(v);
    return Math.max(BREAKPOINT_STEP_DEG, Math.min(90 - BREAKPOINT_STEP_DEG, Number.isFinite(rounded) ? rounded : BREAKPOINT_STEP_DEG));
  });

  // Pad with defaults if too few values provided
  while (bp.length < n) {
    const defaults = generateBreakpointsForCount(bandCount);
    bp.push(defaults[bp.length] ?? roundBreakpointDeg((bp[bp.length - 1] ?? 0) + BREAKPOINT_STEP_DEG));
  }

  // 2. Forward pass: ensure strictly ascending with ≥0.1° gap
  for (let i = 1; i < n; i++) {
    if (bp[i] <= bp[i - 1]) {
      bp[i] = roundBreakpointDeg(bp[i - 1] + BREAKPOINT_STEP_DEG);
    }
  }

  // 3. If last breakpoint overflows 89.9°, backward pass to compress
  if (bp[n - 1] > 90 - BREAKPOINT_STEP_DEG) {
    bp[n - 1] = 90 - BREAKPOINT_STEP_DEG;
    for (let i = n - 2; i >= 0; i--) {
      if (bp[i] >= bp[i + 1]) {
        bp[i] = roundBreakpointDeg(bp[i + 1] - BREAKPOINT_STEP_DEG);
      }
    }
  }

  // 4. If first breakpoint underflows 0.1°, it means the space is too cramped.
  //    Fall back to evenly-spaced.
  if (bp[0] < BREAKPOINT_STEP_DEG) {
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
    const label = severityLabel(i, count, minDeg);

    return {
      id: `band-${i}`,
      label,
      minDeg,
      maxDeg,
      color: SLOPE_PALETTES_BY_COUNT[count]?.[i] ?? rampColor(i / Math.max(count - 1, 1)),
      displayRange: pctRange,
    };
  });
}
