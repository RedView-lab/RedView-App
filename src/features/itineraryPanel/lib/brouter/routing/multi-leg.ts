import { ROUTE_SEAM_TOLERANCE_M, RouteSeamError } from '../../routes/route-continuity';
import { haversineRouteDistanceM } from '../../routes/route-distance';
import type { BrouterPoint, BrouterRoute } from '../types';

/**
 * Nombre maximal de via par requête BRouter. Plafond historique de l'app
 * (calcul gardé court vis-à-vis du délai de 55 s du proxy /api/brouter) :
 * au-delà, le tracé est découpé en tronçons consécutifs au lieu de perdre
 * silencieusement les points suivants.
 */
export const MAX_BROUTER_VIA_PER_REQUEST = 14;

export interface BrouterLeg {
  start: BrouterPoint;
  via: BrouterPoint[];
  end: BrouterPoint;
}

/**
 * Découpe départ → via… → arrivée en tronçons consécutifs d'au plus
 * `maxVia` via chacun ; l'arrivée d'un tronçon est le départ du suivant.
 */
export function splitRouteIntoLegs(
  start: BrouterPoint,
  via: BrouterPoint[],
  end: BrouterPoint,
  maxVia: number = MAX_BROUTER_VIA_PER_REQUEST,
): BrouterLeg[] {
  if (via.length <= maxVia) return [{ start, via, end }];

  const anchors = [start, ...via, end];
  const legs: BrouterLeg[] = [];
  const step = Math.max(1, maxVia) + 1;
  for (let from = 0; from < anchors.length - 1; from += step) {
    const to = Math.min(anchors.length - 1, from + step);
    legs.push({
      start: anchors[from]!,
      via: anchors.slice(from + 1, to),
      end: anchors[to]!,
    });
  }
  return legs;
}

interface BrouterFeatureProps {
  messages?: unknown[][];
  [key: string]: unknown;
}

/**
 * Concatène les tracés de tronçons consécutifs en un seul tracé BRouter :
 * géométrie (point de jonction dédoublé), totaux, et lignes `messages`
 * (altitudes, distances, revêtements) réalignées sur l'en-tête du premier.
 * Deux tronçons qui ne partagent pas leur point de jonction (point d'un îlot
 * décalé différemment de chaque côté) rejettent `RouteSeamError` : les
 * recoller tracerait une ligne droite.
 */
export function concatBrouterRoutes(routes: BrouterRoute[]): BrouterRoute {
  if (routes.length === 0) throw new Error('BRouter: aucun tronçon à concaténer.');
  if (routes.length === 1) return routes[0]!;

  const coordinates: [number, number][] = [];
  let header: string[] | null = null;
  const messageRows: unknown[][] = [];

  for (const route of routes) {
    const previous = coordinates[coordinates.length - 1];
    const first = route.coordinates[0];
    if (previous && first) {
      const gapM = haversineRouteDistanceM(
        { lat: previous[1], lon: previous[0] },
        { lat: first[1], lon: first[0] },
      );
      if (gapM > ROUTE_SEAM_TOLERANCE_M) throw new RouteSeamError('route legs junction', gapM);
    }
    const startIndex = coordinates.length > 0 ? 1 : 0;
    for (let index = startIndex; index < route.coordinates.length; index += 1) {
      coordinates.push(route.coordinates[index]!);
    }

    const props = (route.raw.features?.[0]?.properties ?? {}) as BrouterFeatureProps;
    const messages = props.messages;
    if (!Array.isArray(messages) || messages.length < 2) continue;
    const legHeader = (messages[0] as unknown[]).map((cell) => String(cell));
    if (!header) {
      header = legHeader;
      for (let index = 1; index < messages.length; index += 1) messageRows.push(messages[index]!);
      continue;
    }
    const columnMap = header.map((name) => legHeader.indexOf(name));
    for (let index = 1; index < messages.length; index += 1) {
      const row = messages[index]!;
      messageRows.push(columnMap.map((column) => (column >= 0 ? row[column] : '')));
    }
  }

  const sum = (pick: (route: BrouterRoute) => number) =>
    routes.reduce((total, route) => total + (Number.isFinite(pick(route)) ? pick(route) : 0), 0);
  const distanceM = sum((route) => route.distanceM);
  const durationS = sum((route) => route.durationS);
  const ascentM = sum((route) => route.ascentM);
  const firstFeature = routes[0]!.raw.features?.[0];
  const firstProps: BrouterFeatureProps = { ...((firstFeature?.properties ?? {}) as BrouterFeatureProps) };
  // Totaux propres au 1er tronçon : recalculés ci-dessous ou retirés.
  delete firstProps['plain-ascend'];
  const legCosts = routes.map((route) => Number((route.raw.features?.[0]?.properties as BrouterFeatureProps | undefined)?.cost));
  if (legCosts.every(Number.isFinite)) firstProps.cost = String(legCosts.reduce((total, cost) => total + cost, 0));
  else delete firstProps.cost;

  return {
    coordinates,
    distanceM,
    durationS,
    ascentM,
    descentM: sum((route) => route.descentM),
    raw: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates },
          properties: {
            ...firstProps,
            'track-length': String(Math.round(distanceM)),
            'total-time': String(Math.round(durationS)),
            'filtered ascend': String(Math.round(ascentM)),
            ...(header ? { messages: [header, ...messageRows] } : {}),
          },
        },
      ],
    },
  };
}
