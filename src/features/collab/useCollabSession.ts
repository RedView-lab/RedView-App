import { useEffect, useRef, useState } from 'react';

import type { ProjectCollabLink } from '@/features/itineraryPanel/context/ProjectStore/collab';
import { createDefaultProject } from '@/features/itineraryPanel/lib/project/defaultState';
import { toProjectDocument } from '@/features/itineraryPanel/lib/project/layers';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { logger } from '@/shared/lib/logger';
import { getAppwriteJwt, getSessionUserIdSync, readStoredAppwriteSession } from '@/shared/services/appwrite';
import { registerLiveSession } from '@/shared/utils/projects/liveSessions';

import type { CollabState } from './client/collabClient';
import { multiplayerSocketUrl } from './queries/multiplayerHealth';
import type { CollabConnection } from './client/connection';

/**
 * Session de co-édition du projet ouvert : connexion au serveur temps réel
 * (server/multiplayer) pour un projet partagé. Le moteur n'est chargé qu'à
 * l'ouverture d'une session (import dynamique) : rien de plus dans le bundle
 * d'un projet solo.
 *
 * Développement : `?collab=server` dans l'URL (gardé pour l'onglet) ou
 * `localStorage['redview:dev-collab'] = 'server'` ouvre une session pour
 * n'importe quel projet (serveur local lancé par `npm run dev`, projet créé
 * côté serveur à partir du document de ce client).
 */
const DEV_COLLAB_KEY = 'redview:dev-collab';
const DEV_COLLAB_VALUE = 'server';

function readUrlFlag(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  try {
    const param = new URLSearchParams(window.location.search).get('collab');
    if (param === null) return;
    if (param === DEV_COLLAB_VALUE) window.sessionStorage.setItem(DEV_COLLAB_KEY, DEV_COLLAB_VALUE);
    else window.sessionStorage.removeItem(DEV_COLLAB_KEY);
  } catch {
    // stockage indisponible : réglage ignoré
  }
}

// Lu au chargement : l'ouverture d'un projet remplace l'URL (et sa requête).
readUrlFlag();

function isDevCollabForced(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(DEV_COLLAB_KEY) === DEV_COLLAB_VALUE
      || window.localStorage.getItem(DEV_COLLAB_KEY) === DEV_COLLAB_VALUE;
  } catch {
    return false;
  }
}


/** JWT Appwrite ; en développement sans session (compte démo), jeton de dev. */
async function sessionToken(): Promise<string> {
  const jwt = await getAppwriteJwt();
  if (jwt) return jwt;
  if (import.meta.env.DEV) return `dev:${getSessionUserIdSync() ?? 'dev-user-001'}`;
  throw new Error('session Appwrite requise pour la co-édition');
}

export interface CollabSessionHandle {
  /** Contrat du ProjectStore ; null tant que le document de la session n'est pas reçu. */
  link: ProjectCollabLink | null;
  /** État de la session (connexion, éditeurs présents, baux, modifications en attente). */
  state: CollabState | null;
}

const NO_SESSION: CollabSessionHandle = { link: null, state: null };

/**
 * Session du projet `projectId` si `shared` (ou forcée en dev), sinon aucune.
 * `getProjectSnapshot` : état courant du projet (en dev, il crée la salle d'un
 * projet que le serveur local ne connaît pas encore).
 */
export function useCollabSession(
  projectId: string | null,
  getProjectSnapshot: () => ItineraryProject | null,
  shared: boolean,
): CollabSessionHandle {
  const [handle, setHandle] = useState<CollabSessionHandle>(NO_SESSION);
  const getSnapshotRef = useRef(getProjectSnapshot);
  useEffect(() => {
    getSnapshotRef.current = getProjectSnapshot;
  }, [getProjectSnapshot]);
  const enabled = shared || isDevCollabForced();

  useEffect(() => {
    if (!projectId || !enabled) return;
    // Dès maintenant : l'autosave n'écrit plus le document partagé (le serveur
    // le fait), même avant la première connexion.
    const release = registerLiveSession(projectId);
    let active = true;
    let connection: CollabConnection | null = null;
    let unsubscribe: (() => void) | null = null;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if ((connection?.client.getState().unsynced ?? 0) === 0) return;
      // Modifications pas encore reçues par le serveur (hors ligne) : le navigateur demande confirmation.
      event.preventDefault();
    };

    void (async () => {
      const { CollabConnection: Connection } = await import('./client/connection');
      if (!active) return;
      const current = new Connection({
        url: multiplayerSocketUrl(),
        projectId,
        getToken: sessionToken,
        // Nom affiché aux autres éditeurs (pastilles de l'en-tête).
        presence: () => {
          const user = readStoredAppwriteSession()?.user;
          return { name: user?.name || user?.email || undefined };
        },
        seed: import.meta.env.DEV
          ? () => toProjectDocument(getSnapshotRef.current() ?? createDefaultProject())
          : undefined,
        onRejection: (rejection) => logger.projects.error('[collab] lot refusé par le serveur', rejection),
      });
      connection = current;
      const { client } = current;
      const sync = () => {
        if (!active) return;
        const state = client.getState();
        setHandle((previous) => {
          const link = state.ready ? client : previous.link;
          return previous.link === link && previous.state === state ? previous : { link, state };
        });
      };
      unsubscribe = client.subscribeState(sync);
      window.addEventListener('beforeunload', warnBeforeUnload);
      current.start();
      sync();
    })();

    return () => {
      active = false;
      unsubscribe?.();
      window.removeEventListener('beforeunload', warnBeforeUnload);
      connection?.stop();
      release();
      setHandle(NO_SESSION);
    };
  }, [enabled, projectId]);

  return handle;
}
