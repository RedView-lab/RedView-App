import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { markSharedProject, sharedProjectTeamId } from '@/shared/services/projects/liveSessions';
import {
  fetchProjectShare,
  inviteProjectEditor,
  leaveSharedProject,
  removeProjectEditor,
  type ProjectShareState,
} from '@/shared/services/projects/sharing';

import { projectLibraryKeys, type ProjectLibrarySnapshot } from './projectLibrary';
import { patchProject } from './projectLibraryCache';

/**
 * Partage d'un projet (membres, invitation, retrait, départ) : requête et
 * mutations TanStack Query. Un partage confirmé met aussi à jour la liste des
 * projets (pastille « Partagé », section « Partagés avec moi »).
 */
const projectShareKeys = {
  state: (projectId: string) => ['project-share', projectId] as const,
  mutation: (name: string) => [...projectLibraryKeys.all, 'share', name] as const,
};

export function useProjectShare(projectId: string | null) {
  return useQuery({
    queryKey: projectShareKeys.state(projectId ?? ''),
    queryFn: () => fetchProjectShare(projectId!),
    enabled: projectId !== null,
  });
}

function useShareCache(userId: string | null) {
  const queryClient = useQueryClient();
  return {
    setState: (state: ProjectShareState) => queryClient.setQueryData(projectShareKeys.state(state.projectId), state),
    updateLibrary: (updater: (snapshot: ProjectLibrarySnapshot | undefined) => ProjectLibrarySnapshot | undefined) =>
      queryClient.setQueryData<ProjectLibrarySnapshot>(projectLibraryKeys.list(userId), updater),
  };
}

export function useInviteProjectEditor(userId: string | null) {
  const cache = useShareCache(userId);
  return useMutation({
    mutationKey: projectShareKeys.mutation('invite'),
    // Message d'erreur affiché dans la fenêtre de partage (e-mail inconnu…).
    meta: { silentError: true },
    mutationFn: ({ id, email }: { id: string; email: string }) => inviteProjectEditor(id, email),
    onSuccess: (state) => {
      // Dès maintenant, ce client n'écrit plus le document au cloud (serveur temps réel).
      if (state.shared) {
        const owner = state.members.find((member) => member.role === 'owner')?.userId ?? null;
        markSharedProject(state.projectId, sharedProjectTeamId(state.projectId) ?? 'shared', owner);
      }
      cache.setState(state);
      cache.updateLibrary((snapshot) => patchProject(snapshot, state.projectId, { shared: state.shared }));
    },
  });
}

export function useRemoveProjectEditor(userId: string | null) {
  const cache = useShareCache(userId);
  return useMutation({
    mutationKey: projectShareKeys.mutation('remove'),
    mutationFn: ({ id, memberId }: { id: string; memberId: string }) => removeProjectEditor(id, memberId),
    onSuccess: (state) => {
      cache.setState(state);
      cache.updateLibrary((snapshot) => patchProject(snapshot, state.projectId, { shared: state.shared }));
    },
  });
}

export function useLeaveSharedProject(userId: string | null) {
  const cache = useShareCache(userId);
  return useMutation({
    mutationKey: projectShareKeys.mutation('leave'),
    mutationFn: ({ id }: { id: string }) => leaveSharedProject(id),
    onSuccess: (_result, { id }) => {
      cache.updateLibrary((snapshot) => (snapshot
        ? { ...snapshot, sharedProjects: snapshot.sharedProjects.filter((project) => project.id !== id) }
        : snapshot));
    },
  });
}
