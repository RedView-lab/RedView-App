import { useCallback, useEffect, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import * as Sentry from '@sentry/react';
// Modules concrets, pas le barrel lib/project (merge-itinerary → geocoder au chargement initial).
import { normalizeItineraryProject } from '@/features/itineraryPanel/lib/project/defaultState';
import { classifyProjectChange, extractProjectView } from '@/features/itineraryPanel/lib/project/layers';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { useLatestRef } from '@/shared/hooks/useLatestRef';
import { notify } from '@/shared/lib/notify';
import {
  flushProjectViews,
  getProject,
  isProjectCloudError,
  PROJECT_CLOUD_ERROR_MESSAGES,
  queueProjectViewSave,
  isSharedProject,
} from '@/shared/services/projects';
import { replaceProjectLocation } from '@/shared/lib/projectLocation';
import { readFullProjectCacheAsync } from '../lib/dashboardProjectCache';
import { useDashboardProjectSync } from './useDashboardProjectSync';

/** Attente maximale de l'envoi cloud du projet courant avant d'en ouvrir un autre. */
const FLUSH_BEFORE_SWITCH_MS = 5000;

/** Message du toast quand un projet ne s'ouvre pas (texte source, traduit par `notify`). */
function describeOpenProjectError(error: unknown): string {
  if (isProjectCloudError(error)) {
    if (error.kind === 'offline') return 'Connexion au cloud impossible : le projet n’a pas pu être ouvert. Réessayez une fois en ligne.';
    if (error.kind === 'unauthorized' || error.kind === 'unreadable') return PROJECT_CLOUD_ERROR_MESSAGES[error.kind];
  }
  return 'Impossible d’ouvrir ce projet.';
}

export type DashboardPersistedMutator = (
  dashboard: NonNullable<ItineraryProject['dashboard']>,
) => void;

type MapViewport = NonNullable<NonNullable<ItineraryProject['dashboard']>['mapViewport']>;

/**
 * Vue carte gardée en attente par les versions précédentes (avant que la vue
 * ne soit enregistrée à part) : reprise une fois à l'ouverture, puis effacée.
 */
const PENDING_VIEWPORT_KEY_PREFIX = 'redview:project-viewport:v1:';

function clearPendingViewport(projectId: string): void {
  try {
    window.localStorage.removeItem(`${PENDING_VIEWPORT_KEY_PREFIX}${projectId}`);
  } catch {
    // au mieux
  }
}

function readPendingViewport(projectId: string): MapViewport | null {
  try {
    const raw = window.localStorage.getItem(`${PENDING_VIEWPORT_KEY_PREFIX}${projectId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MapViewport>;
    if (
      !Array.isArray(parsed.center) || parsed.center.length !== 2
      || typeof parsed.zoom !== 'number' || typeof parsed.pitch !== 'number' || typeof parsed.bearing !== 'number'
    ) {
      return null;
    }
    return parsed as MapViewport;
  } catch {
    return null;
  }
}

interface UseDashboardProjectStateArgs {
  initialProjectId?: string | null;
  /** La carte de l'éditeur, par réf (voir Dashboard : aucune closure ne doit retenir l'instance). */
  mapInstanceRef: React.RefObject<MapboxMap | null>;
  beforeCloseProject?: () => Promise<void> | void;
}

/**
 * Hook gérant l'état, le chargement, la persistance locale et distante (Appwrite)
 * ainsi que le cycle de vie du projet actif dans le Dashboard RedView.
 */
export function useDashboardProjectState({
  initialProjectId,
  mapInstanceRef,
  beforeCloseProject,
}: UseDashboardProjectStateArgs) {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeProjectInitial, setActiveProjectInitial] = useState<ItineraryProject | null>(null);
  /** Projet partagé (équipe) : ouvert en co-édition, le serveur temps réel écrit son document. */
  const [activeProjectShared, setActiveProjectShared] = useState(false);
  const [projectLoading, setProjectLoading] = useState(false);
  const [isClosingProject, setIsClosingProject] = useState(false);
  const [projectBrowserOpen, setProjectBrowserOpen] = useState(true);

  const activeProjectSnapshotRef = useRef<ItineraryProject | null>(null);
  // Écrite aussi par openProject (avant le rendu suivant) ; jamais pendant le rendu.
  const activeProjectIdRef = useLatestRef<string | null>(activeProjectId);
  const isClosingProjectRef = useRef(false);
  const suppressedInitialProjectIdRef = useRef<string | null>(null);

  const {
    flushSave,
    flushPendingLocally,
    queueProjectSave,
    saveNow,
    captureThumbnailForProject,
    resetSyncState,
  } = useDashboardProjectSync({
    mapInstanceRef,
    activeProjectId,
    activeProjectIdRef,
    activeProjectSnapshotRef,
  });

  /** Jeton de la dernière ouverture demandée : les réponses plus anciennes sont ignorées. */
  const openRequestRef = useRef(0);

  const openProject = useCallback(
    async (projectId: string, projectSnapshot?: ItineraryProject) => {
      const requestId = ++openRequestRef.current;
      const isStale = () => requestId !== openRequestRef.current;
      setProjectLoading(true);
      try {
        // Les modifications du projet courant partent avant de changer de projet :
        // copie locale immédiate, envoi cloud attendu au plus FLUSH_BEFORE_SWITCH_MS
        // (au-delà, la copie locale `dirty` sera resynchronisée plus tard).
        await flushPendingLocally();
        await Promise.race([
          flushSave(),
          new Promise<void>((resolve) => window.setTimeout(resolve, FLUSH_BEFORE_SWITCH_MS)),
        ]);
        if (isStale()) return;

        let chosen: ItineraryProject | null = projectSnapshot ?? null;
        let needsSync = false;
        let shared = false;

        if (!chosen) {
          // Le plus récent entre cloud et copie locale (getProject) et l'instantané
          // complet de reprise (IndexedDB) écrit par les versions précédentes.
          const [projectRow, cached] = await Promise.all([
            getProject(projectId),
            readFullProjectCacheAsync(projectId).catch(() => null),
          ]);
          if (isStale()) return;

          chosen = projectRow?.data ?? null;
          needsSync = projectRow?.dirty === true;
          shared = Boolean(projectRow?.team_id) || isSharedProject(projectId);
          const cachedAt = cached ? Date.parse(cached.cachedAt) : Number.NaN;
          const rowAt = projectRow ? Date.parse(projectRow.updated_at) : Number.NaN;
          if (cached && (!projectRow || (Number.isFinite(cachedAt) && Number.isFinite(rowAt) && cachedAt > rowAt + 5000))) {
            chosen = cached.project;
            needsSync = true;
          }
        }

        if (!chosen) {
          console.error('[Dashboard] project not found', projectId);
          notify.error('Projet introuvable.');
          return;
        }

        const normalized = normalizeItineraryProject(chosen);
        // Vue carte laissée en attente par une version précédente : elle
        // rejoint la vue enregistrée de l'utilisateur.
        const pendingViewport = readPendingViewport(projectId);
        if (pendingViewport) {
          normalized.dashboard = { ...(normalized.dashboard ?? {}), mapViewport: pendingViewport };
          queueProjectViewSave(projectId, extractProjectView(normalized));
          clearPendingViewport(projectId);
        }
        setActiveProjectId(projectId);
        activeProjectIdRef.current = projectId;
        setActiveProjectShared(shared);
        setActiveProjectInitial(normalized);
        activeProjectSnapshotRef.current = normalized;
        resetSyncState(projectId, null);
        replaceProjectLocation({ id: projectId, name: normalized.name || 'project' });
        setProjectBrowserOpen(false);
        // Modifications locales non confirmées par le cloud : on les renvoie
        // (jamais pour un projet partagé : son document vient du serveur temps réel).
        if (needsSync && !shared) queueProjectSave(normalized);
      } catch (error) {
        console.error('[Dashboard] project loading failed', error);
        // Données corrompues : l'utilisateur n'y peut rien, nous si.
        if (isProjectCloudError(error) && error.kind === 'unreadable') {
          Sentry.captureException(error.originalError ?? error, { tags: { projectId, projectError: 'unreadable' } });
        }
        if (!isStale()) notify.error(describeOpenProjectError(error));
      } finally {
        if (!isStale()) setProjectLoading(false);
      }
    },
    [activeProjectIdRef, flushPendingLocally, flushSave, queueProjectSave, resetSyncState],
  );

  const closeProject = useCallback(async () => {
    if (isClosingProjectRef.current) return;
    isClosingProjectRef.current = true;
    setIsClosingProject(true);

    try {
      const closingId = activeProjectIdRef.current;
      suppressedInitialProjectIdRef.current = closingId;

      // 1. Capturer la miniature pendant que le WebGL Canvas est actif
      if (closingId) {
        try {
          await captureThumbnailForProject(closingId);
        } catch (error) {
          console.warn('[Dashboard] captureThumbnailForProject failed', error);
        }
      }

      // 2. Nettoyage de la carte
      if (beforeCloseProject) {
        try {
          await beforeCloseProject();
        } catch (error) {
          console.warn('[Dashboard] beforeCloseProject hook failed', error);
        }
      }

      await flushPendingLocally();
      await Promise.all([
        flushSave(),
        closingId ? flushProjectViews(closingId) : Promise.resolve(),
      ]);
      resetSyncState(null, null);

      setActiveProjectId(null);
      setActiveProjectInitial(null);
      activeProjectSnapshotRef.current = null;
      replaceProjectLocation(null);
      setProjectBrowserOpen(true);
    } finally {
      isClosingProjectRef.current = false;
      setIsClosingProject(false);
    }
  }, [activeProjectIdRef, beforeCloseProject, captureThumbnailForProject, flushPendingLocally, flushSave, resetSyncState]);

  const saveActiveProject = useCallback(async (options?: { force?: boolean }) => {
    const id = activeProjectIdRef.current;
    // Bouton Enregistrer : la vue en attente part aussi tout de suite.
    if (id) void flushProjectViews(id);
    const saved = await saveNow(options);
    if (saved && id) {
      void captureThumbnailForProject(id);
    }
    return saved;
  }, [activeProjectIdRef, captureThumbnailForProject, saveNow]);

  /**
   * Met à jour `dashboard` (vue carte, tailles des panneaux). C'est de la vue
   * (cf. lib/project/layers.ts) : enregistrée à part (projectViews.ts), sans
   * sérialiser ni renvoyer le projet. Copie superficielle : les mutateurs
   * n'affectent que des champs de premier niveau de `dashboard`.
   */
  const mutateActiveProjectDashboard = useCallback(
    (mutator: DashboardPersistedMutator) => {
      const current = activeProjectSnapshotRef.current;
      const id = activeProjectIdRef.current;
      if (!current || !id) return;

      const dashboard: NonNullable<ItineraryProject['dashboard']> = { ...(current.dashboard ?? {}) };
      mutator(dashboard);
      if (JSON.stringify(dashboard) === JSON.stringify(current.dashboard ?? {})) return;
      const next: ItineraryProject = { ...current, dashboard };
      activeProjectSnapshotRef.current = next;
      queueProjectViewSave(id, extractProjectView(next));
    },
    [activeProjectIdRef],
  );

  /**
   * Modification venant du ProjectStore. `dashboard` (vue carte, tailles des
   * panneaux) est tenu ici par `mutateActiveProjectDashboard`, hors store : la
   * copie du store date de l'ouverture du projet et écraserait la vue et les
   * panneaux sauvegardés depuis. On garde donc toujours la version courante.
   *
   * Seules les couches touchées sont enregistrées : le document (et le travail
   * en attente) par l'autosave, la vue à part — un changement de panneau, de
   * graphe ou d'itinéraire actif ne réécrit jamais le projet.
   */
  const handleProjectChange = useCallback(
    (next: ItineraryProject) => {
      const previous = activeProjectSnapshotRef.current;
      const dashboard = previous?.dashboard;
      const composed = dashboard ? { ...next, dashboard } : next;
      const change = previous ? classifyProjectChange(previous, composed) : null;
      if (!change || change.document || change.work) {
        queueProjectSave(composed);
      } else {
        activeProjectSnapshotRef.current = composed;
      }
      const id = activeProjectIdRef.current;
      if (id && (!change || change.view)) queueProjectViewSave(id, extractProjectView(composed));
    },
    [activeProjectIdRef, queueProjectSave],
  );

  /**
   * État complet et à jour du projet ouvert (ProjectStore + `dashboard` tenu
   * ici : vue carte, panneaux), pour l'export `.redview`.
   */
  const getActiveProjectSnapshot = useCallback(() => activeProjectSnapshotRef.current, []);

  useEffect(() => {
    if (!initialProjectId) return;
    if (suppressedInitialProjectIdRef.current === initialProjectId) return;
    if (activeProjectIdRef.current === initialProjectId) return;

    void openProject(initialProjectId);
  }, [activeProjectIdRef, initialProjectId, openProject]);

  return {
    activeProjectId,
    activeProjectInitial,
    activeProjectShared,
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
    handleProjectChange,
    handleSaveProject: saveActiveProject,
    updatePersistedDashboard: mutateActiveProjectDashboard,
    getActiveProjectSnapshot,
  };
}