/**
 * Entrées de routage d'un itinéraire et estampille de son tracé, sans
 * dépendance lourde : lues aussi par la normalisation du projet.
 */
import type { Itinerary } from '../../types';
import { canonicalJson } from '../../lib/project/canonicalJson';
import { normalizeDiscipline } from '@/shared/lib/discipline';

/**
 * Entrées « géométriques » du routage d'un itinéraire : départ, arrivée et via
 * hors-trace, au format attendu par l'effet de routage.
 */
export interface RoutingEndpointsKey {
  startKey: string;
  endKey: string;
  viaKey: string;
}

interface LatLon {
  lat: number;
  lon: number;
}

export interface RoutingEndpoints {
  start: LatLon | null;
  end: LatLon | null;
  via: LatLon[];
}

/**
 * Points routés d'un itinéraire. Sans arrivée posée, le dernier point de
 * passage hors-trace sert d'arrivée : le tracé suit chaque étape ajoutée
 * sans attendre l'arrivée.
 */
export function getRoutingEndpoints(
  itinerary: Itinerary | null | undefined,
): RoutingEndpoints {
  if (!itinerary) return { start: null, end: null, via: [] };
  const toLatLon = (item: Itinerary['timeline'][number] | undefined): LatLon | null =>
    item && item.lat != null && item.lon != null ? { lat: item.lat, lon: item.lon } : null;
  const via = itinerary.timeline
    .filter((item) => item.kind === 'waypoint' && !item.onRoute)
    .map(toLatLon)
    .filter((point): point is LatLon => point !== null);
  const end = toLatLon(itinerary.timeline.find((item) => item.kind === 'end')) ?? via.pop() ?? null;
  return {
    start: toLatLon(itinerary.timeline.find((item) => item.kind === 'start')),
    end,
    via,
  };
}

export function getRoutingEndpointsKey(
  itinerary: Itinerary | null | undefined,
): RoutingEndpointsKey {
  const { start, end, via } = getRoutingEndpoints(itinerary);
  const key = (point: LatLon | null) => (point ? `${point.lon},${point.lat}` : '');
  return {
    startKey: key(start),
    endKey: key(end),
    viaKey: via.map(key).join('|'),
  };
}

/**
 * Signature de *toutes* les entrées qui déterminent un tracé BRouter (points,
 * profil, priorités, types de routes, mode expert, discipline, zones
 * interdites). Estampillée sur chaque tracé routé (`gpxRoute.routedInputsKey`)
 * et sur chaque requête : un résultat n'est appliqué que si l'itinéraire a
 * toujours ces entrées, et après un undo/redo un tracé dont l'estampille ne
 * correspond plus (figé en plein recalcul) est recalculé.
 */
export function getRoutingInputsSignature(itinerary: Itinerary): string {
  // JSON canonique (clés triées) : un itinéraire fusionné par la co-édition
  // n'a pas forcément ses clés dans le même ordre chez chaque éditeur.
  return canonicalJson(routingInputs(itinerary));
}

function routingInputs(itinerary: Itinerary): unknown[] {
  const { startKey, endKey, viaKey } = getRoutingEndpointsKey(itinerary);
  // `applyToAllItineraries` est un choix d'interface, sans effet sur le tracé.
  const roadTypes: Record<string, unknown> = { ...itinerary.roadTypes };
  delete roadTypes.applyToAllItineraries;
  return [
    startKey,
    endKey,
    viaKey,
    itinerary.profileId ?? '',
    normalizeDiscipline(itinerary.discipline),
    itinerary.priorities ?? null,
    roadTypes,
    itinerary.expertProfile ?? null,
    (itinerary.forbiddenZones ?? []).map((zone) => zone.points),
  ];
}

/**
 * Le tracé stocké a-t-il été routé pour les entrées actuelles de
 * l'itinéraire ? Accepte aussi les estampilles écrites avant le JSON
 * canonique (ordre des clés d'origine) : un ancien tracé à jour le reste.
 */
export function routeStampMatches(itinerary: Itinerary, stamp: string | undefined): boolean {
  if (stamp === undefined) return false;
  return stamp === getRoutingInputsSignature(itinerary) || stamp === JSON.stringify(routingInputs(itinerary));
}
