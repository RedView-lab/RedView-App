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
