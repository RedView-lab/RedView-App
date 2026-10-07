import { useMemo } from 'react';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';

import { describeRedviewExportError } from '@/features/redviewFile/lib/messages';
import { notify } from '@/shared/lib/notify';
import {
  createProject,
  createProjectFolder,
  deleteProject,
  deleteProjectFitFiles,
  deleteProjectFolder,
  deleteProjectThumbnail,
  getProject,
  listProjectBrowserSnapshot,
  moveProjectFolder,
  moveProjectToFolder,
  renameProject,
  renameProjectFolder,
  type ProjectBrowserSnapshot,
} from '@/shared/services/projects';

import { duplicateProjectWithAssets } from '../lib/projects/duplicateProject';
import { importProjectFiles } from '../lib/projects/importProjects';
import { rowToSummary } from '../lib/projects/rowToSummary';
import {
  patchFolder,
  patchProject,
  prependFolder,
  prependProjects,
  projectNamesIn,
  removeFolder,
  removeProject,
} from './projectLibraryCache';

/**
 * Bibliothèque de projets de l'utilisateur (dossiers + projets) : requête et
 * mutations TanStack Query. Chaque mutation confirmée met la liste en cache à
 * jour (projectLibraryCache.ts) ; ses échecs sont signalés par le
 * MutationCache (toast), sauf celles qui gèrent leur retour (`silentError`).
 * Les variables d'une mutation portent l'`id` de l'élément concerné : la
 * liste des opérations en cours en découle (useProjectLibraryBusyIds).
 */
/** Liste + instant de sa dernière lecture serveur (inchangé par les mises à jour du cache). */
export type ProjectLibrarySnapshot = ProjectBrowserSnapshot & { fetchedAt: number };

export const projectLibraryKeys = {
  all: ['project-library'] as const,
  list: (userId: string | null) => ['project-library', 'list', userId ?? 'anonymous'] as const,
  mutation: (name: string) => ['project-library', 'mutation', name] as const,
};

export function useProjectLibrary(userId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: projectLibraryKeys.list(userId),
    queryFn: async (): Promise<ProjectLibrarySnapshot> => ({ ...(await listProjectBrowserSnapshot()), fetchedAt: Date.now() }),
    enabled,
    // Petite liste (≈ 8 Ko) modifiée depuis d'autres appareils : relue au retour sur l'onglet.
    refetchOnWindowFocus: true,
  });
}

/** Ids des projets et dossiers dont une opération est en cours. */
export function useProjectLibraryBusyIds(): Set<string> {
  const ids = useMutationState({
    filters: { mutationKey: projectLibraryKeys.all, status: 'pending' },
    select: (mutation) => (mutation.state.variables as { id?: unknown } | undefined)?.id,
  });
  const key = ids.filter((id): id is string => typeof id === 'string').join('\n');
  return useMemo(() => new Set(key ? key.split('\n') : []), [key]);
}

function useLibraryCache(userId: string | null) {
  const queryClient = useQueryClient();
  const queryKey = projectLibraryKeys.list(userId);
  return {
    read: () => queryClient.getQueryData<ProjectLibrarySnapshot>(queryKey),
    update: (updater: (snapshot: ProjectLibrarySnapshot | undefined) => ProjectLibrarySnapshot | undefined) =>
      queryClient.setQueryData<ProjectLibrarySnapshot>(queryKey, updater),
    invalidate: () => queryClient.invalidateQueries({ queryKey }),
  };
}

export function useCreateProject(userId: string | null) {
  const cache = useLibraryCache(userId);
  return useMutation({
    mutationKey: projectLibraryKeys.mutation('create-project'),
    // Toujours à la racine : l'utilisateur range ensuite le projet par glisser-déposer.
    mutationFn: () => createProject(undefined, undefined, null),
    onSuccess: (row) => cache.update((snapshot) => prependProjects(snapshot, [rowToSummary(row)])),
    meta: { errorMessage: 'Échec de la création du projet.' },
  });
}

export function useCreateFolder(userId: string | null) {
  const cache = useLibraryCache(userId);
  return useMutation({
    mutationKey: projectLibraryKeys.mutation('create-folder'),
    mutationFn: (parentFolderId: string | null) => createProjectFolder(undefined, parentFolderId),
    onSuccess: (folder) => cache.update((snapshot) => prependFolder(snapshot, folder)),
    meta: { errorMessage: 'Échec de la création du dossier.' },
  });
}

export function useRenameProject(userId: string | null) {
  const cache = useLibraryCache(userId);
  return useMutation({
    mutationKey: projectLibraryKeys.mutation('rename-project'),
    mutationFn: ({ id, name }: { id: string; name: string }) => renameProject(id, name),
    onSuccess: (_result, { id, name }) => cache.update((snapshot) => patchProject(snapshot, id, { name })),
    meta: { errorMessage: 'Échec du renommage.' },
  });
}

