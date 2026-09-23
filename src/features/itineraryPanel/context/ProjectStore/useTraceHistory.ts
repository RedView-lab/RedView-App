import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';

import type { ItineraryProject } from '../../types';
import type { TraceHistoryEntry } from './types';

interface UseTraceHistoryArgs {
  projectRef: MutableRefObject<ItineraryProject>;
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
}

export function useTraceHistory({ projectRef, setProject }: UseTraceHistoryArgs) {
  const [traceHistoryPast, setTraceHistoryPast] = useState<TraceHistoryEntry[]>([]);
  const [traceHistoryFuture, setTraceHistoryFuture] = useState<TraceHistoryEntry[]>([]);
  const traceHistoryPastRef = useRef<TraceHistoryEntry[]>([]);
  const traceHistoryFutureRef = useRef<TraceHistoryEntry[]>([]);
  const pendingTraceAppendRef = useRef<TraceHistoryEntry | null>(null);

  const syncTraceHistory = useCallback((past: TraceHistoryEntry[], future: TraceHistoryEntry[]) => {
    traceHistoryPastRef.current = past;
    traceHistoryFutureRef.current = future;
    setTraceHistoryPast(past);
    setTraceHistoryFuture(future);
  }, []);

  const pushTraceHistoryEntry = useCallback(
    (
      entry: TraceHistoryEntry,
      options?: { preservePendingTraceAppend?: boolean },
    ) => {
      if (!options?.preservePendingTraceAppend) {
        pendingTraceAppendRef.current = null;
      }
      syncTraceHistory([...traceHistoryPastRef.current, entry], []);
      setProject(entry.after);
    },
    [setProject, syncTraceHistory],
  );

  const pushTraceHistoryEntries = useCallback(
    (
      entries: TraceHistoryEntry[],
      options?: { preservePendingTraceAppend?: boolean },
    ) => {
      if (entries.length === 0) return;
      if (!options?.preservePendingTraceAppend) {
        pendingTraceAppendRef.current = null;
      }
      syncTraceHistory([...traceHistoryPastRef.current, ...entries], []);
      setProject(entries[entries.length - 1].after);
    },
    [setProject, syncTraceHistory],
  );

  /**
   * Applique une mutation au projet courant en l'enregistrant dans l'historique
   * undo/redo, au même titre qu'une édition de trace.
   *
   * Le mutateur reçoit un clone profond du projet : il le modifie librement.
   * S'il retourne `false`, la mutation est considérée comme sans effet et
   * n'est pas enregistrée (pas de nouvelle entrée d'historique).
   */
  const commitTraceMutation = useCallback(
    (
      itineraryId: string,
      mutate: (draft: ItineraryProject) => boolean | void,
    ): boolean => {
      const before = projectRef.current;
      const after = structuredClone(before);
      if (mutate(after) === false) return false;

      pushTraceHistoryEntry({
        itineraryId,
        before: structuredClone(before),
        after,
      });
      return true;
    },
    [projectRef, pushTraceHistoryEntry],
  );

  const undoTraceEdit = useCallback(() => {
    const past = traceHistoryPastRef.current;
    const entry = past[past.length - 1];
    if (!entry) return;

    pendingTraceAppendRef.current = null;
    syncTraceHistory(past.slice(0, -1), [entry, ...traceHistoryFutureRef.current]);
    setProject(entry.before);
  }, [setProject, syncTraceHistory]);

  const redoTraceEdit = useCallback(() => {
    const future = traceHistoryFutureRef.current;
    const [entry, ...rest] = future;
    if (!entry) return;

    pendingTraceAppendRef.current = null;
    syncTraceHistory([...traceHistoryPastRef.current, entry], rest);
    setProject(entry.after);
  }, [setProject, syncTraceHistory]);

  const rollbackPendingTraceAppend = useCallback(
    (itineraryId: string) => {
      const pending = pendingTraceAppendRef.current;
      if (!pending || pending.itineraryId !== itineraryId) return false;

      pendingTraceAppendRef.current = null;
      const past = traceHistoryPastRef.current;
      const last = past[past.length - 1];
      const nextPast = last === pending ? past.slice(0, -1) : past;
      syncTraceHistory(nextPast, []);
      setProject(pending.before);
      return true;
    },
    [setProject, syncTraceHistory],
  );

  const setPendingTraceAppend = useCallback((entry: TraceHistoryEntry | null) => {
    pendingTraceAppendRef.current = entry;
  }, []);

  return {
    canUndoTraceEdit: traceHistoryPast.length > 0,
    canRedoTraceEdit: traceHistoryFuture.length > 0,
    traceHistoryPastCount: traceHistoryPast.length,
    traceHistoryFutureCount: traceHistoryFuture.length,
    pushTraceHistoryEntry,
    pushTraceHistoryEntries,
    commitTraceMutation,
    undoTraceEdit,
    redoTraceEdit,
    rollbackPendingTraceAppend,
    setPendingTraceAppend,
  };
}