import { createContext, useContext } from 'react';

export interface RouteDragWaypointContextValue {
  /** True while a route point is actively being dragged. */
  dragging: boolean;
}

export const RouteDragWaypointContext = createContext<RouteDragWaypointContextValue | null>(null);

export function useRouteDragWaypointOptional(): RouteDragWaypointContextValue | null {
  return useContext(RouteDragWaypointContext);
}
