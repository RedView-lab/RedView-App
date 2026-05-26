import { useCallback, useEffect, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { PROJECT_CACHE_KEY_PREFIX } from '@/features/map3d/lib/mapCacheEpoch';
import { normalizeItineraryProject } from '@/features/itineraryPanel/lib/project';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import {
  getProject,
  isSupabaseProjectTooLarge,
  MAX_SUPABASE_PROJECT_SIZE_BYTES,
  uploadProjectThumbnail,
} from '@/shared/utils/projects';
import { replaceProjectLocation } from '@/shared/utils/projectLocation';
import { captureMapThumbnail } from '@/shared/utils/mapThumbnail';

export type DashboardPersistedMutator = (
  dashboard: NonNullable<ItineraryProject['dashboard']>,
) => void;

interface UseDashboardProjectStateArgs {
  initialProjectId?: string | null;
  mapInstance: MapboxMap | null;
  beforeCloseProject?: () => Promise<void> | void;
}

interface LocalProjectCacheEntry {
  cachedAt: string;
  project: ItineraryProject;
}

const KEEPALIVE_BODY_LIMIT_BYTES = 60_000;
const LOCAL_PROJECT_CACHE_MAX_ENTRY_BYTES = 900_000;
const LOCAL_PROJECT_CACHE_TOTAL_BUDGET_BYTES = 2_500_000;
const LOCAL_PROJECT_CACHE_MAX_ENTRIES = 3;
const cacheWritesDisabledForProject = new Set<string>();
let projectCacheStorageCompacted = false;

function isQuotaExceededError(error: unknown): boolean {
  return error instanceof DOMException
    && (
      error.name === 'QuotaExceededError'
      || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    );
}

function estimateSerializedBytes(value: string): number {
  try {
    return new Blob([value]).size;
  } catch {
    return value.length * 2;
  }
}

function buildLocalProjectCachePayload(project: ItineraryProject): {
  compacted: boolean;
  serialized: string;
} | null {
  const payload: LocalProjectCacheEntry = {
    cachedAt: new Date().toISOString(),
    project: structuredClone(project),
  };

  let compacted = false;
  let serialized = JSON.stringify(payload);
  if (estimateSerializedBytes(serialized) <= LOCAL_PROJECT_CACHE_MAX_ENTRY_BYTES) {
    return { compacted, serialized };
  }

  const compactionSteps: Array<(draft: ItineraryProject) => void> = [
    (draft) => {
      for (const itinerary of draft.itineraries) {
        if (itinerary.gpxRoute?.originalPoints) {
          delete itinerary.gpxRoute.originalPoints;
        }
      }
    },
    (draft) => {
      for (const itinerary of draft.itineraries) {
        delete itinerary.poiFeatures;
      }
    },
    (draft) => {
      for (const itinerary of draft.itineraries) {
        delete itinerary.metrics;
        delete itinerary.routeAudit;
      }
    },
    (draft) => {
      for (const itinerary of draft.itineraries) {
        delete itinerary.prediction;
        delete itinerary.fitUploads;
      }
    },
    (draft) => {
      for (const itinerary of draft.itineraries) {
        delete itinerary.pendingTraceExtension;
        delete itinerary.pendingRoutePatch;
      }
    },
  ];

  for (const compact of compactionSteps) {
    compact(payload.project);
    const nextSerialized = JSON.stringify(payload);
    if (nextSerialized !== serialized) {
      compacted = true;
      serialized = nextSerialized;
    }
    if (estimateSerializedBytes(serialized) <= LOCAL_PROJECT_CACHE_MAX_ENTRY_BYTES) {
      return { compacted, serialized };
    }
  }

  return null;
}

function compactProjectCacheStorage(projectIdToKeep?: string | null): void {
  const pinnedKey = projectIdToKeep ? getProjectCacheKey(projectIdToKeep) : null;
  const entries: { key: string; cachedAtMs: number; bytes: number; pinned: boolean }[] = [];

  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (!key || !key.startsWith(PROJECT_CACHE_KEY_PREFIX)) continue;

    let cachedAtMs = Number.NEGATIVE_INFINITY;
    let bytes = 0;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) {
        window.localStorage.removeItem(key);
        continue;
      }
      bytes = estimateSerializedBytes(raw);
      const parsed = JSON.parse(raw) as Partial<LocalProjectCacheEntry>;
      if (typeof parsed.cachedAt === 'string') {
        const parsedMs = Date.parse(parsed.cachedAt);
        if (Number.isFinite(parsedMs)) cachedAtMs = parsedMs;
      }
    } catch {
      window.localStorage.removeItem(key);
      continue;
    }

    entries.push({
      key,
      cachedAtMs,
      bytes,
      pinned: key === pinnedKey,
    });
  }

  entries.sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return right.cachedAtMs - left.cachedAtMs;
  });

  let keptEntries = 0;
  let keptBytes = 0;

  for (const entry of entries) {
    const keepWithinBudget =
      entry.bytes <= LOCAL_PROJECT_CACHE_MAX_ENTRY_BYTES
      && (
        entry.pinned
        || (
          keptEntries < LOCAL_PROJECT_CACHE_MAX_ENTRIES
          && keptBytes + entry.bytes <= LOCAL_PROJECT_CACHE_TOTAL_BUDGET_BYTES
        )
      );

    if (!keepWithinBudget) {
      window.localStorage.removeItem(entry.key);
      continue;
    }

    keptEntries += 1;
    keptBytes += entry.bytes;
  }
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

