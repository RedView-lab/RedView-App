import { useCallback, useRef, useState, type MutableRefObject } from 'react';

import type { ItineraryProject } from '../../types';
import { cloneProjectForMutation } from './historyClone';
import { restoreHistoryDocument } from './historyDocument';
import type { TraceHistoryEntry } from './types';

/** Nombre d'étapes conservées (états partagés structurellement, sans copie). */
const MAX_HISTORY_STEPS = 100;
/**
 * Fenêtre de regroupement : une rafale de modifications identiques (curseur
 * glissé, saisie, clics répétés sur le même réglage) forme une seule étape.
 */
const COALESCE_WINDOW_MS = 1000;

interface HistorySnapshot {
  /**
   * État du projet tel qu'il était affiché (mêmes objets, jamais mutés en
   * place) : les rendus dérivés, mis en cache par référence, restent valides.
   */
  project: ItineraryProject;
  /** Itinéraire concerné par l'étape, rendu actif à la restauration. */
  itineraryId: string;
}

export interface RecordChangeOptions {
  itineraryId: string;
  /** Même clé dans la fenêtre de regroupement → même étape. */
  coalesceKey?: string | null;
}

interface UseTraceHistoryArgs {
  projectRef: MutableRefObject<ItineraryProject>;
  /** Écriture brute du projet, sans enregistrement dans l'historique. */
  writeProject: (next: ItineraryProject, alreadyNormalized?: boolean) => void;
}

/**
 * Historique undo/redo du ProjectStore.
 *
 * Modèle : `past` contient l'état du document *avant* chaque étape, `future`
 * l'état *réel* capturé au moment de chaque annulation. Undo et redo échangent
 * donc l'état vivant (résultats async, import, réglages compris) avec
 * l'instantané : rétablir rend toujours exactement ce qui était affiché.
 *
 * Seul le document (itinéraires) est restauré : l'état d'affichage n'est
 * jamais remonté (cf. `historyDocument.ts`). Seule une nouvelle modification
 * utilisateur vide `future` ; les écritures en arrière-plan (routage,
 * altimétrie, POI, prédiction) passent hors historique et le préservent.
 */
