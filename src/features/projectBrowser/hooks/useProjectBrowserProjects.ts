import { useCallback, useMemo, useState } from 'react';

import { translateAppText } from '@/shared/i18n';
import { readStoredAppwriteSession } from '@/shared/services/appwrite';
import { notify } from '@/shared/ui/notify';
import type { ProjectFolderSummary, ProjectSummary } from '@/shared/utils/projects';

import {
  useCreateFolder,
  useCreateProject,
  useDeleteFolder,
  useDeleteProject,
  useDuplicateProject,
  useExportProject,
  useImportProjects,
  useMoveFolder,
  useMoveProject,
  useProjectLibrary,
  useProjectLibraryBusyIds,
  useRenameFolder,
  useRenameProject,
} from '../queries/projectLibrary';
import { useLeaveSharedProject } from '../queries/projectSharing';
import { useFolderNavigation } from './useFolderNavigation';
import { useProjectDragAndDrop } from './useProjectDragAndDrop';
import { useProjectThumbnails } from './useProjectThumbnails';

const EMPTY_FOLDERS: ProjectFolderSummary[] = [];
const EMPTY_PROJECTS: ProjectSummary[] = [];

/** Une mutation en échec est déjà signalée (toast du MutationCache) : l'appelant s'arrête là. */
const ignoreHandledFailure = () => undefined;

/**
 * Onglet « Projets » du gestionnaire : compose les données (TanStack Query,
 * queries/projectLibrary.ts), la navigation dans les dossiers, les miniatures
 * et le glisser-déposer. Les retours utilisateur passent par des toasts
 * (`notify`) ; le bandeau d'erreur ne montre que l'échec de chargement de la
 * liste et le détail d'un import partiellement raté.
 */
