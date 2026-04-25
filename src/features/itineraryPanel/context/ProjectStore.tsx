import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

import { createDefaultItinerary, createDefaultProject } from '../defaultState';
import type { ItineraryProject, RouteRenderMode } from '../types';

interface ProjectStoreValue {
  project: ItineraryProject;
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
  /** Mutate a single itinerary by id (Immer-style draft mutation). */
  updateItinerary: (
    id: string,
    mut: (draft: ItineraryProject['itineraries'][number]) => void,
  ) => void;
  setItineraryName: (id: string, name: string) => void;
  setItineraryColor: (id: string, color: string) => void;
  setItineraryVisibility: (id: string, visible: boolean) => void;
  setItineraryAnalysisVisibility: (id: string, visible: boolean) => void;
  setItineraryRenderMode: (id: string, mode: RouteRenderMode) => void;
  setItineraryOpacity: (id: string, opacity: number) => void;
  clearItineraryRoute: (id: string) => void;
}

const ProjectStoreContext = createContext<ProjectStoreValue | null>(null);

interface ProjectProviderProps {
  initialProject?: ItineraryProject;
  /**
   * Notified after every project mutation. Used by the Dashboard to
   * persist changes to Supabase (debounced).
   */
  onProjectChange?: (project: ItineraryProject) => void;
  children: ReactNode;
}

/**
 * Single source of truth for the active project. Wraps the editor area
 * so that the left itinerary panel, the center summary table, and the
 * right control panel all read from / write to the same state.
 *
 * Remount with a new `key` (typically the project id) to seed a
 * different project — the provider snapshots `initialProject` once.
 */
export function ProjectProvider({
  initialProject,
  onProjectChange,
  children,
}: ProjectProviderProps) {
  const [project, setProjectInternal] = useState<ItineraryProject>(
    () => initialProject ?? createDefaultProject(),
  );

  // Notify the parent of every project mutation so it can persist to
  // Supabase. Using a ref + synchronous notification (inside the
  // updater) so that callers like `pagehide` listeners that mutate
  // state right before the page unloads still propagate the latest
  // snapshot — `useLayoutEffect` would not run in time.
  const onProjectChangeRef = useRef(onProjectChange);
  onProjectChangeRef.current = onProjectChange;

  const setProject = useCallback<Dispatch<SetStateAction<ItineraryProject>>>(
    (action) => {
      setProjectInternal((prev) => {
        const next =
          typeof action === 'function'
            ? (action as (p: ItineraryProject) => ItineraryProject)(prev)
            : action;
        if (next === prev) return prev;
        // Synchronously notify the parent so unload flushes capture
        // the freshest snapshot. Every real mutation must be persisted —
        // the previous "skip first change" guard caused the very first
        // user action after opening a project (e.g. a POI corridor
        // search) to be silently dropped if the user refreshed before
        // a second mutation triggered another save.
        try {
          onProjectChangeRef.current?.(next);
        } catch (err) {
          console.error('[ProjectProvider] onProjectChange threw', err);
        }
        return next;
      });
    },
    [],
  );

  const updateItinerary = useCallback(
    (
      id: string,
      mut: (draft: ItineraryProject['itineraries'][number]) => void,
    ) => {
      setProject((prev) => ({
        ...prev,
        itineraries: prev.itineraries.map((it) => {
          if (it.id !== id) return it;
          const copy = structuredClone(it);
          mut(copy);
          return copy;
        }),
      }));
    },
    [],
  );

  const setItineraryName = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      updateItinerary(id, (it) => {
        it.name = trimmed;
      });
    },
    [updateItinerary],
  );

  const setItineraryColor = useCallback(
    (id: string, color: string) => {
      updateItinerary(id, (it) => {
        it.color = color;
      });
    },
    [updateItinerary],
  );

  const setItineraryVisibility = useCallback(
    (id: string, visible: boolean) => {
      updateItinerary(id, (it) => {
        it.visible = visible;
      });
    },
    [updateItinerary],
  );

  const setItineraryAnalysisVisibility = useCallback(
    (id: string, visible: boolean) => {
      updateItinerary(id, (it) => {
        it.analysisVisible = visible;
      });
    },
    [updateItinerary],
  );

  const setItineraryRenderMode = useCallback(
    (id: string, mode: RouteRenderMode) => {
      updateItinerary(id, (it) => {
        it.renderMode = mode;
      });
    },
    [updateItinerary],
  );

  const setItineraryOpacity = useCallback(
    (id: string, opacity: number) => {
      updateItinerary(id, (it) => {
        it.opacity = Math.max(0, Math.min(100, Math.round(opacity)));
      });
    },
    [updateItinerary],
  );

  const clearItineraryRoute = useCallback(
    (id: string) => {
      updateItinerary(id, (it) => {
        const emptyTimeline = createDefaultItinerary(1, it.color).timeline;
        it.timeline = structuredClone(emptyTimeline);
        delete it.gpxRoute;
        delete it.metrics;
        delete it.poiFeatures;
        it.prediction = null;
      });
    },
    [updateItinerary],
  );

  const value = useMemo<ProjectStoreValue>(
    () => ({
      project,
      setProject,
      updateItinerary,
      setItineraryName,
      setItineraryColor,
      setItineraryVisibility,
      setItineraryAnalysisVisibility,
      setItineraryRenderMode,
      setItineraryOpacity,
      clearItineraryRoute,
    }),
    [
      project,
      updateItinerary,
      setItineraryName,
      setItineraryColor,
      setItineraryVisibility,
      setItineraryAnalysisVisibility,
      setItineraryRenderMode,
      setItineraryOpacity,
      clearItineraryRoute,
    ],
  );

  return (
    <ProjectStoreContext.Provider value={value}>
      {children}
    </ProjectStoreContext.Provider>
  );
}

/**
 * Read the active project + mutators from the surrounding
 * `<ProjectProvider>`. Throws when used outside the provider so
 * misuse is caught early in development.
 */
export function useProjectStore(): ProjectStoreValue {
  const ctx = useContext(ProjectStoreContext);
  if (!ctx) {
    throw new Error('useProjectStore must be used within <ProjectProvider>');
  }
  return ctx;
}

/**
 * Optional variant — returns null instead of throwing when no provider
 * is mounted. Useful for components rendered outside the editor (e.g.
 * the project browser overlay) that should silently no-op.
 */
export function useProjectStoreOptional(): ProjectStoreValue | null {
  return useContext(ProjectStoreContext);
}
