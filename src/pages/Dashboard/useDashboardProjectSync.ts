import { useCallback, useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { normalizeItineraryProject } from '@/features/itineraryPanel/lib/project';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import {
  isSupabaseProjectTooLarge,
  MAX_SUPABASE_PROJECT_SIZE_BYTES,
  saveProject,
  uploadProjectThumbnail,
} from '@/shared/utils/projects';
import { replaceProjectLocation } from '@/shared/utils/projectLocation';
import { captureMapThumbnail } from '@/shared/utils/mapThumbnail';
import {
  KEEPALIVE_BODY_LIMIT_BYTES,
  readAccessTokenSync,
  writeProjectCache,
} from './dashboardProjectCache';

interface UseDashboardProjectSyncArgs {
  mapInstance: MapboxMap | null;
  activeProjectId: string | null;
  activeProjectIdRef: React.MutableRefObject<string | null>;
  activeProjectSnapshotRef: React.MutableRefObject<ItineraryProject | null>;
}

export function useDashboardProjectSync({
  mapInstance,
  activeProjectId,
  activeProjectIdRef,
  activeProjectSnapshotRef,
}: UseDashboardProjectSyncArgs) {
  const pendingSaveRef = useRef<ItineraryProject | null>(null);
  const lastSavedSerializedRef = useRef<string | null>(null);
  const lastOversizedSignatureRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);

  const flushSave = useCallback(
    async ({ keepalive = false }: { keepalive?: boolean } = {}): Promise<void> => {
      const id = activeProjectIdRef.current;
      const payload = pendingSaveRef.current;
      if (!id || !payload) return;

      const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
      if (!url || !anonKey) {
        console.warn('[Dashboard] missing Supabase env, autosave disabled');
        return;
      }

      const serialized = JSON.stringify(payload);
      if (serialized === lastSavedSerializedRef.current) {
        pendingSaveRef.current = null;
        return;
      }

      if (id.startsWith('local-')) {
        try {
          await saveProject(id, payload);
          lastSavedSerializedRef.current = serialized;
          if (pendingSaveRef.current === payload) {
            pendingSaveRef.current = null;
          }
        } catch (error) {
          console.error('[Dashboard] local autosave failed', error);
        }
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
            keepalive: canUseKeepalive,
          },
        );
        if (!res.ok) {
          console.error(
            '[Dashboard] autosave HTTP error',
            res.status,
            await res.text().catch(() => ''),
          );
          return;
        }
        lastSavedSerializedRef.current = serialized;
        if (pendingSaveRef.current === payload) {
          pendingSaveRef.current = null;
        }
      } catch (error) {
        console.error('[Dashboard] autosave failed', error);
      }
    },
    [activeProjectIdRef],
  );

  const queueProjectSave = useCallback(
    (next: ItineraryProject) => {
      const normalizedNext = normalizeItineraryProject(next);
      activeProjectSnapshotRef.current = normalizedNext;
      pendingSaveRef.current = normalizedNext;

      const id = activeProjectIdRef.current;
      if (id) {
        replaceProjectLocation({ id, name: normalizedNext.name || 'project' });
        writeProjectCache(id, normalizedNext);
      }

      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void flushSave();
      }, 150);
    },
    [activeProjectIdRef, activeProjectSnapshotRef, flushSave],
  );

  const captureThumbnailForProject = useCallback(
    async (projectId: string) => {
      if (!mapInstance || projectId.startsWith('local-')) return;
      try {
        const blob = await captureMapThumbnail(mapInstance);
        if (!blob) return;
        await uploadProjectThumbnail(projectId, blob);
      } catch (error) {
        console.warn('[Dashboard] project thumbnail capture/upload failed', error);
      }
    },
    [mapInstance],
  );

  const flushSaveRef = useRef(flushSave);
  flushSaveRef.current = flushSave;

  useEffect(() => {
    const handleUnload = () => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      void flushSaveRef.current({ keepalive: true });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        void flushSaveRef.current({ keepalive: true });
      }
    };

    window.addEventListener('pagehide', handleUnload);
    window.addEventListener('beforeunload', handleUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('pagehide', handleUnload);
      window.removeEventListener('beforeunload', handleUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
      }
      void flushSaveRef.current();
    };
  }, [activeProjectId]);

  const resetSyncState = useCallback((serialized: string | null) => {
    lastSavedSerializedRef.current = serialized;
    pendingSaveRef.current = null;
  }, []);

  return {
    flushSave,
    queueProjectSave,
    captureThumbnailForProject,
    resetSyncState,
  };
}
