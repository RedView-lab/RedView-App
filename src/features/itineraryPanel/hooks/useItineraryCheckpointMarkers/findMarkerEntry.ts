import type { MarkerRegistryEntry, OpenCheckpointMarker } from './types';

/**
 * Entrée du registre visée par une ouverture depuis la feuille de route ou le
 * graphe : clé d'itinéraire pour départ / arrivée, puis id de ligne (dans
 * l'itinéraire, puis partout), enfin le marqueur le plus proche des coordonnées.
 */
export function findCheckpointMarkerEntry(
  registry: Map<string, MarkerRegistryEntry>,
  checkpointId: string,
  coords?: { lat: number; lon: number },
  scope?: Parameters<OpenCheckpointMarker>[2],
): MarkerRegistryEntry | null {
  const idStr = String(checkpointId);
  const cleanId = idStr.replace(/^.*::/, '');
  const itineraryId = scope?.itineraryId ?? null;
  let targetEntry: MarkerRegistryEntry | null = null;

  // Départ / arrivée : une seule clé par itinéraire, quel que soit l'id de ligne.
  if (itineraryId && (scope?.kind === 'start' || scope?.kind === 'end')) {
    targetEntry = registry.get(`${itineraryId}:${scope.kind}`) ?? null;
  }

  const matchesId = (key: string) =>
    key === idStr ||
    key === cleanId ||
    key.endsWith(`:${idStr}`) ||
    key.endsWith(`:${cleanId}`);

  if (!targetEntry && itineraryId) {
    for (const [key, entry] of registry.entries()) {
      if (key.startsWith(`${itineraryId}:`) && matchesId(key)) {
        targetEntry = entry;
        break;
      }
    }
  }

  if (!targetEntry) {
    for (const [key, entry] of registry.entries()) {
      if (matchesId(key)) {
        targetEntry = entry;
        break;
      }
    }
  }

  if (!targetEntry && coords) {
    let closestEntry: MarkerRegistryEntry | null = null;
    let minDistanceSq = Infinity;
    for (const entry of registry.values()) {
      const lngLat = entry.marker.getLngLat();
      const dLat = lngLat.lat - coords.lat;
      const dLon = lngLat.lng - coords.lon;
      const distSq = dLat * dLat + dLon * dLon;
      if (distSq < 0.001 * 0.001 && distSq < minDistanceSq) {
        minDistanceSq = distSq;
        closestEntry = entry;
      }
    }
    targetEntry = closestEntry;
  }


  return targetEntry;
}
