import { useEffect, useRef, useState } from 'react';

import type { ProjectCollabLink } from '@/features/itineraryPanel/context/ProjectStore/collab';
import { createDefaultProject } from '@/features/itineraryPanel/lib/project/defaultState';
import { toProjectDocument } from '@/features/itineraryPanel/lib/project/layers';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { countBucket, trackAnalyticsEvent } from '@/shared/lib/analytics';
import { logger } from '@/shared/lib/logger';
import { getAppwriteJwt, getSessionUserIdSync, readStoredAppwriteSession } from '@/shared/services/appwrite';
import { notify } from '@/shared/lib/notify';
import { registerLiveSession } from '@/shared/services/projects/liveSessions';

import type { CollabState } from './client/collabClient';
import type { CollabSession } from './client/session';
import { multiplayerSocketUrl } from './queries/multiplayerHealth';
import type { CollabRealtime } from './realtime';

/**
 * Session de co-édition du projet ouvert : connexion au serveur temps réel
 * (server/multiplayer) pour un projet partagé. Le moteur n'est chargé qu'à
 * l'ouverture d'une session (import dynamique) : rien de plus dans le bundle
 * d'un projet solo.
 *
 * Le lien est donné au ProjectStore dès que la session existe, avant l'état
 * du serveur : le store s'y branche, la connexion s'ouvre, et ce qui est
 * modifié pendant ce temps part avec la session. Tant que la session se
 * prépare (`pending`), le store ne calcule rien sur le document d'ouverture.
 *
 * Développement : `?collab=server` dans l'URL (gardé pour l'onglet) ou
 * `localStorage['redview:dev-collab'] = 'server'` ouvre une session pour
 * n'importe quel projet (serveur local lancé par `npm run dev`, projet créé
 * côté serveur à partir du document de ce client). `?devUser=<id>` (gardé
 * pour l'onglet) fait de l'onglet un autre utilisateur du serveur de dev
 * (jeton `dev:<id>`, auteur des commentaires) : deux onglets, deux personnes.
 */
const DEV_COLLAB_KEY = 'redview:dev-collab';
const DEV_COLLAB_VALUE = 'server';
const DEV_USER_KEY = 'redview:dev-user';
/** Ids acceptés par l'authentification de dev du serveur (server/multiplayer/auth.ts). */
const DEV_USER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function readUrlFlag(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  try {
    const params = new URLSearchParams(window.location.search);
    const param = params.get('collab');
    if (param === DEV_COLLAB_VALUE) window.sessionStorage.setItem(DEV_COLLAB_KEY, DEV_COLLAB_VALUE);
    else if (param !== null) window.sessionStorage.removeItem(DEV_COLLAB_KEY);
    const devUser = params.get('devUser');
    if (devUser && DEV_USER_PATTERN.test(devUser)) window.sessionStorage.setItem(DEV_USER_KEY, devUser);
    else if (devUser !== null) window.sessionStorage.removeItem(DEV_USER_KEY);
  } catch {
    // stockage indisponible : réglage ignoré
  }
}

