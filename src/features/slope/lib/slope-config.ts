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

/**
 * Generate N evenly-spaced slope categories that always cover 0° → 90°.
 * More bands = more precision.
 */
export function generateDynamicCategories(count: number): SlopeCategory[] {
  const step = 90 / count;
  return Array.from({ length: count }, (_, i) => {
    const minDeg = Math.round(step * i);
    const maxDeg = i === count - 1 ? 90 : Math.round(step * (i + 1));
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
