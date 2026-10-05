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
  const token = await getAppwriteJwt();
  if (!token) throw new Error(translateAppText('Session expirée. Reconnectez-vous pour partager ce projet.'));
  const response = await fetch('/api/projects/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
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