/** Développement sans session Appwrite : utilisateur de l'onglet (`?devUser=<id>`), sinon null. */
export function devTabUserId(): string | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(DEV_USER_KEY);
  } catch {
    return null;
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

/**
 * Utilisateur des jetons de développement sans session Appwrite (compte démo) :
 * aussi l'auteur des commentaires dans ce cas (features/comments), pour que le
 * serveur de dev reconnaisse ses fils.
 */
export const DEV_USER_ID = 'dev-user-001';

/** JWT Appwrite (réutilisé tant qu'il est frais) ; en développement sans session (compte démo), jeton de dev. */
async function sessionToken({ fresh = false }: { fresh?: boolean } = {}): Promise<string> {
  const jwt = await getAppwriteJwt({ fresh });
  if (jwt) return jwt;
  if (import.meta.env.DEV) return `dev:${getSessionUserIdSync() ?? devTabUserId() ?? DEV_USER_ID}`;
  throw new Error('session Appwrite requise pour la co-édition');
}

export interface CollabSessionHandle {
  /** Contrat du ProjectStore ; null tant que la session n'est pas créée. */
  link: ProjectCollabLink | null;
  /** État de la session (connexion, éditeurs présents, baux, modifications en attente). */
  state: CollabState | null;
  /** Session attendue mais pas encore créée (module en chargement). */
  pending: boolean;
  /** Présence en direct (curseurs, suivre un éditeur) ; null sans session. */
  realtime: CollabRealtime | null;
}

interface SessionSnapshot {
  /** Projet de la session : au rendu qui suit un changement de projet, l'ancienne n'est jamais donnée. */
  projectId: string | null;
  link: ProjectCollabLink | null;
  state: CollabState | null;
  realtime: CollabRealtime | null;
  failed: boolean;
}

const NO_SESSION: SessionSnapshot = { projectId: null, link: null, state: null, realtime: null, failed: false };

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
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(NO_SESSION);
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
    let session: CollabSession | null = null;
    let unsubscribe: (() => void) | null = null;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      // Modifications que ni le serveur ni la copie de l'appareil n'ont encore : le navigateur demande confirmation.
      if (session?.hasUnprotectedChanges()) event.preventDefault();
    };

    void (async () => {
      const { CollabSession: Session } = await import('./client/session');
      if (!active) return;
      const created = await Session.start({
        url: multiplayerSocketUrl(),
        projectId,
        userId: getSessionUserIdSync() ?? devTabUserId() ?? DEV_USER_ID,
        getToken: sessionToken,
        // Nom affiché aux autres éditeurs (pastilles de l'en-tête).
        presence: () => {
          const user = readStoredAppwriteSession()?.user;
          return { name: user?.name || user?.email || devTabUserId() || undefined };
        },
        seed: import.meta.env.DEV
          ? () => toProjectDocument(getSnapshotRef.current() ?? createDefaultProject())
          : undefined,
        onRejection: (rejection) => {
          logger.projects.error('[collab] lot refusé par le serveur', rejection);
          // Salle pleine (serveur, roomState.ts) : la modification est perdue, l'utilisateur doit le savoir.
          if (rejection.reason === 'room-too-large') notify.error('Projet partagé trop volumineux : modification non enregistrée.');
        },
      });
      if (!active) {
        void created.stop();
        return;
      }
      session = created;
      const { client } = created;
      let joinTracked = false;
      const sync = () => {
        if (!active) return;
        const state = client.getState();
        if (!joinTracked && state.status === 'online') {
          joinTracked = true;
          trackAnalyticsEvent({ name: 'collab_session_joined', data: { peers: countBucket(state.peers.length) } });
        }
        // Accès retiré ou projet supprimé : plus rien ne pourra être envoyé.
        if (state.status === 'denied' && (state.deniedReason === 'forbidden' || state.deniedReason === 'not-found')) {
          created.discardUnsynced();
        }
        setSnapshot((previous) => (previous.link === client && previous.state === state
          ? previous
          : { projectId, link: client, state, realtime: created.connection, failed: false }));
      };
      unsubscribe = client.subscribeState(sync);
      window.addEventListener('beforeunload', warnBeforeUnload);
      sync();
    })().catch((error: unknown) => {
      logger.projects.error('[collab] session de co-édition impossible', error);
      if (active) setSnapshot({ projectId, link: null, state: null, realtime: null, failed: true });
    });

    return () => {
      active = false;
      unsubscribe?.();
      window.removeEventListener('beforeunload', warnBeforeUnload);
      void session?.stop();
      release();
      setSnapshot(NO_SESSION);
    };
  }, [enabled, projectId]);

  const current = enabled && projectId !== null && snapshot.projectId === projectId ? snapshot : NO_SESSION;
  return {
    link: current.link,
    state: current.state,
    pending: enabled && projectId !== null && current.link === null && !current.failed,
    realtime: current.realtime,
  };
}
