import { useCallback, useEffect, useState } from 'react';

import {
  createProjectFolder,
  createProject,
  deleteProject,
  deleteProjectFitFiles,
  deleteProjectFolder,
  deleteProjectThumbnail,
  getProjectThumbnailUrls,
  listProjectBrowserSnapshot,
  renameProjectFolder,
  renameProject,
  type ProjectFolderSummary,
  type ProjectSummary,
} from '@/shared/utils/projects';

import { buildFolderBreadcrumbs, computeFolderAggregateSize } from '../lib/tree';

export function useProjectBrowserProjects({
  open,
  onOpenProject,
}: {
  open: boolean;
  onOpenProject: (projectId: string) => void;
}) {
  const [folders, setFolders] = useState<ProjectFolderSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [creatingProject, setCreatingProject] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [showSearch, setShowSearch] = useState(false);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);

  const setBusy = useCallback((id: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await listProjectBrowserSnapshot();
      setFolders(snapshot.folders);
      setProjects(snapshot.projects);
      setCurrentFolderId((prev) =>
        prev && !snapshot.folders.some((folder) => folder.id === prev) ? null : prev,
      );
      if (snapshot.projects.length > 0) {
        getProjectThumbnailUrls(snapshot.projects.map((row) => row.id))
          .then((map) => setThumbnails(map))
          .catch((nextError) => console.warn('[ProjectBrowser] thumbnails failed', nextError));
      } else {
        setThumbnails({});
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Impossible de charger les projets.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const handleCreateProject = useCallback(async () => {
    if (creatingProject) return;
    setCreatingProject(true);
    setError(null);
    try {
      const row = await createProject(undefined, undefined, currentFolderId);
      setProjects((prev) => [
        {
          id: row.id,
          folderId: row.folder_id,
          name: row.name,
          privacy: row.privacy,
          sizeBytes: row.size_bytes,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
        ...prev,
      ]);
      onOpenProject(row.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Échec de la création du projet.');
    } finally {
      setCreatingProject(false);
    }
  }, [creatingProject, currentFolderId, onOpenProject]);

  const handleCreateFolder = useCallback(async () => {
    if (creatingFolder) return;
    setCreatingFolder(true);
    setError(null);
    try {
      const folder = await createProjectFolder(undefined, currentFolderId);
      setFolders((prev) => [folder, ...prev]);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Échec de la création du dossier.');
    } finally {
      setCreatingFolder(false);
    }
  }, [creatingFolder, currentFolderId]);

  const handleRename = useCallback(
    async (id: string, nextName: string) => {
      setBusy(id, true);
      try {
        await renameProject(id, nextName);
        setProjects((prev) =>
          prev.map((project) =>
            project.id === id
              ? { ...project, name: nextName, updatedAt: new Date().toISOString() }
              : project,
          ),
        );
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Échec du renommage.');
      } finally {
        setBusy(id, false);
      }
    },
    [setBusy],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setBusy(id, true);
      try {
        await deleteProject(id);
        void deleteProjectFitFiles(id);
        void deleteProjectThumbnail(id);
        setProjects((prev) => prev.filter((project) => project.id !== id));
        setThumbnails((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Échec de la suppression.');
      } finally {
        setBusy(id, false);
      }
    },
    [setBusy],
  );

  const handleRenameFolder = useCallback(
    async (id: string, nextName: string) => {
      setBusy(id, true);
      try {
        await renameProjectFolder(id, nextName);
        setFolders((prev) =>
          prev.map((folder) =>
            folder.id === id
              ? { ...folder, name: nextName, updatedAt: new Date().toISOString() }
              : folder,
          ),
        );
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Échec du renommage du dossier.');
      } finally {
        setBusy(id, false);
      }
    },
    [setBusy],
  );

  const handleDeleteFolder = useCallback(
    async (id: string) => {
      setBusy(id, true);
      try {
        await deleteProjectFolder(id);
        setFolders((prev) => prev.filter((folder) => folder.id !== id));
        setCurrentFolderId((prev) => (prev === id ? null : prev));
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Échec de la suppression du dossier.');
      } finally {
        setBusy(id, false);
      }
    },
    [setBusy],
  );

  const handleOpenFolder = useCallback((folderId: string) => {
    setCurrentFolderId(folderId);
  }, []);

  const handleNavigateToFolder = useCallback((folderId: string | null) => {
    setCurrentFolderId(folderId);
  }, []);

  const q = search.trim().toLowerCase();
  const breadcrumbs = buildFolderBreadcrumbs(folders, currentFolderId);
  const visibleFoldersBase = folders.filter((folder) => folder.parentFolderId === currentFolderId);
  const visibleProjectsBase = projects.filter((project) => project.folderId === currentFolderId);
  const visibleFolders = (q
    ? visibleFoldersBase.filter((folder) => folder.name.toLowerCase().includes(q))
    : visibleFoldersBase
  ).map((folder) => ({
    ...folder,
    aggregateSizeBytes: computeFolderAggregateSize(folder.id, folders, projects),
  }));
  const visibleProjects = q
    ? visibleProjectsBase.filter((project) => project.name.toLowerCase().includes(q))
    : visibleProjectsBase;

  return {
    folders,
    projects,
    thumbnails,
    loading,
    error,
    busyIds,
    creatingProject,
    creatingFolder,
    search,
    setSearch,
    view,
    setView,
    showSearch,
    setShowSearch,
    currentFolderId,
    breadcrumbs,
    refresh,
    handleCreateProject,
    handleCreateFolder,
    handleRenameProject: handleRename,
    handleDeleteProject: handleDelete,
    handleRenameFolder,
    handleDeleteFolder,
    handleOpenFolder,
    handleNavigateToFolder,
    q,
    visibleFolders,
    visibleProjects,
  };
}