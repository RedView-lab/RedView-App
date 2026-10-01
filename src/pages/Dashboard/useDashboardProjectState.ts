import { useCallback, useEffect, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { normalizeItineraryProject } from '@/features/itineraryPanel/lib/project';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { getProject } from '@/shared/utils/projects';
import { replaceProjectLocation } from '@/shared/utils/projectLocation';
import { readFullProjectCacheAsync } from './dashboardProjectCache';
import { useDashboardProjectSync } from './useDashboardProjectSync';

/** Attente maximale de l'envoi cloud du projet courant avant d'en ouvrir un autre. */
const FLUSH_BEFORE_SWITCH_MS = 5000;

export type DashboardPersistedMutator = (
  dashboard: NonNullable<ItineraryProject['dashboard']>,
) => void;

export interface DashboardPersistOptions {
  /** Changement purement local (vue carte) : ne déclenche pas de sauvegarde cloud. */
  localOnly?: boolean;
}

type MapViewport = NonNullable<NonNullable<ItineraryProject['dashboard']>['mapViewport']>;

const PENDING_VIEWPORT_KEY_PREFIX = 'redview:project-viewport:v1:';

function writePendingViewport(projectId: string, viewport: MapViewport | undefined): void {
  if (!viewport) return;
  try {
    window.localStorage.setItem(`${PENDING_VIEWPORT_KEY_PREFIX}${projectId}`, JSON.stringify(viewport));
  } catch {
    // best effort
  }
}

function clearPendingViewport(projectId: string): void {
  try {
    window.localStorage.removeItem(`${PENDING_VIEWPORT_KEY_PREFIX}${projectId}`);
  } catch {
    // best effort
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
  mapInstance: MapboxMap | null;
  beforeCloseProject?: () => Promise<void> | void;
}

/**
 * Hook gérant l'état, le chargement, la persistance locale et distante (Appwrite)
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
  /** Modifications locales seulement (vue carte) pas encore incluses dans une sauvegarde. */
  const localOnlyChangesRef = useRef(false);
  activeProjectIdRef.current = activeProjectId;

  const {
    flushSave,
    flushPendingLocally,
    queueProjectSave,
    saveNow,
    captureThumbnailForProject,
    resetSyncState,
  } = useDashboardProjectSync({
    mapInstance,
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
          const cachedAt = cached ? Date.parse(cached.cachedAt) : Number.NaN;
          const rowAt = projectRow ? Date.parse(projectRow.updated_at) : Number.NaN;
          if (cached && (!projectRow || (Number.isFinite(cachedAt) && Number.isFinite(rowAt) && cachedAt > rowAt + 5000))) {
            chosen = cached.project;
            needsSync = true;
          }
        }

        if (!chosen) {
          console.error('[Dashboard] project not found', projectId);
          return;
        }

        const normalized = normalizeItineraryProject(chosen);
        // Vue carte modifiée sans sauvegarde cloud lors de la session précédente.
        const pendingViewport = readPendingViewport(projectId);
        localOnlyChangesRef.current = pendingViewport != null;
        if (pendingViewport) {
          normalized.dashboard = { ...(normalized.dashboard ?? {}), mapViewport: pendingViewport };
        }
        setActiveProjectId(projectId);
        activeProjectIdRef.current = projectId;
        setActiveProjectInitial(normalized);
        activeProjectSnapshotRef.current = normalized;
        resetSyncState(projectId, null);
        replaceProjectLocation({ id: projectId, name: normalized.name || 'project' });
        setProjectBrowserOpen(false);
        // Modifications locales non confirmées par le cloud : on les renvoie.
        if (needsSync) queueProjectSave(normalized);
      } catch (error) {
        console.error('[Dashboard] project loading failed', error);
      } finally {
        if (!isStale()) setProjectLoading(false);
      }
    },
    [flushPendingLocally, flushSave, queueProjectSave, resetSyncState],
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

      // Vue carte modifiée depuis la dernière sauvegarde : une sauvegarde à la fermeture.
      const closingSnapshot = activeProjectSnapshotRef.current;
      if (localOnlyChangesRef.current && closingSnapshot) {
        localOnlyChangesRef.current = false;
        queueProjectSave(closingSnapshot);
        if (closingId) clearPendingViewport(closingId);
      }
      await flushPendingLocally();
      await flushSave();
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
  }, [beforeCloseProject, captureThumbnailForProject, flushPendingLocally, flushSave, queueProjectSave, resetSyncState]);

  const saveActiveProject = useCallback(async (options?: { force?: boolean }) => {
    const saved = await saveNow(options);
    const id = activeProjectIdRef.current;
    if (saved && id) {
      void captureThumbnailForProject(id);
    }
    return saved;
  }, [captureThumbnailForProject, saveNow]);

  /**
   * Met à jour `dashboard` (vue carte, tailles des panneaux). Copie superficielle :
   * les mutateurs n'affectent que des champs de premier niveau de `dashboard`
   * (un structuredClone du projet entier coûtait des centaines de ms par
   * déplacement de carte). `localOnly` (vue carte) : pas de sauvegarde cloud à
   * elle seule — la vue part avec la prochaine vraie sauvegarde (ou à la
   * fermeture) et est gardée en attendant dans un petit cache local.
   */
  const mutateActiveProjectDashboard = useCallback(
    (mutator: DashboardPersistedMutator, options: DashboardPersistOptions = {}) => {
      const current = activeProjectSnapshotRef.current;
      const id = activeProjectIdRef.current;
      if (!current || !id) return;

      const dashboard: NonNullable<ItineraryProject['dashboard']> = { ...(current.dashboard ?? {}) };
      mutator(dashboard);
      const next: ItineraryProject = { ...current, dashboard };

      if (options.localOnly) {
        activeProjectSnapshotRef.current = next;
        localOnlyChangesRef.current = true;
        writePendingViewport(id, dashboard.mapViewport);
        return;
      }
      localOnlyChangesRef.current = false;
      clearPendingViewport(id);
      queueProjectSave(next);
    },
    [queueProjectSave],
  );

  /**
   * Modification venant du ProjectStore. `dashboard` (vue carte, tailles des
   * panneaux) est tenu ici par `mutateActiveProjectDashboard`, hors store : la
   * copie du store date de l'ouverture du projet et écraserait la vue et les
   * panneaux sauvegardés depuis. On garde donc toujours la version courante.
   */
  const handleProjectChange = useCallback(
    (next: ItineraryProject) => {
      const dashboard = activeProjectSnapshotRef.current?.dashboard;
      // La vue carte locale part avec cette sauvegarde.
      const id = activeProjectIdRef.current;
      if (localOnlyChangesRef.current && id) {
        localOnlyChangesRef.current = false;
        clearPendingViewport(id);
      }
      queueProjectSave(dashboard ? { ...next, dashboard } : next);
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
    handleProjectChange,
    handleSaveProject: saveActiveProject,
    updatePersistedDashboard: mutateActiveProjectDashboard,
  };
}