function getProjectCacheKey(projectId: string): string {
  return `${PROJECT_CACHE_KEY_PREFIX}${projectId}`;
}

function readProjectCache(projectId: string): LocalProjectCacheEntry | null {
  try {
    if (!projectCacheStorageCompacted) {
      compactProjectCacheStorage(projectId);
      projectCacheStorageCompacted = true;
    }

    const raw = window.localStorage.getItem(getProjectCacheKey(projectId));
    if (!raw) return null;

    if (estimateSerializedBytes(raw) > LOCAL_PROJECT_CACHE_MAX_ENTRY_BYTES) {
      window.localStorage.removeItem(getProjectCacheKey(projectId));
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<LocalProjectCacheEntry>;
    if (!parsed || typeof parsed.cachedAt !== 'string' || !parsed.project) {
      window.localStorage.removeItem(getProjectCacheKey(projectId));
      return null;
    }
    return {
      cachedAt: parsed.cachedAt,
      project: parsed.project as ItineraryProject,
    };
  } catch {
    return null;
  }
}

function writeProjectCache(projectId: string, project: ItineraryProject): void {
  if (cacheWritesDisabledForProject.has(projectId)) return;

  const key = getProjectCacheKey(projectId);
  const payload = buildLocalProjectCachePayload(project);
  if (!payload) {
    cacheWritesDisabledForProject.add(projectId);
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Ignore localStorage failures when removing an oversized snapshot.
    }
    console.warn('[Dashboard] local project cache skipped: project snapshot too large', {
      projectId,
    });
    return;
  }

  if (!projectCacheStorageCompacted) {
    compactProjectCacheStorage(projectId);
    projectCacheStorageCompacted = true;
  }

  try {
    window.localStorage.setItem(key, payload.serialized);
  } catch (error) {
    if (isQuotaExceededError(error)) {
      try {
        compactProjectCacheStorage(projectId);
        window.localStorage.setItem(key, payload.serialized);
        return;
      } catch (retryError) {
        cacheWritesDisabledForProject.add(projectId);
        console.warn(
          '[Dashboard] local project cache disabled after quota exhaustion',
          retryError,
        );
        return;
      }
    }

    cacheWritesDisabledForProject.add(projectId);
    console.warn('[Dashboard] local project cache write failed', error);
  }
}

