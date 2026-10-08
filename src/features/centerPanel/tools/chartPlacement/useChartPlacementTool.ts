import { createContext, useContext } from 'react';

import type { TimelineAddItemKind } from '@/features/itineraryPanel';

/** Point du tracé de l'itinéraire actif sous le clic sur le graphique. */
export interface ChartPlacementTarget {
  lat: number;
  lon: number;
  /** Position le long du propre tracé de l'itinéraire, depuis son départ. */
  distanceM: number;
}

export interface ChartPlacementToolContextValue {
  /** Type en attente d'un clic sur le graphique d'analyse, null au repos. */
  armedKind: TimelineAddItemKind | null;
  /** L'itinéraire actif a un tracé sur lequel poser des points. */
  canPlace: boolean;
  statusMessage: string | null;
  arm: (kind: TimelineAddItemKind) => void;
  deactivate: () => void;
  /** Ajoute le type armé à `target` (une seule fois : l'outil se désarme). */
  placeAt: (target: ChartPlacementTarget) => void;
  /** Clic hors du profil de l'itinéraire actif : l'outil reste armé. */
  rejectOutsideRoute: () => void;
}

export const ChartPlacementToolContext = createContext<ChartPlacementToolContextValue | null>(null);

export function useChartPlacementToolOptional(): ChartPlacementToolContextValue | null {
  return useContext(ChartPlacementToolContext);
}