export function useTraceHistory({ projectRef, writeProject }: UseTraceHistoryArgs) {
  const [pastCount, setPastCount] = useState(0);
  const [futureCount, setFutureCount] = useState(0);
  // Incrémenté à chaque restauration (undo / redo / rollback) : les traitements
  // async (routage BRouter, recalcul de trace, POI, prédiction) s'en servent
  // pour abandonner leurs requêtes en vol et accepter l'état restauré.
  const [historyRevision, setHistoryRevision] = useState(0);
  const pastRef = useRef<HistorySnapshot[]>([]);
  const futureRef = useRef<HistorySnapshot[]>([]);
  const lastCoalesceRef = useRef<{ key: string; at: number } | null>(null);
  const pendingTraceAppendRef = useRef<{
    itineraryId: string;
    snapshot: HistorySnapshot;
    extensionKey: string;
  } | null>(null);

  const syncCounts = useCallback(() => {
    setPastCount(pastRef.current.length);
    setFutureCount(futureRef.current.length);
  }, []);

  const pushSnapshot = useCallback((before: ItineraryProject, itineraryId: string) => {
    const snapshot: HistorySnapshot = { project: before, itineraryId };
    const past = [...pastRef.current, snapshot];
    pastRef.current = past.length > MAX_HISTORY_STEPS
      ? past.slice(past.length - MAX_HISTORY_STEPS)
      : past;
    futureRef.current = [];
    return snapshot;
  }, []);

  /**
   * Enregistre `before` comme étape (appelé par le store juste avant d'écrire
   * une modification utilisateur). Une rafale de même `coalesceKey` dans la
   * fenêtre de regroupement ne crée pas de nouvelle étape.
   */
  const recordChange = useCallback(
    (before: ItineraryProject, options: RecordChangeOptions) => {
      const now = Date.now();
      const key = options.coalesceKey ?? null;
      const last = lastCoalesceRef.current;
      if (
        key &&
        last &&
        last.key === key &&
        now - last.at < COALESCE_WINDOW_MS &&
        pastRef.current.length > 0 &&
        futureRef.current.length === 0
      ) {
        last.at = now;
        return;
      }
      pendingTraceAppendRef.current = null;
      pushSnapshot(before, options.itineraryId);
      lastCoalesceRef.current = key ? { key, at: now } : null;
      syncCounts();
    },
    [pushSnapshot, syncCounts],
  );

  const pushTraceHistoryEntry = useCallback(
    (
      entry: TraceHistoryEntry,
      options?: { pendingTraceAppend?: boolean },
    ) => {
      const snapshot = pushSnapshot(projectRef.current, entry.itineraryId);
      lastCoalesceRef.current = null;
      if (options?.pendingTraceAppend) {
        const itinerary = entry.after.itineraries.find((it) => it.id === entry.itineraryId);
        pendingTraceAppendRef.current = {
          itineraryId: entry.itineraryId,
          snapshot,
          extensionKey: JSON.stringify(itinerary?.pendingTraceExtension ?? null),
        };
      } else {
        pendingTraceAppendRef.current = null;
      }
      syncCounts();
      writeProject(entry.after);
    },
    [projectRef, pushSnapshot, syncCounts, writeProject],
  );

  /** Plusieurs étapes d'un coup (ex. zone interdite point par point). */
  const pushTraceHistoryEntries = useCallback(
    (entries: TraceHistoryEntry[]) => {
      if (entries.length === 0) return;
      pendingTraceAppendRef.current = null;
      lastCoalesceRef.current = null;
      pushSnapshot(projectRef.current, entries[0].itineraryId);
      for (let index = 1; index < entries.length; index += 1) {
        pushSnapshot(entries[index].before, entries[index].itineraryId);
      }
      syncCounts();
      writeProject(entries[entries.length - 1].after);
    },
    [projectRef, pushSnapshot, syncCounts, writeProject],
  );

  /**
   * Applique une mutation au projet courant en l'enregistrant comme une étape
   * à part entière (jamais regroupée).
   *
   * Le mutateur reçoit un clone profond du projet (hors tableaux de points du
   * tracé, partagés : cf. cloneProjectForMutation) : il le modifie librement.
   * S'il retourne `false`, la mutation est considérée comme sans effet et
   * n'est pas enregistrée (pas de nouvelle entrée d'historique).
   */
  const commitTraceMutation = useCallback(
    (
      itineraryId: string,
      mutate: (draft: ItineraryProject) => boolean | void,
    ): boolean => {
      const before = projectRef.current;
      const after = cloneProjectForMutation(before);
      if (mutate(after) === false) return false;
      pushTraceHistoryEntry({ itineraryId, before, after });
      return true;
    },
    [projectRef, pushTraceHistoryEntry],
  );

  const restore = useCallback(
    (snapshot: HistorySnapshot) => {
      pendingTraceAppendRef.current = null;
      lastCoalesceRef.current = null;
      syncCounts();
      setHistoryRevision((revision) => revision + 1);
      writeProject(
        restoreHistoryDocument(projectRef.current, snapshot.project, snapshot.itineraryId),
        true,
      );
    },
    [projectRef, syncCounts, writeProject],
  );

  const undoTraceEdit = useCallback(() => {
    const past = pastRef.current;
    const snapshot = past[past.length - 1];
    if (!snapshot) return;
    pastRef.current = past.slice(0, -1);
    futureRef.current = [
      { project: projectRef.current, itineraryId: snapshot.itineraryId },
      ...futureRef.current,
    ];
    restore(snapshot);
  }, [projectRef, restore]);

  const redoTraceEdit = useCallback(() => {
    const [snapshot, ...rest] = futureRef.current;
    if (!snapshot) return;
    futureRef.current = rest;
    pastRef.current = [
      ...pastRef.current,
      { project: projectRef.current, itineraryId: snapshot.itineraryId },
    ];
    restore(snapshot);
  }, [projectRef, restore]);

  /**
   * Annule un prolongement de trace que BRouter n'a pas pu router. Ne touche
   * qu'à l'itinéraire concerné, et seulement s'il porte encore ce prolongement :
   * tout autre changement survenu entre-temps est préservé.
   */
  const rollbackPendingTraceAppend = useCallback(
    (itineraryId: string) => {
      const pending = pendingTraceAppendRef.current;
      if (!pending || pending.itineraryId !== itineraryId) return false;
      pendingTraceAppendRef.current = null;

      const live = projectRef.current;
      const liveItinerary = live.itineraries.find((it) => it.id === itineraryId);
      const beforeItinerary = pending.snapshot.project.itineraries.find((it) => it.id === itineraryId);
      if (
        !liveItinerary ||
        !beforeItinerary ||
        JSON.stringify(liveItinerary.pendingTraceExtension ?? null) !== pending.extensionKey
      ) {
        return false;
      }

      const past = pastRef.current;
      if (past[past.length - 1] === pending.snapshot) {
        pastRef.current = past.slice(0, -1);
      }
      lastCoalesceRef.current = null;
      syncCounts();
      setHistoryRevision((revision) => revision + 1);
      writeProject({
        ...live,
        itineraries: live.itineraries.map((it) =>
          it.id === itineraryId
            ? { ...beforeItinerary, visible: it.visible, analysisVisible: it.analysisVisible }
            : it,
        ),
      }, true);
      return true;
    },
    [projectRef, syncCounts, writeProject],
  );

  return {
    canUndoTraceEdit: pastCount > 0,
    canRedoTraceEdit: futureCount > 0,
    historyRevision,
    recordChange,
    pushTraceHistoryEntry,
    pushTraceHistoryEntries,
    commitTraceMutation,
    undoTraceEdit,
    redoTraceEdit,
    rollbackPendingTraceAppend,
  };
}
