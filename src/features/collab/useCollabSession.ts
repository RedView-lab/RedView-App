import { useEffect, useRef, useState } from 'react';

import type { ProjectCollabLink } from '@/features/itineraryPanel/context/ProjectStore/collab';
import { createDefaultProject } from '@/features/itineraryPanel/lib/project/defaultState';
import { toProjectDocument } from '@/features/itineraryPanel/lib/project/layers';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { getSessionUserIdSync } from '@/shared/services/appwrite';

/**
 * Co-édition de développement entre onglets du même navigateur : `?collab=local`
 * dans l'URL (gardé pour l'onglet) ou `localStorage['redview:dev-collab'] = 'local'`.
 * Jamais active hors `npm run dev` : le transport de production sera le
 * serveur temps réel. Yjs n'est chargé qu'à l'ouverture d'une session (import
 * dynamique) : rien de plus dans le bundle de l'application sans session.
 */
const DEV_COLLAB_KEY = 'redview:dev-collab';

function readUrlFlag(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  try {
    const param = new URLSearchParams(window.location.search).get('collab');
    if (param === null) return;
    if (param === 'local') window.sessionStorage.setItem(DEV_COLLAB_KEY, 'local');
    else window.sessionStorage.removeItem(DEV_COLLAB_KEY);
  } catch {
    // stockage indisponible : réglage ignoré
  }
}

// Lu au chargement : l'ouverture d'un projet remplace l'URL (et sa requête).
readUrlFlag();

export function isDevTabCollabEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return false;
  }
  try {
    return window.sessionStorage.getItem(DEV_COLLAB_KEY) === 'local'
      || window.localStorage.getItem(DEV_COLLAB_KEY) === 'local';
  } catch {
    return false;
  }
}

/**
 * Session de co-édition du projet ouvert, ou null (pas de session : seul sur
 * le projet). `getProjectSnapshot` : état courant du projet, semé si cet
 * onglet ouvre la session.
 */
export function useCollabSession(
  projectId: string | null,
  getProjectSnapshot: () => ItineraryProject | null,
): ProjectCollabLink | null {
  const [link, setLink] = useState<ProjectCollabLink | null>(null);
  const getSnapshotRef = useRef(getProjectSnapshot);
  useEffect(() => {
    getSnapshotRef.current = getProjectSnapshot;
  }, [getProjectSnapshot]);

  useEffect(() => {
    if (!projectId || !isDevTabCollabEnabled()) return;
    let active = true;
    let destroy: (() => void) | null = null;
    void (async () => {
      const [{ createCollabSession }, { broadcastChannelTransport }] = await Promise.all([
        import('./session'),
        import('./transports/broadcastChannel'),
      ]);
      if (!active) return;
      const session = createCollabSession({
        getSeedDocument: () => toProjectDocument(getSnapshotRef.current() ?? createDefaultProject()),
        transport: broadcastChannelTransport(`redview-collab:${projectId}`),
        user: { id: getSessionUserIdSync() },
      });
      destroy = session.destroy;
      await session.ready;
      if (!active) return;
      console.info('[collab] session entre onglets prête', {
        projectId,
        editors: session.awareness.getStates().size,
      });
      setLink(session.link);
    })();
    return () => {
      active = false;
      setLink(null);
      destroy?.();
    };
  }, [projectId]);

  return link;
}
