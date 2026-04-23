import { useCallback, useEffect, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { getProject, saveProject, uploadProjectThumbnail } from '@/lib/projects';
import { replaceProjectLocation } from '@/lib/projectLocation';
import { captureMapThumbnail } from '@/lib/mapThumbnail';

export type DashboardPersistedMutator = (
  dashboard: NonNullable<ItineraryProject['dashboard']>,
) => void;

interface UseDashboardProjectStateArgs {
  initialProjectId?: string | null;
  mapInstance: MapboxMap | null;
}

export function useDashboardProjectState({
  initialProjectId,
  mapInstance,
}: UseDashboardProjectStateArgs) {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeProjectInitial, setActiveProjectInitial] =
    useState<ItineraryProject | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectBrowserOpen, setProjectBrowserOpen] = useState(true);

  const activeProjectSnapshotRef = useRef<ItineraryProject | null>(null);
  const pendingSaveRef = useRef<ItineraryProject | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  activeProjectIdRef.current = activeProjectId;

  const flushSave = useCallback(async () => {
    const id = activeProjectIdRef.current;
    const payload = pendingSaveRef.current;
    if (!id || !payload) return;

    pendingSaveRef.current = null;
    try {
      await saveProject(id, payload);
    } catch (error) {
      console.error('[Dashboard] autosave failed', error);
    }
  }, []);

  const queueProjectSave = useCallback(
    (next: ItineraryProject) => {
      activeProjectSnapshotRef.current = next;
      pendingSaveRef.current = next;

      const id = activeProjectIdRef.current;
      if (id) {
        replaceProjectLocation({ id, name: next.name || 'project' });
      }

      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void flushSave();
      }, 250);
    },
    [flushSave],
  );

  const handleProjectChange = useCallback(
    (next: ItineraryProject) => {
      queueProjectSave(next);
    },
    [queueProjectSave],
  );

  const updatePersistedDashboard = useCallback(
    (mutateDashboard: DashboardPersistedMutator) => {
      if (!activeProjectIdRef.current) return;

      const current = activeProjectSnapshotRef.current;
      if (!current) return;

      const next = structuredClone(current);
      const dashboard = structuredClone(
        (next.dashboard ?? {}) as NonNullable<ItineraryProject['dashboard']>,
      );
      mutateDashboard(dashboard);
      next.dashboard = dashboard;
      queueProjectSave(next);
    },
    [queueProjectSave],
  );

  const handleOpenProject = useCallback(async (projectId: string) => {
    setProjectLoading(true);
    try {
      const row = await getProject(projectId);
      if (!row) throw new Error('Project not found');

      activeProjectSnapshotRef.current = row.data;
      setActiveProjectId(row.id);
      setActiveProjectInitial(row.data);
      setProjectBrowserOpen(false);
      replaceProjectLocation({
        id: row.id,
        name: row.name || row.data.name || 'project',
      });
    } catch (error) {
      console.error('[Dashboard] failed to open project', error);
      if (activeProjectIdRef.current == null) {
        replaceProjectLocation(null);
      }
    } finally {
      setProjectLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initialProjectId || activeProjectId != null || projectLoading) return;
    void handleOpenProject(initialProjectId);
  }, [activeProjectId, handleOpenProject, initialProjectId, projectLoading]);

  useEffect(() => {
    const onPageHide = () => {
      void flushSave();
    };

    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);

    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);

      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        void flushSave();
      }
    };
  }, [flushSave]);

  const handleBackToBrowser = useCallback(async () => {
    await flushSave();

    const id = activeProjectIdRef.current;
    if (id) {
      try {
        const blob = await captureMapThumbnail(mapInstance);
        if (blob) {
          await uploadProjectThumbnail(id, blob);
        }
      } catch (error) {
        console.warn('[Dashboard] thumbnail upload failed', error);
      }
    }

    setProjectBrowserOpen(true);
    replaceProjectLocation(null);
  }, [flushSave, mapInstance]);

  return {
    activeProjectId,
    activeProjectInitial,
    projectLoading,
    projectBrowserOpen,
    setProjectBrowserOpen,
    handleOpenProject,
    handleBackToBrowser,
    handleProjectChange,
    updatePersistedDashboard,
  };
}