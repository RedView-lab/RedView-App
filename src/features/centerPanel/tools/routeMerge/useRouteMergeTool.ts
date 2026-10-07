import { createContext, useContext } from 'react';

export interface RouteMergeToolContextValue {
  armed: boolean;
  canMerge: boolean;
  isMerging: boolean;
  statusMessage: string | null;
  toggle: () => void;
  deactivate: () => void;
  selectItinerary: (id: string) => void;
  canSelectItinerary: (id: string) => boolean;
  getSelectionOrder: (id: string) => number | null;
}

export const RouteMergeToolContext = createContext<RouteMergeToolContextValue | null>(null);

export function useRouteMergeToolOptional(): RouteMergeToolContextValue | null {
  return useContext(RouteMergeToolContext);
}
