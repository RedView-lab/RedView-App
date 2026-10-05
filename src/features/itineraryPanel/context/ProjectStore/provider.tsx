import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import {
  composeProject,
  extractProjectLocalWork,
  extractProjectView,
  toProjectDocument,
  type ProjectDocument,
} from '../../lib/project/layers';

import {
  SESSION_PENDING_COMPUTE_GATE,
  SOLO_COMPUTE_GATE,
  type CollabChangeCause,
  type CollabLocalChange,
  type PreSessionChange,
  type ProjectCollabLink,
} from './collab';
import { ProjectStoreContext } from './context';
import { diffHistoryDocument, shareProjectStructure } from './historyDocument';
import { useTraceHistory, type HistoryWriteSource } from './useTraceHistory';
import { useItineraryCrudActions } from './useItineraryCrudActions';
import { useItineraryGpxActions } from './useItineraryGpxActions';
import type { ItineraryProject } from '../../types';
import type {
  ProjectProviderProps,
  ProjectStoreValue,
} from './types';

/** Origine d'une écriture du projet. */
type CommitSource = CollabLocalChange | 'restore' | 'remote';

/** Au-delà, les écritures d'avant la session sont fusionnées (module de session jamais chargé). */
const MAX_PRE_SESSION_CHANGES = 200;

/**
 * Annuler/rétablir dans une session : l'itinéraire qui réapparaît (ajout ou
 * suppression annulés) devient actif et visible, comme hors session.
 */
function focusReappearingItinerary(current: ItineraryProject, next: ItineraryProject): ItineraryProject {
  const known = new Set(current.itineraries.map((itinerary) => itinerary.id));
  const reappearing = next.itineraries.find((itinerary) => !known.has(itinerary.id));
  if (!reappearing) return next;
  return {
    ...next,
    activeItineraryId: reappearing.id,
    itineraries: next.itineraries.map((itinerary) =>
      itinerary.id === reappearing.id ? { ...itinerary, visible: true, analysisVisible: true } : itinerary,
    ),
  };
}

/**
 * Fournisseur principal de l'état du projet (ProjectStore).
 * Gère l'historique d'annulation/rétablissement (Undo/Redo), les mutations d'itinéraires et le routage.
 *
 * Avec une session de co-édition (`collab`), chaque document produit ici lui
 * est envoyé, ceux des autres éditeurs sont appliqués (recomposés avec la vue
 * et le travail local de cet appareil), et annuler/rétablir passent par elle.
 * Tant que la session se prépare (`collabPending`), les écritures sont notées
 * puis rejouées dans la session à son branchement (`bind`) : rien de ce qui
 * est fait pendant la connexion n'est perdu.
 */