export function useProjectBrowserProjects({
  open,
  onOpenProject,
}: {
  open: boolean;
  onOpenProject: (projectId: string) => void;
}) {
  const userId = readStoredAppwriteSession()?.user.id ?? null;
  const library = useProjectLibrary(userId, open);
  const folders = library.data?.folders ?? EMPTY_FOLDERS;
  const projects = library.data?.projects ?? EMPTY_PROJECTS;
  const sharedProjects = library.data?.sharedProjects ?? EMPTY_PROJECTS;
  const projectIds = useMemo(
    () => [...projects, ...sharedProjects].map((project) => project.id),
    [projects, sharedProjects],
  );

  const navigation = useFolderNavigation(folders, projects);
  const { thumbnails, thumbnailLoadingIds } = useProjectThumbnails(userId, projectIds, library.data?.fetchedAt ?? 0);
  const busyIds = useProjectLibraryBusyIds();
  const [importError, setImportError] = useState<string | null>(null);

  const { mutateAsync: createProject, isPending: creatingProject } = useCreateProject(userId);
  const { mutateAsync: createFolder, isPending: creatingFolder } = useCreateFolder(userId);
  const { mutateAsync: importProjects, isPending: importingProject } = useImportProjects(userId);
  const { mutateAsync: exportProject } = useExportProject();
  const { mutateAsync: renameProject } = useRenameProject(userId);
  const { mutateAsync: deleteProject } = useDeleteProject(userId);
  const { mutateAsync: renameFolder } = useRenameFolder(userId);
  const { mutateAsync: deleteFolder } = useDeleteFolder(userId);
  const { mutateAsync: duplicateProject } = useDuplicateProject(userId);
  const { mutateAsync: moveProjectMutation } = useMoveProject(userId);
  const { mutateAsync: moveFolderMutation } = useMoveFolder(userId);
  const { mutateAsync: leaveProject } = useLeaveSharedProject(userId);

  const handleCreateProject = useCallback(async () => {
    if (creatingProject) return;
    const row = await createProject().catch(ignoreHandledFailure);
    if (row) onOpenProject(row.id);
  }, [createProject, creatingProject, onOpenProject]);

  const { currentFolderId } = navigation;
  const handleCreateFolder = useCallback(async () => {
    if (creatingFolder) return;
    await createFolder(currentFolderId).catch(ignoreHandledFailure);
  }, [createFolder, creatingFolder, currentFolderId]);

  /**
   * Importe des fichiers `.redview` dans le dossier affiché, chacun comme un
   * nouveau projet. Un seul fichier importé : il s'ouvre, comme un projet créé.
   */
  const handleImportProjects = useCallback(
    async (files: File[]) => {
      if (importingProject || files.length === 0) return;
      setImportError(null);
      const result = await importProjects({ files, folderId: currentFolderId }).catch((error: unknown) => {
        const message = error instanceof Error && error.message ? error.message : 'Une erreur est survenue.';
        setImportError(translateAppText(message));
        notify.error(message);
        return null;
      });
      if (!result) return;
      const { imported, failures } = result;
      if (failures.length > 0) {
        setImportError(failures.join(' · '));
        if (imported.length > 0) {
          notify.error('{{imported}} projet(s) importé(s), {{failed}} échec(s).', {
            imported: imported.length,
            failed: failures.length,
          });
        } else {
          notify.error(failures[0]!);
        }
        return;
      }
      if (imported.length === 1) {
        notify.success('Projet importé : {{name}}', { name: imported[0]!.name });
        onOpenProject(imported[0]!.id);
        return;
      }
      notify.success('{{count}} projets importés.', { count: imported.length });
    },
    [currentFolderId, importProjects, importingProject, onOpenProject],
  );

  const handleExportProject = useCallback(
    async (projectId: string) => {
      await exportProject({ id: projectId }).catch(ignoreHandledFailure);
    },
    [exportProject],
  );

  const handleRenameProject = useCallback(
    async (id: string, name: string) => {
      await renameProject({ id, name }).catch(ignoreHandledFailure);
    },
    [renameProject],
  );

  const handleDeleteProject = useCallback(
    async (id: string) => {
      await deleteProject({ id }).catch(ignoreHandledFailure);
    },
    [deleteProject],
  );

  const handleRenameFolder = useCallback(
    async (id: string, name: string) => {
      await renameFolder({ id, name }).catch(ignoreHandledFailure);
    },
    [renameFolder],
  );

  const handleDeleteFolder = useCallback(
    async (id: string) => {
      await deleteFolder({ id }).catch(ignoreHandledFailure);
    },
    [deleteFolder],
  );

  const handleDuplicateProject = useCallback(
    async (projectId: string) => {
      await duplicateProject({ id: projectId }).catch(ignoreHandledFailure);
    },
    [duplicateProject],
  );

  const handleMoveProject = useCallback(
    async (projectId: string, folderId: string | null) => {
      await moveProjectMutation({ id: projectId, folderId }).catch(ignoreHandledFailure);
    },
    [moveProjectMutation],
  );

  const handleMoveFolder = useCallback(
    async (folderId: string, parentFolderId: string | null) => {
      await moveFolderMutation({ id: folderId, parentFolderId }).catch(ignoreHandledFailure);
    },
    [moveFolderMutation],
  );

  const handleLeaveProject = useCallback(
    async (projectId: string) => {
      await leaveProject({ id: projectId }).catch(ignoreHandledFailure);
    },
    [leaveProject],
  );

  const dragAndDrop = useProjectDragAndDrop({
    folders,
    projects,
    moveProject: handleMoveProject,
    moveFolder: handleMoveFolder,
  });

  const listError = library.error
    ? translateAppText(library.error.message || 'Impossible de charger les projets.')
    : null;

  return {
    folders,
    projects,
    sharedProjects,
    userId,
    thumbnails,
    thumbnailLoadingIds,
    loading: library.isFetching,
    error: listError ?? importError,
    busyIds,
    creatingProject,
    creatingFolder,
    importingProject,
    search: navigation.search,
    setSearch: navigation.setSearch,
    view: navigation.view,
    setView: navigation.setView,
    showSearch: navigation.showSearch,
    setShowSearch: navigation.setShowSearch,
    currentFolderId,
    breadcrumbs: navigation.breadcrumbs,
    ...dragAndDrop,
    refresh: library.refetch,
    handleCreateProject,
    handleCreateFolder,
    handleImportProjects,
    handleExportProject,
    handleRenameProject,
    handleDeleteProject,
    handleRenameFolder,
    handleDeleteFolder,
    handleDuplicateProject,
    handleLeaveProject,
    handleMoveProject,
    handleMoveFolder,
    handleOpenFolder: navigation.navigateToFolder,
    handleNavigateToFolder: navigation.navigateToFolder,
    q: navigation.q,
    visibleFolders: navigation.visibleFolders,
    visibleProjects: navigation.visibleProjects,
  };
}
