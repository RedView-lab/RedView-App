import { useCallback, useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import {
  isProjectTooLarge,
  MAX_PROJECT_SIZE_BYTES,
  saveProject,
  uploadProjectThumbnail,
} from '@/shared/utils/projects';
import { replaceProjectLocation } from '@/shared/utils/projectLocation';
import { captureMapThumbnail } from '@/shared/utils/mapThumbnail';
import { idbSaveThumbnail } from '@/shared/utils/storage/idbProjectStore';
import { writeProjectCache } from './dashboardProjectCache';

import { logger } from '@/shared/lib/logger';

/**
 * Sauvegarde (cache local + cloud) après une rafale de modifications, pas à
 * chaque modification : sérialiser / copier un grand projet coûte des
 * centaines de ms et bloquait l'édition (curseurs, undo/redo). Une édition
 * continue est quand même sauvegardée au moins toutes les AUTOSAVE_MAX_WAIT_MS,
 * et tout est écrit immédiatement à la fermeture / mise en arrière-plan.
 */
const AUTOSAVE_DEBOUNCE_MS = 1000;
const AUTOSAVE_MAX_WAIT_MS = 4000;

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
  const firstQueuedAtRef = useRef<number | null>(null);
  const lastCachedPayloadRef = useRef<ItineraryProject | null>(null);
  const lastSavedPayloadRef = useRef<ItineraryProject | null>(null);

  const flushSave = useCallback(
    async ({ keepalive: _keepalive = false }: { keepalive?: boolean } = {}): Promise<void> => {
      const id = activeProjectIdRef.current;
      const payload = pendingSaveRef.current;
      firstQueuedAtRef.current = null;
      if (!id || !payload) return;

      // Cache local de reprise (IndexedDB / localStorage), une fois par état.
      if (lastCachedPayloadRef.current !== payload) {
        lastCachedPayloadRef.current = payload;
        writeProjectCache(id, payload);
      }

      if (payload === lastSavedPayloadRef.current) {
        pendingSaveRef.current = null;
        return;
      }

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
          lastSavedPayloadRef.current = payload;
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
        lastSavedPayloadRef.current = payload;
        if (pendingSaveRef.current === payload) {
          pendingSaveRef.current = null;
        }
      } catch (error) {
        console.error('[Dashboard] autosave failed', error);
      }
    },
    [activeProjectIdRef],
  );

  /** Reçoit un état déjà normalisé (ProjectStore / mutateur du Dashboard). */
  const queueProjectSave = useCallback(
    (next: ItineraryProject) => {
      const previousName = activeProjectSnapshotRef.current?.name;
      activeProjectSnapshotRef.current = next;
      pendingSaveRef.current = next;

      const id = activeProjectIdRef.current;
      if (id && next.name !== previousName) {
        replaceProjectLocation({ id, name: next.name || 'project' });
      }

      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
      }

      const now = Date.now();
      if (firstQueuedAtRef.current == null) firstQueuedAtRef.current = now;
      const waited = now - firstQueuedAtRef.current;
      const delay = Math.max(0, Math.min(AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS - waited));

      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void flushSave();
      }, delay);
    },
    [activeProjectIdRef, activeProjectSnapshotRef, flushSave],
  );

  /**
   * Sauvegarde explicite (bouton Save) : court-circuite le debounce, horodate
   * `savedAt`/`sizeBytes` et renvoie le projet enregistré (null si rien à
   * sauvegarder). Lève une erreur si le projet dépasse la limite de taille.
   */
  const saveNow = useCallback(async (): Promise<ItineraryProject | null> => {
    const id = activeProjectIdRef.current;
    const current = pendingSaveRef.current ?? activeProjectSnapshotRef.current;
    if (!id || !current) return null;

    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const stamped: ItineraryProject = { ...current, savedAt: new Date().toISOString() };
    const sizeBytes = new Blob([JSON.stringify(stamped)]).size;
    if (!id.startsWith('local-') && isProjectTooLarge(sizeBytes)) {
      throw new Error('Project exceeds payload safety limit');
    }
    const next: ItineraryProject = { ...stamped, sizeBytes };

    await saveProject(id, next);
    lastSavedSerializedRef.current = JSON.stringify(next);
    activeProjectSnapshotRef.current = next;
    if (pendingSaveRef.current === current) {
      pendingSaveRef.current = null;
    }
    writeProjectCache(id, next);
    return next;
  }, [activeProjectIdRef, activeProjectSnapshotRef]);

  const captureThumbnailForProject = useCallback(
    async (projectId: string) => {
      if (!mapInstance || projectId.startsWith('local-')) return;
      try {
        const blob = await captureMapThumbnail(mapInstance);
        if (!blob) return;
        // Sauvegarde locale instantanée dans IndexedDB
        await idbSaveThumbnail(projectId, blob);
        // Upload cloud en arrière-plan sans bloquer
        void uploadProjectThumbnail(projectId, blob);
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
    lastSavedPayloadRef.current = null;
    lastCachedPayloadRef.current = null;
    firstQueuedAtRef.current = null;
    pendingSaveRef.current = null;
  }, []);

  return {
    flushSave,
    queueProjectSave,
    saveNow,
    captureThumbnailForProject,
    resetSyncState,
  };
}
