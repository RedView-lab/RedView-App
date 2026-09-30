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
import { diffHistoryDocument, shareProjectStructure } from './historyDocument';
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
  // Source de vérité synchrone : chaque mise à jour part de l'état le plus
  // récent (et non du dernier rendu), de sorte que les résultats async, les
  // mutations historisées et l'undo/redo s'enchaînent sans s'écraser.
  const projectRef = useRef(project);

  const onProjectChangeRef = useRef(onProjectChange);
  onProjectChangeRef.current = onProjectChange;

  /** Publie un état déjà préparé (normalisé + partagé) et le persiste. */
  const commitProject = useCallback((next: ItineraryProject) => {
    projectRef.current = next;
    setProjectInternal(next);
    try {
      onProjectChangeRef.current?.(next);
    } catch (err) {
      console.error('[ProjectProvider] onProjectChange threw', err);
    }
  }, []);

  /**
   * Normalise puis partage la structure avec l'état courant : tout ce qui n'a
   * pas changé garde sa référence (et ses rendus en cache).
   */
  const prepareProject = useCallback(
    (prev: ItineraryProject, next: ItineraryProject, alreadyNormalized = false) =>
      shareProjectStructure(prev, alreadyNormalized ? next : normalizeItineraryProject(next)),
    [],
  );

  /**
   * Écriture brute : aucun historique. `alreadyNormalized` pour un état
   * restauré depuis l'historique : le renormaliser recréerait ses objets et
   * perdrait les rendus en cache.
   */
  const writeProject = useCallback((next: ItineraryProject, alreadyNormalized = false) => {
    const prev = projectRef.current;
    const prepared = prepareProject(prev, next, alreadyNormalized);
    if (prepared !== prev) commitProject(prepared);
  }, [commitProject, prepareProject]);

  const {
    canUndoTraceEdit,
    canRedoTraceEdit,
    historyRevision,
    recordChange,
    undoTraceEdit,
    redoTraceEdit,
    rollbackPendingTraceAppend,
    pushTraceHistoryEntry,
    pushTraceHistoryEntries,
    commitTraceMutation,
  } = useTraceHistory({ projectRef, writeProject });

  /**
   * Canal utilisateur (par défaut) : toute modification du document
   * (itinéraires) devient une étape d'undo, regroupée par rafale. Les
   * changements d'affichage seuls (panneaux, graphe, carte, sélection) ne sont
   * pas enregistrés.
   */
  const setProject = useCallback<Dispatch<SetStateAction<ItineraryProject>>>(
    (action) => {
      const prev = projectRef.current;
      const next =
        typeof action === 'function'
          ? (action as (p: ItineraryProject) => ItineraryProject)(prev)
          : action;
      if (next === prev) return;
      // Comparaison sur l'état préparé : ni la normalisation ni une recopie à
      // l'identique ne doivent passer pour une modification de l'utilisateur.
      const prepared = prepareProject(prev, next);
      if (prepared === prev) return;
      const change = diffHistoryDocument(prev, prepared);
      if (change) {
        recordChange(prev, { itineraryId: change.itineraryId, coalesceKey: change.signature });
      }
      commitProject(prepared);
    },
    [commitProject, prepareProject, recordChange],
  );

  /**
   * Canal arrière-plan : résultats async dérivés d'une action déjà enregistrée
   * (tracé BRouter, altimétrie, revêtements, toponymes, POI du couloir,
   * prédiction). Hors historique, et ne vide donc jamais « Rétablir ».
   */
  const setProjectWithoutHistory = useCallback<Dispatch<SetStateAction<ItineraryProject>>>(
    (action) => {
      const prev = projectRef.current;
      const next =
        typeof action === 'function'
          ? (action as (p: ItineraryProject) => ItineraryProject)(prev)
          : action;
      if (next === prev) return;
      writeProject(next);
    },
    [writeProject],
  );

  const {
    updateItinerary,
    updateItineraryWithoutHistory,
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
  } = useItineraryCrudActions({ setProject, setProjectWithoutHistory, commitTraceMutation });

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
    updateItinerary,
    pushTraceHistoryEntry,
    pushTraceHistoryEntries,
  });

  const value = useMemo<ProjectStoreValue>(
    () => ({
      project,
      setProject,
      setProjectWithoutHistory,
      undoTraceEdit,
      redoTraceEdit,
      canUndoTraceEdit,
      canRedoTraceEdit,
      historyRevision,
      commitTraceMutation,
      rollbackPendingTraceAppend,
      addItinerary,
      updateItinerary,
      updateItineraryWithoutHistory,
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
      commitTraceMutation,
      duplicateItinerary,
      historyRevision,
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
      setProjectWithoutHistory,
      simplifyItineraryGpx,
      splitItineraryAtPointIndex,
      undoTraceEdit,
      updateItinerary,
      updateItineraryRoutePoints,
      updateItineraryWithoutHistory,
    ],
  );

  return (
    <ProjectStoreContext.Provider value={value}>
      {children}
    </ProjectStoreContext.Provider>
  );
}