import { useCallback, useEffect, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { getProject, uploadProjectThumbnail } from '@/lib/projects';
import { replaceProjectLocation } from '@/lib/projectLocation';
import { captureMapThumbnail } from '@/lib/mapThumbnail';

export type DashboardPersistedMutator = (
  dashboard: NonNullable<ItineraryProject['dashboard']>,
) => void;

interface UseDashboardProjectStateArgs {
  initialProjectId?: string | null;
  mapInstance: MapboxMap | null;
}

/**
 * Read the current Supabase access token from localStorage. Used by the
 * keepalive PATCH path so we don't have to await an async getSession()
 * during `pagehide` (where micro-tasks may not run).
 */
function readAccessTokenSync(anonKey: string): string {
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith('sb-')) continue;
      if (!key.endsWith('-auth-token')) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed?.access_token) return parsed.access_token as string;
    }
  } catch {
    /* fall through */
  }
  return anonKey;
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
  /** Latest snapshot that has not yet been confirmed-saved. */
  const pendingSaveRef = useRef<ItineraryProject | null>(null);
  /** Serialized JSON of the most recent successful save (deduplication). */
  const lastSavedSerializedRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  activeProjectIdRef.current = activeProjectId;

  /**
   * Persist the current pending snapshot to Supabase via PostgREST with
   * `keepalive: true` so the request survives a page refresh / tab
   * close. Used both by the debounced autosave and the unload handlers.
   *
   * The pending snapshot is kept until the request resolves with 2xx,
   * so a transient network failure doesn't discard the user's work.
   */
  const flushSave = useCallback(async (): Promise<void> => {
    const id = activeProjectIdRef.current;
    const payload = pendingSaveRef.current;
    if (!id || !payload) return;

    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as
      | string
      | undefined;
    if (!url || !anonKey) {
      console.warn('[Dashboard] missing Supabase env, autosave disabled');
      return;
    }

    const serialized = JSON.stringify(payload);
    if (serialized === lastSavedSerializedRef.current) {
      // Snapshot is already on the server — nothing to do.
      pendingSaveRef.current = null;
      return;
    }

    const accessToken = readAccessTokenSync(anonKey);
    const body = JSON.stringify({
      name: payload.name,
      data: payload,
      size_bytes: new Blob([serialized]).size,
      privacy: payload.privacy ?? 'private',
    });

    try {
      const res = await fetch(
        `${url}/rest/v1/projects?id=eq.${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: {
            apikey: anonKey,
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body,
          // Survives `pagehide` / refresh, so an in-flight save isn't
          // cancelled when the user navigates away.
          keepalive: true,
        },
      );
      if (!res.ok) {
        console.error(
          '[Dashboard] autosave HTTP error',
          res.status,
          await res.text().catch(() => ''),
        );
        return; // keep `pendingSaveRef` so we retry on the next change
      }
      lastSavedSerializedRef.current = serialized;
      // Only clear if no newer snapshot has been queued in the meantime.
      if (pendingSaveRef.current === payload) {
        pendingSaveRef.current = null;
      }
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
      pendingSaveRef.current = null;
      lastSavedSerializedRef.current = JSON.stringify(row.data);
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
      // Cancel the pending debounce so we issue exactly one keepalive
      // request (the timer's flushSave would race with this one).
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      void flushSave();
    };
    const onVisibilityChange = () => {
      // `visibilitychange → hidden` fires reliably on mobile when the
      // user switches tabs / locks the screen, where `pagehide` may be
      // delayed. Flush there too so quick app-switching never loses
      // data.
      if (document.visibilityState === 'hidden') {
        if (saveTimerRef.current != null) {
          window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        void flushSave();
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