export function useDeleteProject(userId: string | null) {
  const cache = useLibraryCache(userId);
  return useMutation({
    mutationKey: projectLibraryKeys.mutation('delete-project'),
    mutationFn: async ({ id }: { id: string }) => {
      await deleteProject(id);
      // Stockage nettoyé au mieux, sans bloquer la suppression.
      void deleteProjectFitFiles(id);
      void deleteProjectThumbnail(id);
    },
    onSuccess: (_result, { id }) => cache.update((snapshot) => removeProject(snapshot, id)),
    meta: { errorMessage: 'Échec de la suppression.' },
  });
}

export function useRenameFolder(userId: string | null) {
  const cache = useLibraryCache(userId);
  return useMutation({
    mutationKey: projectLibraryKeys.mutation('rename-folder'),
    mutationFn: ({ id, name }: { id: string; name: string }) => renameProjectFolder(id, name),
    onSuccess: (_result, { id, name }) => cache.update((snapshot) => patchFolder(snapshot, id, { name })),
    meta: { errorMessage: 'Échec du renommage du dossier.' },
  });
}

export function useDeleteFolder(userId: string | null) {
  const cache = useLibraryCache(userId);
  return useMutation({
    mutationKey: projectLibraryKeys.mutation('delete-folder'),
    mutationFn: ({ id }: { id: string }) => deleteProjectFolder(id),
    onSuccess: (_result, { id }) => {
      cache.update((snapshot) => removeFolder(snapshot, id));
      // Le serveur détache les projets et sous-dossiers : relire la liste.
      void cache.invalidate();
    },
    meta: { errorMessage: 'Échec de la suppression du dossier.' },
  });
}

export function useMoveProject(userId: string | null) {
  const cache = useLibraryCache(userId);
  return useMutation({
    mutationKey: projectLibraryKeys.mutation('move-project'),
    mutationFn: ({ id, folderId }: { id: string; folderId: string | null }) => moveProjectToFolder(id, folderId),
    onSuccess: (_result, { id, folderId }) => {
      cache.update((snapshot) => patchProject(snapshot, id, { folderId }));
      notify.success(folderId ? 'Projet déplacé dans le dossier.' : 'Projet déplacé à la racine.');
    },
    meta: { errorMessage: 'Impossible de déplacer ce projet.' },
  });
}

export function useMoveFolder(userId: string | null) {
  const cache = useLibraryCache(userId);
  return useMutation({
    mutationKey: projectLibraryKeys.mutation('move-folder'),
    mutationFn: ({ id, parentFolderId }: { id: string; parentFolderId: string | null }) =>
      moveProjectFolder(id, parentFolderId),
    onSuccess: (_result, { id, parentFolderId }) => {
      cache.update((snapshot) => patchFolder(snapshot, id, { parentFolderId }));
      notify.success(parentFolderId ? 'Dossier déplacé.' : 'Dossier déplacé à la racine.');
    },
    meta: { errorMessage: 'Impossible de déplacer ce dossier.' },
  });
}

export function useDuplicateProject(userId: string | null) {
  const cache = useLibraryCache(userId);
  return useMutation({
    mutationKey: projectLibraryKeys.mutation('duplicate-project'),
    mutationFn: ({ id }: { id: string }) =>
      duplicateProjectWithAssets(id, (folderId) => projectNamesIn(cache.read(), folderId)),
    onSuccess: ({ row, name }) => {
      cache.update((snapshot) => prependProjects(snapshot, [rowToSummary(row)]));
      notify.success('Projet dupliqué: {{name}}', { name });
    },
    meta: { errorMessage: 'Impossible de dupliquer ce projet.' },
  });
}

/** Import de fichiers `.redview` : retour (toasts, ouverture) géré par l'appelant. */
export function useImportProjects(userId: string | null) {
  const cache = useLibraryCache(userId);
  return useMutation({
    mutationKey: projectLibraryKeys.mutation('import-projects'),
    mutationFn: ({ files, folderId }: { files: File[]; folderId: string | null }) =>
      importProjectFiles(files, { folderId, siblingNames: projectNamesIn(cache.read(), folderId) }),
    onSuccess: ({ imported }) => cache.update((snapshot) => prependProjects(snapshot, [...imported].reverse())),
    meta: { silentError: true },
  });
}

/** Télécharge un projet de la liste en fichier `.redview` (sans l'ouvrir). */
export function useExportProject() {
  return useMutation({
    mutationKey: projectLibraryKeys.mutation('export-project'),
    mutationFn: async ({ id }: { id: string }) => {
      const row = await getProject(id);
      if (!row) throw new Error('Project not found');
      // Writer (ZIP, FIT copies, thumbnail) loaded on use, off the initial load.
      const { exportProjectAsRedview } = await import('@/features/redviewFile/lib/exportProject');
      return exportProjectAsRedview({ project: row.data, projectId: id });
    },
    onSuccess: (result) => notify.success('Projet exporté : {{file}}', { file: result.fileName }),
    onError: (error, { id }) => {
      console.warn('[ProjectBrowser] export failed', id, error);
      notify.error(describeRedviewExportError(error));
    },
    meta: { silentError: true },
  });
}
