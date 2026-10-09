import type { ProjectCloudErrorKind } from './errors';

/**
 * État de synchronisation cloud du projet ouvert (autosave), lu par
 * l'indicateur d'enregistrement de l'en-tête du panneau itinéraire.
 *  - saving : envoi en cours
 *  - saved : dernière modification confirmée par le cloud
 *  - pending-offline : cloud injoignable, modifications conservées localement,
 *    nouvel essai automatique (backoff) et au retour du réseau
 *  - error : refus non réessayable automatiquement (trop gros, conflit,
 *    supprimé, session expirée…) ; `message` est le texte source à traduire
 *
 * `localCopyLost` : la copie locale a aussi échoué (stockage plein) — les
 * modifications n'existent qu'en mémoire (toast, fermeture retenue).
 */
export type ProjectSyncState = 'idle' | 'saving' | 'saved' | 'pending-offline' | 'error';

export interface ProjectSyncStatus {
  projectId: string | null;
  state: ProjectSyncState;
  errorKind?: ProjectCloudErrorKind;
  message?: string;
  localCopyLost?: boolean;
}

let current: ProjectSyncStatus = { projectId: null, state: 'idle' };
const listeners = new Set<() => void>();

export function getProjectSyncStatus(): ProjectSyncStatus {
  return current;
}

export function setProjectSyncStatus(next: ProjectSyncStatus): void {
  if (
    current.projectId === next.projectId
    && current.state === next.state
    && current.errorKind === next.errorKind
    && current.message === next.message
    && current.localCopyLost === next.localCopyLost
  ) {
    return;
  }
  current = next;
  for (const listener of [...listeners]) listener();
}

export function subscribeProjectSyncStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
