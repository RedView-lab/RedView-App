import { useCallback, useEffect, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { normalizeItineraryProject } from '@/features/itineraryPanel/lib/project';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { getProject } from '@/shared/utils/projects';
import { replaceProjectLocation } from '@/shared/utils/projectLocation';
import {
  readProjectCache,
  writeProjectCache,
} from './dashboardProjectCache';
import { useDashboardProjectSync } from './useDashboardProjectSync';

export type DashboardPersistedMutator = (
  dashboard: NonNullable<ItineraryProject['dashboard']>,
) => void;

interface UseDashboardProjectStateArgs {
  initialProjectId?: string | null;
  mapInstance: MapboxMap | null;
  beforeCloseProject?: () => Promise<void> | void;
}

/**
 * Hook gérant l'état, le chargement, la persistance locale et distante (Supabase)
 * ainsi que le cycle de vie du projet actif dans le Dashboard RedView.
 */
export function useDashboardProjectState({
  initialProjectId,
  mapInstance,
  beforeCloseProject,
}: UseDashboardProjectStateArgs) {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeProjectInitial, setActiveProjectInitial] = useState<ItineraryProject | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [isClosingProject, setIsClosingProject] = useState(false);
  const [projectBrowserOpen, setProjectBrowserOpen] = useState(true);

  const activeProjectSnapshotRef = useRef<ItineraryProject | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const isClosingProjectRef = useRef(false);
  const suppressedInitialProjectIdRef = useRef<string | null>(null);
  activeProjectIdRef.current = activeProjectId;

  const {
    flushSave,
    queueProjectSave,
    captureThumbnailForProject,
    resetSyncState,
  } = useDashboardProjectSync({
    mapInstance,
    activeProjectId,
    activeProjectIdRef,
    activeProjectSnapshotRef,
  });

  const openProject = useCallback(
    async (projectId: string, projectSnapshot?: ItineraryProject) => {
      setProjectLoading(true);
      try {
        if (projectSnapshot) {
          const normalized = normalizeItineraryProject(projectSnapshot);
          setActiveProjectId(projectId);
          setActiveProjectInitial(normalized);
          activeProjectSnapshotRef.current = normalized;
          resetSyncState(JSON.stringify(normalized));
          replaceProjectLocation({ id: projectId, name: normalized.name || 'project' });
          writeProjectCache(projectId, normalized);
          setProjectBrowserOpen(false);
          return;
        }

        const cached = readProjectCache(projectId);
        if (cached) {
          const normalized = normalizeItineraryProject(cached.project);
          setActiveProjectId(projectId);
          setActiveProjectInitial(normalized);
          activeProjectSnapshotRef.current = normalized;
          resetSyncState(JSON.stringify(normalized));
          replaceProjectLocation({ id: projectId, name: normalized.name || 'project' });
          setProjectBrowserOpen(false);
        }

        const projectRow = await getProject(projectId);
        if (projectRow?.data) {
          const normalized = normalizeItineraryProject(projectRow.data);
          setActiveProjectId(projectId);
          setActiveProjectInitial(normalized);
          activeProjectSnapshotRef.current = normalized;
          resetSyncState(JSON.stringify(normalized));
          replaceProjectLocation({ id: projectId, name: normalized.name || 'project' });
          writeProjectCache(projectId, normalized);
          setProjectBrowserOpen(false);
        }
      } catch (error) {
        console.error('[Dashboard] project loading failed', error);
      } finally {
        setProjectLoading(false);
      }
    },
    [resetSyncState],
  );

  const closeProject = useCallback(async () => {
    if (isClosingProjectRef.current) return;
    isClosingProjectRef.current = true;
    setIsClosingProject(true);

    try {
      const closingId = activeProjectIdRef.current;
      suppressedInitialProjectIdRef.current = closingId;

      if (beforeCloseProject) {
        try {
          await beforeCloseProject();
        } catch (error) {
          console.warn('[Dashboard] beforeCloseProject hook failed', error);
        }
      }

      if (closingId) {
        await captureThumbnailForProject(closingId);
      }

      await flushSave();
      resetSyncState(null);

      setActiveProjectId(null);
      setActiveProjectInitial(null);
      activeProjectSnapshotRef.current = null;
      replaceProjectLocation(null);
      setProjectBrowserOpen(true);
    } finally {
      isClosingProjectRef.current = false;
      setIsClosingProject(false);
    }
  }, [beforeCloseProject, captureThumbnailForProject, flushSave, resetSyncState]);

  const mutateActiveProjectDashboard = useCallback(
    (mutator: DashboardPersistedMutator) => {
      const current = activeProjectSnapshotRef.current;
      if (!current) return;

      const next = structuredClone(current);
      if (!next.dashboard) {
        next.dashboard = {};
      }
      mutator(next.dashboard);
      queueProjectSave(next);
    },
    [queueProjectSave],
  );

  useEffect(() => {
    if (!initialProjectId) return;
    if (suppressedInitialProjectIdRef.current === initialProjectId) return;
    if (activeProjectIdRef.current === initialProjectId) return;

    void openProject(initialProjectId);
  }, [initialProjectId, openProject]);

  return {
    activeProjectId,
    activeProjectInitial,
    projectLoading,
    isClosingProject,
    projectBrowserOpen,
    setProjectBrowserOpen,
    openProject,
    closeProject,
    queueProjectSave,
    mutateActiveProjectDashboard,
    handleOpenProject: openProject,
    handleBackToBrowser: closeProject,
    handleProjectChange: queueProjectSave,
    updatePersistedDashboard: mutateActiveProjectDashboard,
  };
}