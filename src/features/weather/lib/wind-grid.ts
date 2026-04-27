// ── Zoom → grid spacing mapping ───────────────────────────────────────
// Uses power-of-2 aligned spacings so that higher-zoom grids are exact
// subdivisions of lower-zoom grids. This ensures that when zooming in,
// the grid refines rather than shifting entirely — preventing abrupt
// changes in IDW interpolation that cause wind direction artifacts.

const SPACING_TABLE: [number, number][] = [
  [4, 4.0],
  [5, 2.0],
  [6, 1.0],
  [7, 0.5],
  [8, 0.25],
  [9, 0.125],
  [10, 0.0625],
  [11, 0.05],
  [12, 0.025],
  [13, 0.0125],
  [14, 0.01],
];

const MIN_SPACING = 0.005;
const MAX_POINTS = 50; // single API batch — avoids 429 rate limits
const RESERVOIR_SHARE = 0.5;
const VIEWPORT_SHARE = 0.3;

/**
 * Get grid spacing (degrees) for a given zoom level.
 * Interpolates between table entries and then snaps to the nearest
 * power-of-2 subdivision of 1° to maintain grid alignment.
 */
function spacingForZoom(zoom: number): number {
  if (zoom <= SPACING_TABLE[0][0]) return SPACING_TABLE[0][1];

  let raw = MIN_SPACING;
  for (let i = 1; i < SPACING_TABLE.length; i++) {
    const [z1, s1] = SPACING_TABLE[i - 1];
    const [z2, s2] = SPACING_TABLE[i];
    if (zoom <= z2) {
      const t = (zoom - z1) / (z2 - z1);
      raw = s1 + t * (s2 - s1);
      break;
    }
  }

  // Snap to nearest power-of-2 fraction of 1° for grid alignment
  // This ensures e.g. 0.07 → 0.0625, 0.18 → 0.125, etc.
  if (raw >= 0.01) {
    const log2 = Math.round(Math.log2(1 / raw));
    raw = 1 / Math.pow(2, log2);
  }

  return Math.max(raw, MIN_SPACING);
}

/**
 * Round a coordinate to the nearest grid step.
 * This ensures cache consistency when viewport shifts slightly.
 */
function snapToGrid(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function estimatedPointCount(
  bounds: { north: number; south: number; east: number; west: number },
  spacing: number,
): number {
  const latSteps = Math.floor((bounds.north - bounds.south) / spacing) + 1;
  const lngSteps = Math.floor((bounds.east - bounds.west) / spacing) + 1;
  return Math.max(0, latSteps) * Math.max(0, lngSteps);
}

function spacingForBudget(
  bounds: { north: number; south: number; east: number; west: number },
  baseSpacing: number,
  maxPoints: number,
): number {
  let currentSpacing = baseSpacing;

  for (let attempt = 0; attempt < 10; attempt++) {
    const total = estimatedPointCount(bounds, currentSpacing);
    if (total <= maxPoints) break;
    currentSpacing *= Math.sqrt(total / maxPoints) * 1.05;
  }

  return currentSpacing;
}

function pushGridPoints(
  target: { lat: number; lng: number }[],
  seen: Set<string>,
  bounds: { north: number; south: number; east: number; west: number },
  spacing: number,
  maxPoints: number,
): void {
  if (maxPoints <= 0) return;

  const snappedSouth = snapToGrid(bounds.south, spacing);
  const snappedNorth = snapToGrid(bounds.north, spacing);
  const snappedWest = snapToGrid(bounds.west, spacing);
  const snappedEast = snapToGrid(bounds.east, spacing);

  for (let lat = snappedSouth; lat <= snappedNorth; lat += spacing) {
    for (let lng = snappedWest; lng <= snappedEast; lng += spacing) {
      if (target.length >= maxPoints) return;
      const clampedLat = Math.max(-90, Math.min(90, Math.round(lat * 1e6) / 1e6));
      const clampedLng = Math.max(-180, Math.min(180, Math.round(lng * 1e6) / 1e6));
      const key = coordCacheKey(clampedLat, clampedLng);
      if (seen.has(key)) continue;
      seen.add(key);
      target.push({ lat: clampedLat, lng: clampedLng });
    }
  }
}

function centerFocusBounds(bounds: { north: number; south: number; east: number; west: number }) {
  const centerLat = (bounds.north + bounds.south) / 2;
  const centerLng = (bounds.east + bounds.west) / 2;
  const halfLat = (bounds.north - bounds.south) * 0.22;
  const halfLng = (bounds.east - bounds.west) * 0.22;

  return {
    north: Math.min(90, centerLat + halfLat),
    south: Math.max(-90, centerLat - halfLat),
    east: Math.min(180, centerLng + halfLng),
    west: Math.max(-180, centerLng - halfLng),
  };
}

/**
 * Compute a grid of lat/lng sample points covering the given map bounds.
 * Returns coordinates snapped to a regular grid for cache-friendly lookups.
 * The budget stays capped, but it is distributed across three tiers:
 * 1) a coarse reservoir around the viewport,
 * 2) a denser live viewport,
 * 3) an extra-dense center focus.
 */
export function computeWindGrid(
  bounds: { north: number; south: number; east: number; west: number },
  viewportBounds: { north: number; south: number; east: number; west: number },
  zoom: number,
): { lat: number; lng: number }[] {
  const points: { lat: number; lng: number }[] = [];
  const seen = new Set<string>();
  const spacing = spacingForZoom(zoom);
  const viewportBudget = Math.max(8, Math.round(MAX_POINTS * VIEWPORT_SHARE));
  const reservoirBudget = Math.max(10, Math.round(MAX_POINTS * RESERVOIR_SHARE));
  const focusBudget = Math.max(0, MAX_POINTS - reservoirBudget - viewportBudget);
  const focusBounds = centerFocusBounds(viewportBounds);

  pushGridPoints(
    points,
    seen,
    bounds,
    spacingForBudget(bounds, spacing, reservoirBudget),
    MAX_POINTS,
  );

  pushGridPoints(
    points,
    seen,
    viewportBounds,
    spacingForBudget(viewportBounds, Math.max(MIN_SPACING, spacing * 0.65), points.length + viewportBudget),
    MAX_POINTS,
  );

  pushGridPoints(
    points,
    seen,
    focusBounds,
    spacingForBudget(focusBounds, Math.max(MIN_SPACING, spacing * 0.4), points.length + focusBudget),
    MAX_POINTS,
  );

  return points;
}

/**
 * Create a stable cache key for a coordinate pair (rounded to grid precision).
 */
export function coordCacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}
