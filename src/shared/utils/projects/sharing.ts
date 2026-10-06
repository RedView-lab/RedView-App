import { translateAppText } from '@/shared/i18n';
import { getAppwriteJwt } from '@/shared/services/appwrite';

/**
 * Partage d'un projet (co-édition) : appels à `/api/projects/share`
 * (api/_lib/projectSharing.ts). Comptes RedView existants seulement, rôle
 * éditeur ; le propriétaire invite et retire, un éditeur peut quitter.
 */

export interface ProjectShareMember {
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'editor';
}

export interface ProjectShareState {
  projectId: string;
  isOwner: boolean;
  shared: boolean;
  members: ProjectShareMember[];
}

async function shareRequest<T>(body: Record<string, unknown>): Promise<T> {
  const send = async (fresh: boolean) => {
    const token = await getAppwriteJwt({ fresh });
    if (!token) throw new Error(translateAppText('Session expirée. Reconnectez-vous pour partager ce projet.'));
    return fetch('/api/projects/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  };
  let response = await send(false);
  // JWT réutilisé mais refusé (session renouvelée entre-temps) : un nouveau, une fois.
  if (response.status === 401) response = await send(true);
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(translateAppText(typeof data.error === 'string' ? data.error : 'Le partage du projet a échoué.'));
  }
  return data as T;
}

export function fetchProjectShare(projectId: string): Promise<ProjectShareState> {
  return shareRequest({ action: 'list', projectId });
}

export function inviteProjectEditor(projectId: string, email: string): Promise<ProjectShareState> {
  return shareRequest({ action: 'invite', projectId, email });
}

export function removeProjectEditor(projectId: string, userId: string): Promise<ProjectShareState> {
  return shareRequest({ action: 'remove', projectId, userId });
}

export async function leaveSharedProject(projectId: string): Promise<void> {
  await shareRequest({ action: 'leave', projectId });
}

/**
 * Supprime un projet partagé (propriétaire) côté serveur : ligne, équipe,
 * journal et points de sauvegarde de la co-édition (clé admin).
 */
export async function deleteSharedProjectOnServer(projectId: string): Promise<void> {
  await shareRequest({ action: 'delete', projectId });
}
