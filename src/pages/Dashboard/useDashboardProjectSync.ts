import { useCallback, useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import {
  flushProjectViews,
  isServerOwnedDocument,
  saveProject,
  saveProjectLocally,
  serializeProjectForStorage,
  setProjectSyncStatus,
  ProjectCloudError,
  toProjectCloudError,
  uploadProjectThumbnail,
  utf8ByteLength,
} from '@/shared/utils/projects';
import { replaceProjectLocation } from '@/shared/utils/projectLocation';
import { captureMapThumbnail } from '@/shared/utils/mapThumbnail';
import { idbSaveThumbnail } from '@/shared/utils/storage/idbProjectStore';

import { logger } from '@/shared/lib/logger';

/**
 * Sauvegarde (copie locale + cloud) après une rafale de modifications, pas à
 * chaque modification : sérialiser un grand projet coûte des centaines de ms.
 * Une édition continue est quand même sauvegardée au moins toutes les
 * AUTOSAVE_MAX_WAIT_MS, et la copie locale est écrite immédiatement à la
 * fermeture / mise en arrière-plan (la requête cloud n'y a pas le temps : la
 * ligne locale `dirty` est resynchronisée à la prochaine ouverture).
 */
const AUTOSAVE_DEBOUNCE_MS = 1000;
const AUTOSAVE_MAX_WAIT_MS = 4000;
/** Réessais automatiques quand le cloud est injoignable (puis toutes les 60 s). */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

type SaveCallback = (error: ProjectCloudError | null) => void;

interface PendingSave {
  id: string;
  project: ItineraryProject;
  /** Écraser la version cloud malgré un conflit (choix explicite de l'utilisateur). */
  force?: boolean;
  /** Sauvegardes explicites en attente du résultat de cet envoi. */
  callbacks: SaveCallback[];
}

interface UseDashboardProjectSyncArgs {
  /**
   * The editor's map, by ref, never the instance: V8 gives every closure of
   * one call a single shared context, so the unload/online listeners below
   * (re-registered per project, not per map) kept the last removed Mapbox map
   * alive after the editor closed (`bench:dashboard -- --scenario leak`).
   */
  mapInstanceRef: React.RefObject<MapboxMap | null>;
  activeProjectId: string | null;
  activeProjectIdRef: React.MutableRefObject<string | null>;
  activeProjectSnapshotRef: React.MutableRefObject<ItineraryProject | null>;
}

export function useDashboardProjectSync({
  mapInstanceRef,
  activeProjectId,
  activeProjectIdRef,
  activeProjectSnapshotRef,
}: UseDashboardProjectSyncArgs) {
  const pendingSaveRef = useRef<PendingSave | null>(null);
  /** Dernier état envoyé (document + travail local sérialisés). */
  const lastSavedRef = useRef<{ id: string; documentJson: string; workJson: string | null } | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const firstQueuedAtRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const retryAttemptRef = useRef(0);
  /**
   * Envoi cloud suspendu pour ce projet : copie locale seulement. Conflit /
   * supprimé : jusqu'à une sauvegarde explicite. Trop gros : tant que le
   * projet n'a pas rétréci sous `sizeChars` (longueur JSON refusée), plutôt
   * que de recompresser et renvoyer tout le projet à chaque modification.
   */
  const blockedRef = useRef<
    | { id: string; kind: 'conflict' | 'not-found' }
    | { id: string; kind: 'too-large'; sizeChars: number }
    | null
  >(null);
  /**
   * Projet dont le dernier envoi a échoué : les nouveaux essais automatiques
   * restent silencieux (pas d'« Enregistrement… » entre deux « Échec »), seul
   * un succès change l'indicateur.
   */
  const failingIdRef = useRef<string | null>(null);
  const flushSaveRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current != null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const scheduleRetry = useCallback(() => {
    clearRetryTimer();
    const attempt = retryAttemptRef.current;
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    retryAttemptRef.current = attempt + 1;
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      void flushSaveRef.current();
    }, delay);
  }, [clearRetryTimer]);

  const reportFailure = useCallback(
    (item: PendingSave, error: ProjectCloudError, sizeChars: number) => {
      const status = {
        projectId: item.id,
        errorKind: error.kind,
        message: error.message,
      };
      failingIdRef.current = item.id;
      switch (error.kind) {
        case 'offline':
          logger.projects.warn('autosave postponed: cloud unreachable', item.id);
          setProjectSyncStatus({ ...status, state: 'pending-offline' });
          scheduleRetry();
          return;
        case 'conflict':
        case 'not-found':
          // Ne jamais écraser une version plus récente / recréer un projet supprimé :
          // les modifications suivantes restent sur cet appareil (copie `dirty`).
          logger.projects.error(`autosave stopped (${error.kind})`, item.id);
          blockedRef.current = { id: item.id, kind: error.kind };
          setProjectSyncStatus({ ...status, state: 'error' });
          return;
        case 'too-large':
          // Inutile de retenter tant que le projet n'a pas rétréci (le bouton
          // Enregistrer retente quand même).
          logger.projects.error('autosave paused (too-large)', item.id, error);
          blockedRef.current = { id: item.id, kind: 'too-large', sizeChars };
          setProjectSyncStatus({ ...status, state: 'error' });
          return;
        default:
          // unauthorized / rejected : nouvel essai à la prochaine
          // modification, au retour du réseau ou via le bouton Enregistrer.
          logger.projects.error(`autosave failed (${error.kind})`, item.id, error);
          setProjectSyncStatus({ ...status, state: 'error' });
      }
    },
    [scheduleRetry],
  );

  /**
   * Un envoi : renvoie l'erreur cloud (copie locale déjà écrite) ou null, et
   * la longueur du JSON envoyé.
   */
  const persistOnce = useCallback(async (
    item: PendingSave,
  ): Promise<{ error: ProjectCloudError | null; sizeChars: number }> => {
    // Une seule sérialisation du document par envoi, réutilisée pour la
    // taille, la compression et la copie locale (la vue part à part).
    const serialized = serializeProjectForStorage(item.project);
    const sizeChars = serialized.documentJson.length;
    const last = lastSavedRef.current;
    if (
      !item.force
      && last
      && last.id === item.id
      && last.documentJson === serialized.documentJson
      && last.workJson === serialized.workJson
    ) {
      return { error: null, sizeChars };
    }

    // Projet en co-édition : le serveur temps réel écrit le document partagé ;
    // ici, copie locale seulement (même pour une sauvegarde explicite).
    if (isServerOwnedDocument(item.id)) {
      try {
        await saveProjectLocally(item.id, item.project, serialized);
      } catch (error) {
        logger.projects.warn('local-only save failed (live session)', error);
      }
      return { error: null, sizeChars };
    }

    const blocked = blockedRef.current;
    const stillBlocked = blocked != null
      && blocked.id === item.id
      && (blocked.kind !== 'too-large' || sizeChars >= blocked.sizeChars);
    // Autosave d'un projet bloqué : copie locale seulement. Une sauvegarde explicite
    // (bouton Enregistrer) retente le cloud pour afficher l'erreur à jour.
    if (!item.force && item.callbacks.length === 0 && stillBlocked) {
      try {
        await saveProjectLocally(item.id, item.project, serialized);
      } catch (error) {
        logger.projects.warn('local-only save failed', error);
      }
      return { error: null, sizeChars };
    }

    // Nouvel essai après un échec : l'indicateur garde l'échec jusqu'au succès.
    if (failingIdRef.current !== item.id) {
      setProjectSyncStatus({ projectId: item.id, state: 'saving' });
    }
    try {
      await saveProject(item.id, item.project, { documentJson: serialized.documentJson, force: item.force });
      lastSavedRef.current = { id: item.id, documentJson: serialized.documentJson, workJson: serialized.workJson };
      // Le cloud a accepté cet état : plus rien ne bloque l'autosave.
      if (blockedRef.current?.id === item.id) blockedRef.current = null;
      if (failingIdRef.current === item.id) failingIdRef.current = null;
      return { error: null, sizeChars };
    } catch (error) {
      return { error: toProjectCloudError(error), sizeChars };
    }
  }, []);

  /** Boucle d'envoi unique : traite toujours le dernier état en attente. */
  const runSaveLoop = useCallback(async () => {
    for (;;) {
      const item = pendingSaveRef.current;
      if (!item) return;
      pendingSaveRef.current = null;

      const { error, sizeChars } = await persistOnce(item);
      for (const callback of item.callbacks) callback(error);

      if (!error) {
        retryAttemptRef.current = 0;
        clearRetryTimer();
        const blocked = blockedRef.current?.id === item.id;
        if (!pendingSaveRef.current && !blocked) {
          setProjectSyncStatus({ projectId: item.id, state: 'saved' });
        }
        continue;
      }

      reportFailure(item, error, sizeChars);
      // Un état plus récent est arrivé pendant l'envoi : on le traite (il porte
      // peut-être une sauvegarde explicite qui attend son résultat).
      if (pendingSaveRef.current) continue;
      // Sinon la sauvegarde échouée reste en attente (nouvel essai : backoff,
      // retour réseau, prochaine modification ou bouton Enregistrer), sauf
      // conflit / suppression où l'envoi cloud est suspendu.
      const blocking = error.kind === 'conflict' || error.kind === 'not-found';
      if (!blocking) pendingSaveRef.current = { ...item, force: false, callbacks: [] };
      return;
    }
  }, [clearRetryTimer, persistOnce, reportFailure]);

  /**
   * Envoie l'état en attente. Un seul envoi à la fois : un appel pendant un
   * envoi renvoie la même promesse ; la boucle reprend le dernier état ensuite.
   */
  const flushSave = useCallback((): Promise<void> => {
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    firstQueuedAtRef.current = null;

    if (inFlightRef.current) return inFlightRef.current;

    const run = runSaveLoop().finally(() => {
      inFlightRef.current = null;
    });
    inFlightRef.current = run;
    return run;
  }, [runSaveLoop]);
  useEffect(() => {
    flushSaveRef.current = flushSave;
  }, [flushSave]);

  /** Écrit tout de suite la copie locale de l'état en attente (fermeture d'onglet). */
  const flushPendingLocally = useCallback(async (): Promise<void> => {
    const item = pendingSaveRef.current;
    if (!item) return;
    try {
      await saveProjectLocally(item.id, item.project);
    } catch (error) {
      logger.projects.warn('local flush failed', error);
    }
  }, []);

  const enqueuePending = useCallback((id: string, project: ItineraryProject, force = false): PendingSave => {
    const previous = pendingSaveRef.current;
    const carried = previous && previous.id === id ? previous : null;
    const next: PendingSave = {
      id,
      project,
      force: force || carried?.force === true,
      callbacks: carried ? carried.callbacks : [],
    };
    pendingSaveRef.current = next;
    return next;
  }, []);

  /** Reçoit un état déjà normalisé (ProjectStore / mutateur du Dashboard). */
  const queueProjectSave = useCallback(
    (next: ItineraryProject) => {
      const previousName = activeProjectSnapshotRef.current?.name;
      activeProjectSnapshotRef.current = next;

      const id = activeProjectIdRef.current;
      if (!id) return;
      enqueuePending(id, next);

      if (next.name !== previousName) {
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
        void flushSaveRef.current();
      }, delay);
    },
    [activeProjectIdRef, activeProjectSnapshotRef, enqueuePending],
  );

  /**
   * Sauvegarde explicite (bouton Save) : court-circuite le debounce, horodate
   * `savedAt`/`sizeBytes` et renvoie le projet enregistré (null si rien à
   * sauvegarder). Lève la ProjectCloudError si le cloud n'a pas confirmé
   * (trop gros, hors-ligne, conflit…) ; `force` écrase une version modifiée
   * ailleurs après confirmation de l'utilisateur.
   */
  const saveNow = useCallback(
    async ({ force = false }: { force?: boolean } = {}): Promise<ItineraryProject | null> => {
      const id = activeProjectIdRef.current;
      const current = activeProjectSnapshotRef.current;
      if (!id || !current) return null;

      const stamped: ItineraryProject = { ...current, savedAt: new Date().toISOString() };
      const next: ItineraryProject = { ...stamped, sizeBytes: utf8ByteLength(JSON.stringify(stamped)) };
      activeProjectSnapshotRef.current = next;

      const result = new Promise<ProjectCloudError | null>((resolve) => {
        enqueuePending(id, next, force).callbacks.push(resolve);
      });
      clearRetryTimer();
      retryAttemptRef.current = 0;
      void flushSave();
      // Un envoi en cours se termine d'abord ; la boucle traite ensuite cet état.
      const error = await result;
      if (error) throw error;
      return next;
    },
    [activeProjectIdRef, activeProjectSnapshotRef, clearRetryTimer, enqueuePending, flushSave],
  );

  const captureThumbnailForProject = useCallback(
    async (projectId: string) => {
      const map = mapInstanceRef.current;
      if (!map || projectId.startsWith('local-')) return;
      try {
        const blob = await captureMapThumbnail(map);
        if (!blob) return;
        // Sauvegarde locale instantanée dans IndexedDB
        await idbSaveThumbnail(projectId, blob);
        // Upload cloud en arrière-plan sans bloquer
        void uploadProjectThumbnail(projectId, blob);
      } catch (error) {
        console.warn('[Dashboard] project thumbnail capture/upload failed', error);
      }
    },
    [mapInstanceRef],
  );

  useEffect(() => {
    const handleUnload = () => {
      // Copie locale immédiate (durable même si l'onglet se ferme), puis essai cloud.
      void flushPendingLocally();
      void flushSave();
      void flushProjectViews();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') handleUnload();
    };

    const handleOnline = () => {
      retryAttemptRef.current = 0;
      clearRetryTimer();
      void flushSave();
    };

    window.addEventListener('pagehide', handleUnload);
    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('pagehide', handleUnload);
      window.removeEventListener('beforeunload', handleUnload);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      void flushPendingLocally();
      void flushSave();
      void flushProjectViews();
    };
  }, [activeProjectId, clearRetryTimer, flushPendingLocally, flushSave]);

  /**
   * Réinitialise l'état de synchronisation à l'ouverture / fermeture d'un
   * projet. `loaded` : document et travail local sérialisés de l'état chargé
   * (null = inconnu). Les envois déjà en attente pour un autre projet sont
   * abandonnés en mémoire : leur copie locale (`dirty`) est resynchronisée à la
   * prochaine ouverture.
   */
  const resetSyncState = useCallback(
    (projectId: string | null, loaded: { documentJson: string; workJson: string | null } | null) => {
      lastSavedRef.current = projectId && loaded ? { id: projectId, ...loaded } : null;
      firstQueuedAtRef.current = null;
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      clearRetryTimer();
      retryAttemptRef.current = 0;
      blockedRef.current = null;
      failingIdRef.current = null;
      const pending = pendingSaveRef.current;
      if (pending) {
        const dropped = new ProjectCloudError('offline');
        for (const callback of pending.callbacks) callback(dropped);
      }
      pendingSaveRef.current = null;
      setProjectSyncStatus({ projectId, state: 'idle' });
    },
    [clearRetryTimer],
  );

  return {
    flushSave,
    flushPendingLocally,
    queueProjectSave,
    saveNow,
    captureThumbnailForProject,
    resetSyncState,
  };
}
