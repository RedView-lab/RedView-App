import { createContext, useContext } from 'react';

import type { TimelineAddItemKind } from '@/features/itineraryPanel';

/** Point of the active itinerary's route under the chart click. */
export interface ChartPlacementTarget {
  lat: number;
  lon: number;
  /** Position along the itinerary's own route, from its start. */
  distanceM: number;
}

export interface ChartPlacementToolContextValue {
  /** Kind waiting for a click on the analysis chart, null when idle. */
  armedKind: TimelineAddItemKind | null;
  /** The active itinerary has a route to place points on. */
  canPlace: boolean;
  statusMessage: string | null;
  arm: (kind: TimelineAddItemKind) => void;
  deactivate: () => void;
  /** Adds the armed kind at `target` (one shot: the tool disarms). */
  placeAt: (target: ChartPlacementTarget) => void;
  /** Click outside the active itinerary's profile: the tool stays armed. */
  rejectOutsideRoute: () => void;
}

export const ChartPlacementToolContext = createContext<ChartPlacementToolContextValue | null>(null);

export function useChartPlacementToolOptional(): ChartPlacementToolContextValue | null {
  return useContext(ChartPlacementToolContext);
}
