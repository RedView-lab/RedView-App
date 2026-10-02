import type { Map as MapboxMap } from 'mapbox-gl';
import type { MapOverlayInsets } from '../components/panelPlacement';

/**
 * Bords de la carte couverts par l'interface (panneaux latéraux, barre + panneau
 * central du bas), publiés par `MapView` et lus par tout ce qui s'affiche dans
 * la carte (popups Mapbox) : une fiche ne doit jamais passer sous un panneau.
 */
const ZERO_INSETS: MapOverlayInsets = { top: 0, right: 0, bottom: 0, left: 0 };

const insetsByMap = new WeakMap<MapboxMap, MapOverlayInsets>();
const listenersByMap = new WeakMap<MapboxMap, Set<() => void>>();

function sanitize(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value as number) : 0;
}

export function setMapOverlayInsets(map: MapboxMap, insets: MapOverlayInsets | null | undefined): void {
  const next: MapOverlayInsets = {
    top: sanitize(insets?.top),
    right: sanitize(insets?.right),
    bottom: sanitize(insets?.bottom),
    left: sanitize(insets?.left),
  };
  const current = insetsByMap.get(map) ?? ZERO_INSETS;
  if (
    current.top === next.top
    && current.right === next.right
    && current.bottom === next.bottom
    && current.left === next.left
  ) {
    return;
  }
  insetsByMap.set(map, next);
  listenersByMap.get(map)?.forEach((listener) => listener());
}

export function getMapOverlayInsets(map: MapboxMap): MapOverlayInsets {
  return insetsByMap.get(map) ?? ZERO_INSETS;
}

/** Appelé à chaque changement des bords couverts (ouverture / redimensionnement d'un panneau). */
export function subscribeMapOverlayInsets(map: MapboxMap, listener: () => void): () => void {
  let listeners = listenersByMap.get(map);
  if (!listeners) {
    listeners = new Set();
    listenersByMap.set(map, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
