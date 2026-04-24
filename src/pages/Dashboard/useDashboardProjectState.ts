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

  /**
   * Best-effort synchronous save during `pagehide` / `beforeunload`.
   *
   * Supabase JS uses regular `fetch`, which the browser cancels the
   * moment the document starts unloading — meaning the autosave timer
   * silently loses any in-flight changes. We bypass the client and POST
   * directly to PostgREST with `keepalive: true`, which the browser
   * guarantees to dispatch even if the page is closing.
   */
  const flushSaveOnUnload = useCallback(() => {
    const id = activeProjectIdRef.current;
    const payload = pendingSaveRef.current;
    if (!id || !payload) return;

    pendingSaveRef.current = null;
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    try {
      const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as
        | string
        | undefined;
      if (!url || !anonKey) return;

      // Pull the current access token synchronously from the auth
      // session held in localStorage (Supabase persists it there).
      let accessToken = anonKey;
      try {
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          if (!key || !key.startsWith('sb-')) continue;
          if (!key.endsWith('-auth-token')) continue;
          const raw = window.localStorage.getItem(key);
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          if (parsed?.access_token) {
            accessToken = parsed.access_token as string;
            break;
          }
        }
      } catch {
        /* fall back to anon key */
      }

      const body = JSON.stringify({
        name: payload.name,
        data: payload,
        size_bytes: new Blob([JSON.stringify(payload)]).size,
        privacy: payload.privacy ?? 'private',
      });

      fetch(`${url}/rest/v1/projects?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body,
        keepalive: true,
      }).catch(() => {
        /* best-effort */
      });
    } catch (error) {
      console.warn('[Dashboard] keepalive autosave failed', error);
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

      // Short debounce — long enough to coalesce typing / slider drags,
      // short enough that quick "do something then refresh" sequences
      // still flush before unload.
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void flushSave();
      }, 150);
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
      flushSaveOnUnload();
    };
    const onVisibilityChange = () => {
      // `visibilitychange → hidden` fires reliably on mobile when the
      // user switches tabs / locks the screen, where `pagehide` may be
      // delayed. Flush there too so quick app-switching never loses
      // data.
      if (document.visibilityState === 'hidden') {
        flushSaveOnUnload();
      }
    };

    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);

      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        void flushSave();
      }
    };
  }, [flushSave, flushSaveOnUnload]);

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