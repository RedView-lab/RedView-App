import { createContext, useContext } from 'react';

import type { TracePointDragCommit } from './useTracePointDrag';

export interface TraceToolContextValue {
  armed: boolean;
  canTrace: boolean;
  statusMessage: string | null;
  toggle: () => void;
  /**
   * Arme l'outil sans passer par `canTrace`.
   *
   * Utilisé juste après la création d'un itinéraire : dans ce gestionnaire,
   * `canTrace` est encore faux (il se réfère au rendu précédent) mais la mise à
   * jour du store et celle de `armed` sont batchées, donc le rendu suivant voit
   * déjà le nouvel itinéraire. Si l'armement s'avérait impossible, l'effet de
   * désarmement le corrige dans la foulée.
   */
  activate: () => void;
  deactivate: () => void;
  /**
   * Relâchement d'un point déplacé sur la carte (geste de `useTracePointDrag`,
   * outil armé ou non). `false` : rien d'enregistré.
   */
  commitPointDrag: (commit: TracePointDragCommit) => boolean;
  /** Curseur « grabbing » pendant le glisser d'un point. */
  onPointDraggingChange: (dragging: boolean) => void;
}

export const TraceToolContext = createContext<TraceToolContextValue | null>(null);

export function useTraceToolOptional(): TraceToolContextValue | null {
  return useContext(TraceToolContext);
}
