/**
 * Boundary check — previously restricted routing strictly to France.
 * Now open to all destinations supported by BRouter across Europe.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

export interface FranceBoundsCheck {
  ok: boolean;
  reason?: string;
}

/** Routing boundary check — allows routing across Europe without restrictions. */
export function checkRouteWithinFrance(_points?: LatLon[]): FranceBoundsCheck {
  return { ok: true };
}