export function ProjectProvider({
  initialProject,
  onProjectChange,
  collab = null,
  collabPending = false,
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
  // Lu par les écritures (événements, résultats async) : à jour avant elles.
  const collabRef = useRef(collab);
  useEffect(() => {
    collabRef.current = collab;
  }, [collab]);
  /**
   * Session attendue (lien pas encore branché) : les écritures sont notées
   * pour elle. Juste dès le premier rendu, puis tenu à jour avant tout effet
   * passif (résultats async, événements).
   */
  const collabExpectedRef = useRef(collab !== null || collabPending);
  useLayoutEffect(() => {
    collabExpectedRef.current = collab !== null || collabPending;
  }, [collab, collabPending]);
  /** Lien branché (`bind` fait) : les écritures lui sont envoyées. */
  const boundLinkRef = useRef<ProjectCollabLink | null>(null);
  /** Écritures faites avant le branchement, et le document d'où elles partent. */
  const preSessionRef = useRef<{ base: ProjectDocument; changes: PreSessionChange[] } | null>(null);

  /** Publie un état déjà préparé (normalisé + partagé) et le persiste. */
  const commitProject = useCallback((next: ItineraryProject, source: CommitSource) => {
    const prev = projectRef.current;
    projectRef.current = next;
    setProjectInternal(next);
    try {
      onProjectChangeRef.current?.(next);
    } catch (err) {
      console.error('[ProjectProvider] onProjectChange threw', err);
    }
    if (source === 'remote') return;
    const link = boundLinkRef.current;
    if (link) {
      // En session, annuler/rétablir passent par elle : jamais de 'restore' ici.
      if (source === 'restore') return;
      try {
        link.pushLocalDocument(toProjectDocument(next), source);
      } catch (err) {
        console.error('[ProjectProvider] collab push failed', err);
      }
      return;
    }
    if (!collabExpectedRef.current) return;
    // Session en préparation : écriture notée, rejouée au branchement. Une
    // rafale du même type n'en garde que le dernier document (même différence).
    const change: CollabLocalChange = source === 'restore' ? 'step' : source;
    const pre = preSessionRef.current ?? { base: toProjectDocument(prev), changes: [] };
    preSessionRef.current = pre;
    const document = toProjectDocument(next);
    const last = pre.changes[pre.changes.length - 1];
    if (last && last.change === change) {
      last.document = document;
    } else if (last && pre.changes.length >= MAX_PRE_SESSION_CHANGES) {
      // Session jamais prête : fusionnées, envoyées si l'une vient de l'utilisateur.
      last.document = document;
      if (change !== 'background') last.change = change;
    } else {
      pre.changes.push({ document, change });
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
  const writeProject = useCallback(
    (next: ItineraryProject, alreadyNormalized: boolean, source: HistoryWriteSource | 'remote') => {
      const prev = projectRef.current;
      const prepared = prepareProject(prev, next, alreadyNormalized);
      if (prepared === prev) return false;
      commitProject(prepared, source);
      return true;
    },
    [commitProject, prepareProject],
  );

  // Session attendue ou ouverte : son historique (par éditeur) remplace celui-ci.
  const isRecordingHistory = useCallback(() => !collabExpectedRef.current, []);

  const {
    canUndoTraceEdit,
    canRedoTraceEdit,
    historyRevision: traceHistoryRevision,
    resetHistory,
    recordChange,
    undoTraceEdit,
    redoTraceEdit,
    rollbackPendingTraceAppend,
    pushTraceHistoryEntry,
    pushTraceHistoryEntries,
    commitTraceMutation,
  } = useTraceHistory({ projectRef, writeProject, isRecording: isRecordingHistory });

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
      if (isRecordingHistory()) {
        const change = diffHistoryDocument(prev, prepared);
        if (change) {
          recordChange(prev, { itineraryId: change.itineraryId, coalesceKey: change.signature });
        }
      }
      commitProject(prepared, 'user');
    },
    [commitProject, isRecordingHistory, prepareProject, recordChange],
  );

  /**
   * Canal arrière-plan : résultats async dérivés d'une action déjà enregistrée
   * (tracé BRouter, altimétrie, revêtements, toponymes, POI du couloir,
   * prédiction). Hors historique, et ne vide donc jamais « Rétablir » ; dans
   * une session, rattaché à l'étape de l'action qui l'a provoqué.
   */
  const setProjectWithoutHistory = useCallback<Dispatch<SetStateAction<ItineraryProject>>>(
    (action) => {
      const prev = projectRef.current;
      const next =
        typeof action === 'function'
          ? (action as (p: ItineraryProject) => ItineraryProject)(prev)
          : action;
      if (next === prev) return;
      writeProject(next, false, 'background');
    },
    [writeProject],
  );

  // ── Session de co-édition ────────────────────────────────────────────────
  /** Modifications d'autres éditeurs appliquées (les traitements async vérifient l'état). */
  const [externalRevision, setExternalRevision] = useState(0);
  /** Annuler / rétablir de la session (même rôle que `historyRevision`). */
  const [collabHistoryRevision, setCollabHistoryRevision] = useState(0);
  const [collabHistory, setCollabHistory] = useState({ canUndo: false, canRedo: false });

  /** Document venu de la session : recomposé avec la vue et le travail de cet appareil. */
  const applyCollabDocument = useCallback(
    (document: ProjectDocument, cause: CollabChangeCause) => {
      const current = projectRef.current;
      let next = composeProject(document, extractProjectView(current), extractProjectLocalWork(current));
      if (cause !== 'remote') next = focusReappearingItinerary(current, next);
      return writeProject(next, false, 'remote');
    },
    [writeProject],
  );

  useEffect(() => {
    if (!collab) return;
    resetHistory();
    const apply = (document: ProjectDocument, cause: CollabChangeCause) => {
      const changed = applyCollabDocument(document, cause);
      if (cause === 'remote') {
        if (changed) setExternalRevision((revision) => revision + 1);
      } else {
        setCollabHistoryRevision((revision) => revision + 1);
      }
    };
    const syncHistory = () => setCollabHistory({ canUndo: collab.canUndo(), canRedo: collab.canRedo() });
    // Branchement : le document d'avant la session et les écritures faites
    // depuis y sont rejoués ; on affiche ensuite celui de la session (état
    // provisoire avec ces écritures, ou déjà celui du serveur).
    const pre = preSessionRef.current;
    preSessionRef.current = null;
    const document = collab.bind(pre?.base ?? toProjectDocument(projectRef.current), pre?.changes ?? []);
    boundLinkRef.current = collab;
    apply(document, 'remote');
    syncHistory();
    const unsubscribeDocument = collab.subscribe(apply);
    const unsubscribeHistory = collab.subscribeHistory(syncHistory);
    return () => {
      boundLinkRef.current = null;
      unsubscribeDocument();
      unsubscribeHistory();
      setCollabHistory({ canUndo: false, canRedo: false });
    };
  }, [applyCollabDocument, collab, resetHistory]);

  const undo = useCallback(() => {
    if (collabRef.current) collabRef.current.undo();
    else undoTraceEdit();
  }, [undoTraceEdit]);
  const redo = useCallback(() => {
    if (collabRef.current) collabRef.current.redo();
    else redoTraceEdit();
  }, [redoTraceEdit]);
  const canUndo = collab ? collabHistory.canUndo : canUndoTraceEdit;
  const canRedo = collab ? collabHistory.canRedo : canRedoTraceEdit;
  const historyRevision = traceHistoryRevision + collabHistoryRevision;
  // Session en préparation : rien n'est calculé sur le document d'ouverture
  // (peut-être en retard sur la session) ; la porte de la session prend le relais.
  const derivedComputeGate = collab?.computeGate ?? (collabPending ? SESSION_PENDING_COMPUTE_GATE : SOLO_COMPUTE_GATE);

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
      undoTraceEdit: undo,
      redoTraceEdit: redo,
      canUndoTraceEdit: canUndo,
      canRedoTraceEdit: canRedo,
      historyRevision,
      externalRevision,
      derivedComputeGate,
      collabActive: collab !== null,
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
      cleanItineraryGpxGlitches,
      mergeItineraries,
      splitItineraryAtPointIndex,
      updateItineraryRoutePoints,
    }),
    [
      addForbiddenZone,
      addItinerary,
      canRedo,
      canUndo,
      cleanItineraryGpxGlitches,
      clearItineraryRoute,
      collab,
      commitTraceMutation,
      derivedComputeGate,
      duplicateItinerary,
      externalRevision,
      historyRevision,
      mergeItineraries,
      project,
      redo,
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
      splitItineraryAtPointIndex,
      undo,
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
