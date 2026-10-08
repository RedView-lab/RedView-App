/**
 * Test de frontière — limitait auparavant le routage strictement à la France.
 * Désormais ouvert à toutes les destinations que BRouter couvre en Europe.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

export interface FranceBoundsCheck {
  ok: boolean;
  reason?: string;
}

/** Test de frontière du routage — autorise le routage dans toute l'Europe sans restriction. */
export function checkRouteWithinFrance(_points?: LatLon[]): FranceBoundsCheck {
  return { ok: true };
}
