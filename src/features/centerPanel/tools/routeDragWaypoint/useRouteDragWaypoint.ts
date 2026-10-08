import { createContext } from 'react';

export interface RouteDragWaypointContextValue {
  /** Vrai pendant qu'un point du tracé est en train d'être glissé. */
  dragging: boolean;
}

export const RouteDragWaypointContext = createContext<RouteDragWaypointContextValue | null>(null);

