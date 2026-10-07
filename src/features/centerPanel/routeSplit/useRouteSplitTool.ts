import { createContext, useContext } from 'react';

export interface RouteSplitToolContextValue {
  armed: boolean;
  canSplit: boolean;
  statusMessage: string | null;
  toggle: () => void;
  deactivate: () => void;
  splitAtPointIndex: (splitIndex: number) => boolean;
}

export const RouteSplitToolContext = createContext<RouteSplitToolContextValue | null>(null);

export function useRouteSplitToolOptional(): RouteSplitToolContextValue | null {
  return useContext(RouteSplitToolContext);
}
