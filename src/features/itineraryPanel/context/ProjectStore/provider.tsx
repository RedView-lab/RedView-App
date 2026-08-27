import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import {
  createDefaultProject,
  normalizeItineraryProject,
} from '../../lib/project';

import { ProjectStoreContext } from './context';
import { useTraceHistory } from './useTraceHistory';
import { useItineraryCrudActions } from './useItineraryCrudActions';
import { useItineraryGpxActions } from './useItineraryGpxActions';
import type { ItineraryProject } from '../../types';
import type {
  ProjectProviderProps,
  ProjectStoreValue,
} from './types';

/**
 * Fournisseur principal de l'état du projet (ProjectStore).
 * Gère l'historique d'annulation/rétablissement (Undo/Redo), les mutations d'itinéraires et le routage.
 */
export function ProjectProvider({
  initialProject,
  onProjectChange,
  children,
}: ProjectProviderProps) {
  const [project, setProjectInternal] = useState<ItineraryProject>(
    () => (initialProject ? normalizeItineraryProject(initialProject) : createDefaultProject()),
  );
  const projectRef = useRef(project);
  projectRef.current = project;

  const onProjectChangeRef = useRef(onProjectChange);
  onProjectChangeRef.current = onProjectChange;

  const setProject = useCallback<Dispatch<SetStateAction<ItineraryProject>>>(
    (action) => {
      setProjectInternal((prev) => {
        const next =
          typeof action === 'function'
            ? (action as (p: ItineraryProject) => ItineraryProject)(prev)
            : action;
        const normalizedNext = normalizeItineraryProject(next);
        if (normalizedNext === prev) return prev;
        try {
          onProjectChangeRef.current?.(normalizedNext);
        } catch (err) {
          console.error('[ProjectProvider] onProjectChange threw', err);
        }
        return normalizedNext;
      });
    },
    [],
  );

  const {
    canUndoTraceEdit,
    canRedoTraceEdit,
    undoTraceEdit,
    redoTraceEdit,
    rollbackPendingTraceAppend,
    setPendingTraceAppend,
    pushTraceHistoryEntry,
    pushTraceHistoryEntries,
  } = useTraceHistory({ setProject });

  const {
    updateItinerary,
    setItineraryName,
    setItineraryColor,
    setItineraryVisibility,
    setItineraryAnalysisVisibility,
    setItineraryRenderMode,
    setItineraryOpacity,
    addItinerary,
    duplicateItinerary,
    removeItinerary,
    clearItineraryRoute,
  } = useItineraryCrudActions({ setProject });

  const {
    reverseItineraryGpx,
    appendTracePoint,
    addForbiddenZone,
    removeForbiddenZone,
    simplifyItineraryGpx,
    changeItineraryGpxQuality,
    cleanItineraryGpxGlitches,
    mergeItineraries,
    splitItineraryAtPointIndex,
    updateItineraryRoutePoints,
  } = useItineraryGpxActions({
    projectRef,
    setProject,
    updateItinerary,
    pushTraceHistoryEntry,
    pushTraceHistoryEntries,
    setPendingTraceAppend,
  });

  const value = useMemo<ProjectStoreValue>(
    () => ({
      project,
      setProject,
      undoTraceEdit,
      redoTraceEdit,
      canUndoTraceEdit,
      canRedoTraceEdit,
      rollbackPendingTraceAppend,
      addItinerary,
      updateItinerary,
      setItineraryName,
      setItineraryColor,
      setItineraryVisibility,
      setItineraryAnalysisVisibility,
      setItineraryRenderMode,
      setItineraryOpacity,
      duplicateItinerary,
      removeItinerary,
      clearItineraryRoute,
      reverseItineraryGpx,
      appendTracePoint,
      addForbiddenZone,
      removeForbiddenZone,
      simplifyItineraryGpx,
      changeItineraryGpxQuality,
      cleanItineraryGpxGlitches,
      mergeItineraries,
      splitItineraryAtPointIndex,
      updateItineraryRoutePoints,
    }),
    [
      addForbiddenZone,
      addItinerary,
      canRedoTraceEdit,
      canUndoTraceEdit,
      changeItineraryGpxQuality,
      cleanItineraryGpxGlitches,
      clearItineraryRoute,
      duplicateItinerary,
      mergeItineraries,
      project,
      redoTraceEdit,
      removeForbiddenZone,
      removeItinerary,
      reverseItineraryGpx,
      rollbackPendingTraceAppend,
      appendTracePoint,
      setItineraryAnalysisVisibility,
      setItineraryColor,
      setItineraryName,
      setItineraryOpacity,
      setItineraryRenderMode,
      setItineraryVisibility,
      setProject,
      simplifyItineraryGpx,
      splitItineraryAtPointIndex,
      undoTraceEdit,
      updateItinerary,
      updateItineraryRoutePoints,
    ],
  );

  return (
    <ProjectStoreContext.Provider value={value}>
      {children}
    </ProjectStoreContext.Provider>
  );
}