export function useDashboardProjectState({
  initialProjectId,
  mapInstance,
  beforeCloseProject,
}: UseDashboardProjectStateArgs) {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeProjectInitial, setActiveProjectInitial] =
    useState<ItineraryProject | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [isClosingProject, setIsClosingProject] = useState(false);
  const [projectBrowserOpen, setProjectBrowserOpen] = useState(true);

  const activeProjectSnapshotRef = useRef<ItineraryProject | null>(null);
  /** Latest snapshot that has not yet been confirmed-saved. */
  const pendingSaveRef = useRef<ItineraryProject | null>(null);
  /** Serialized JSON of the most recent successful save (deduplication). */
  const lastSavedSerializedRef = useRef<string | null>(null);
  const lastOversizedSignatureRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const isClosingProjectRef = useRef(false);
  const suppressedInitialProjectIdRef = useRef<string | null>(null);
  activeProjectIdRef.current = activeProjectId;

  useEffect(() => {
    if (projectCacheStorageCompacted) return;
    compactProjectCacheStorage();
    projectCacheStorageCompacted = true;
  }, []);

  /**
   * Persist the current pending snapshot to Supabase via PostgREST with
   * `keepalive: true` so the request survives a page refresh / tab
   * close. Used both by the debounced autosave and the unload handlers.
   *
   * The pending snapshot is kept until the request resolves with 2xx,
   * so a transient network failure doesn't discard the user's work.
   */
  const flushSave = useCallback(
    async ({ keepalive = false }: { keepalive?: boolean } = {}): Promise<void> => {
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

    const sizeBytes = new Blob([serialized]).size;
    if (isSupabaseProjectTooLarge(sizeBytes)) {
      const oversizedSignature = `${id}:${sizeBytes}`;
      if (oversizedSignature !== lastOversizedSignatureRef.current) {
        console.warn(
          '[Dashboard] autosave skipped: project exceeds Supabase payload safety limit',
          {
            sizeBytes,
            maxSizeBytes: MAX_SUPABASE_PROJECT_SIZE_BYTES,
            projectId: id,
          },
        );
        lastOversizedSignatureRef.current = oversizedSignature;
      }
      if (pendingSaveRef.current === payload) {
        pendingSaveRef.current = null;
      }
      return;
    }
    lastOversizedSignatureRef.current = null;

    const accessToken = readAccessTokenSync(anonKey);
    const body = JSON.stringify({
      name: payload.name,
      data: payload,
      size_bytes: sizeBytes,
      privacy: payload.privacy ?? 'private',
    });

    const canUseKeepalive =
      keepalive && new Blob([body]).size <= KEEPALIVE_BODY_LIMIT_BYTES;

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
          // Regular autosaves use a normal request because keepalive has a
          // small browser-imposed payload cap. We only enable it during unload.
          keepalive: canUseKeepalive,
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
    },
    [],
  );

  const queueProjectSave = useCallback(
    (next: ItineraryProject) => {
      const normalizedNext = normalizeItineraryProject(next);
      activeProjectSnapshotRef.current = normalizedNext;
      pendingSaveRef.current = normalizedNext;

      const id = activeProjectIdRef.current;
      if (id) {
        replaceProjectLocation({ id, name: normalizedNext.name || 'project' });
        // Synchronous write-through cache: even if the network request is
        // cancelled or delayed, a same-browser refresh rehydrates this snapshot.
        writeProjectCache(id, normalizedNext);
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
    suppressedInitialProjectIdRef.current = null;
    isClosingProjectRef.current = false;
    setIsClosingProject(false);
    try {
      const row = await getProject(projectId);
      if (!row) throw new Error('Project not found');

      const serverProject = row.data;
      const localCache = readProjectCache(projectId);
      const serverUpdatedAtMs = Date.parse(row.updated_at);
      const localUpdatedAtMs = localCache ? Date.parse(localCache.cachedAt) : Number.NaN;
      const localIsNewer =
        !!localCache
        && Number.isFinite(localUpdatedAtMs)
        && (!Number.isFinite(serverUpdatedAtMs) || localUpdatedAtMs > serverUpdatedAtMs);
      const hydratedProject = localIsNewer ? localCache.project : serverProject;
      const normalizedHydratedProject = normalizeItineraryProject(hydratedProject);
      const normalizedServerProject = normalizeItineraryProject(serverProject);

      activeProjectIdRef.current = row.id;
      activeProjectSnapshotRef.current = normalizedHydratedProject;
      lastSavedSerializedRef.current = JSON.stringify(normalizedServerProject);
      pendingSaveRef.current = null;
      setActiveProjectInitial(normalizedHydratedProject);
      setActiveProjectId(row.id);
      setProjectBrowserOpen(false);
      replaceProjectLocation({
        id: row.id,
        name: row.name || normalizedHydratedProject.name || 'project',
      });

      // If the local browser copy is fresher than the server snapshot,
      // immediately schedule a normal save to push it back upstream.
      if (localIsNewer) {
        queueProjectSave(normalizedHydratedProject);
      }
    } catch (error) {
      const localCache = readProjectCache(projectId);
      if (localCache) {
        const normalizedLocalProject = normalizeItineraryProject(localCache.project);
        activeProjectIdRef.current = projectId;
        activeProjectSnapshotRef.current = normalizedLocalProject;
        pendingSaveRef.current = normalizedLocalProject;
        setActiveProjectInitial(normalizedLocalProject);
        setActiveProjectId(projectId);
        setProjectBrowserOpen(false);
        replaceProjectLocation({
          id: projectId,
          name: normalizedLocalProject.name || 'project',
        });
        queueProjectSave(normalizedLocalProject);
      } else {
        console.error('[Dashboard] failed to open project', error);
        if (activeProjectIdRef.current == null) {
          replaceProjectLocation(null);
        }
      }
    } finally {
      setProjectLoading(false);
    }
  }, [queueProjectSave]);

  useEffect(() => {
    if (initialProjectId !== suppressedInitialProjectIdRef.current) {
      suppressedInitialProjectIdRef.current = null;
    }
  }, [initialProjectId]);

  useEffect(() => {
    if (!initialProjectId || activeProjectId != null || projectLoading) return;
    if (suppressedInitialProjectIdRef.current === initialProjectId) return;
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
      void flushSave({ keepalive: true });
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
        void flushSave({ keepalive: true });
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
    if (isClosingProjectRef.current) return;

    isClosingProjectRef.current = true;
    setIsClosingProject(true);

    try {
      await flushSave();

      const id = activeProjectIdRef.current;
      suppressedInitialProjectIdRef.current = id;
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

      await beforeCloseProject?.();

      activeProjectIdRef.current = null;
      activeProjectSnapshotRef.current = null;
      pendingSaveRef.current = null;
      lastSavedSerializedRef.current = null;
      setActiveProjectInitial(null);
      setActiveProjectId(null);

      setProjectBrowserOpen(true);
      replaceProjectLocation(null);
    } finally {
      isClosingProjectRef.current = false;
      setIsClosingProject(false);
    }
  }, [beforeCloseProject, flushSave, mapInstance]);

  return {
    activeProjectId,
    activeProjectInitial,
    isClosingProject,
    projectLoading,
    projectBrowserOpen,
    setProjectBrowserOpen,
    handleOpenProject,
    handleBackToBrowser,
    handleProjectChange,
    updatePersistedDashboard,
  };
}