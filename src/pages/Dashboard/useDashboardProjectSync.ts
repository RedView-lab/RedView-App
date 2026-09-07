import { useCallback, useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { normalizeItineraryProject } from '@/features/itineraryPanel/lib/project';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import {
  isProjectTooLarge,
  MAX_PROJECT_SIZE_BYTES,
  saveProject,
  uploadProjectThumbnail,
} from '@/shared/utils/projects';
import { replaceProjectLocation } from '@/shared/utils/projectLocation';
import { captureMapThumbnail } from '@/shared/utils/mapThumbnail';
import { writeProjectCache } from './dashboardProjectCache';

import { logger } from '@/shared/lib/logger';

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
    async ({ keepalive: _keepalive = false }: { keepalive?: boolean } = {}): Promise<void> => {
      const id = activeProjectIdRef.current;
      const payload = pendingSaveRef.current;
      if (!id || !payload) return;

      const endpoint = import.meta.env.VITE_APPWRITE_ENDPOINT as string | undefined;
      if (!endpoint && !import.meta.env.DEV) {
        logger.projects.debug('missing Appwrite env, autosave disabled');
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
      if (isProjectTooLarge(sizeBytes)) {
        const oversizedSignature = `${id}:${sizeBytes}`;
        if (oversizedSignature !== lastOversizedSignatureRef.current) {
          console.warn(
            '[Dashboard] autosave skipped: project exceeds payload safety limit',
            {
              sizeBytes,
              maxSizeBytes: MAX_PROJECT_SIZE_BYTES,
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

      try {
        await saveProject(id, payload);
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
