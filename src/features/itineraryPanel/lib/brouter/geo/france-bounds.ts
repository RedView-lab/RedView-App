/**
 * Quick "is this point inside France?" check, for the temporary
 * France-only routing constraint.
 *
 * We use a coarse bounding-box for metropolitan France + Corsica plus a
 * few cut-out rectangles for obvious non-French zones that fall inside
 * the bbox (e.g. the Channel, Belgium / Luxembourg, Italian Riviera).
 *
 * This is intentionally tiny — when we want sub-km precision we can swap
 * to the full `france-border.json` polygon (1.6 MB) and use a proper
 * point-in-polygon implementation. For now we just want to refuse the
 * obvious "Paris → Genève" cases that BRouter would happily route across
 * Switzerland.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

/** Rectangle expressed as [minLon, minLat, maxLon, maxLat]. */
type BBox = [number, number, number, number];

// Metropolitan France + Corsica.
const FRANCE_INCLUDE: BBox = [-5.5, 41.2, 9.8, 51.2];

// Obvious non-FR zones to carve out.
const FRANCE_EXCLUDE: BBox[] = [
  // Belgium / Luxembourg (rough)
  [2.3, 49.5, 6.5, 51.6],
  // Switzerland (rough)
  [5.95, 45.7, 10.6, 47.9],
  // North-west Italy + Riviera (rough)
  [6.6, 43.7, 10.5, 46.3],
  // Northern Spain & Andorra (rough)
  [-1.8, 41.0, 3.5, 42.85],
  // Channel Islands area (so Jersey / Guernsey aren't accepted)
  [-3.5, 49.0, -1.8, 50.0],
];

function inBBox(p: LatLon, b: BBox): boolean {
  return p.lon >= b[0] && p.lon <= b[2] && p.lat >= b[1] && p.lat <= b[3];
}

/** Returns true when the point is plausibly inside France. */
export function isInFrance(p: LatLon): boolean {
  if (!inBBox(p, FRANCE_INCLUDE)) return false;
  for (const ex of FRANCE_EXCLUDE) {
    if (inBBox(p, ex)) return false;
  }
  return true;
}

export interface FranceBoundsCheck {
  ok: boolean;
  /** Human-readable message when `ok === false`. */
  reason?: string;
}

export function checkRouteWithinFrance(points: LatLon[]): FranceBoundsCheck {
  for (const p of points) {
    if (!isInFrance(p)) {
      return {
        ok: false,
        reason:
          'Impossible de calculer l’itinéraire : les points doivent être situés en France métropolitaine ou en Corse.',
      };
    }
  }
  return { ok: true };
}
