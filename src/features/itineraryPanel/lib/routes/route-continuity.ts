/**
 * Continuité des tracés : jamais de ligne droite entre deux morceaux recollés.
 *
 * Un tracé stocké est fait de morceaux routés (BRouter) ou importés (GPX)
 * recollés : patch local, extension, tronçons d'une requête découpée,
 * recalcul segment par segment, rognage. Chaque jonction doit relier deux
 * points quasi confondus : au-delà de `ROUTE_SEAM_TOLERANCE_M`, recoller
 * dessinerait une ligne droite hors route, reprise telle quelle par l'export
 * GPX. Le recollage échoue alors (`RouteSeamError`) et l'appelant recalcule
 * autrement au lieu de stocker la ligne droite.
 */
import { haversineRouteDistanceM, type RouteDistancePoint } from './route-distance';

/**
 * Écart maximal entre les deux points d'une jonction : bruit GPS d'un GPX
 * importé autour de la voie où BRouter accroche le même endroit. Un tracé
 * BRouter recollé à lui-même se rejoint au mètre près.
 */
export const ROUTE_SEAM_TOLERANCE_M = 25;

/**
 * Écart maximal entre un point hors réseau d'un tracé importé (GPX : parking,
 * chemin inconnu d'OSM) et l'endroit où BRouter l'accroche, quand un tronçon
 * routé doit en partir : au-delà, le relier serait inventer une ligne droite.
 */
export const ROUTE_SNAP_TOLERANCE_M = 200;

/** Recollage impossible sans ligne droite (écart à une jonction). */
export class RouteSeamError extends Error {
  readonly gapM: number;

  constructor(where: string, gapM: number) {
    super(`Route seam: ${where} would draw a ${Math.round(gapM)} m straight line`);
    this.name = 'RouteSeamError';
    this.gapM = gapM;
  }
}

export function isRouteSeamError(error: unknown): error is RouteSeamError {
  return error instanceof RouteSeamError;
}

/** Les deux points d'une jonction sont-ils assez proches pour être recollés ? */
export function routeSeamJoins(a: RouteDistancePoint, b: RouteDistancePoint): boolean {
  return haversineRouteDistanceM(a, b) <= ROUTE_SEAM_TOLERANCE_M;
}
