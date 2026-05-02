import { useCallback, useEffect, useState } from 'react';

import {
  createProjectFolder,
  createProject,
  deleteProject,
  deleteProjectFitFiles,
  deleteProjectFolder,
  deleteProjectThumbnail,
  duplicateProjectItineraryFitFiles,
  duplicateProjectThumbnail,
  getProject,
  getProjectThumbnailUrls,
  listProjectBrowserSnapshot,
  moveProjectFolder,
  moveProjectToFolder,
  renameProjectFolder,
  renameProject,
  saveProject,
  type ProjectFolderSummary,
  type ProjectSummary,
} from '@/shared/utils/projects';

import { buildCopiedName, buildFolderBreadcrumbs, computeFolderAggregateSize } from '../lib';

type BrowserToast = {
  kind: 'success' | 'error' | 'info';
  message: string;
};

type DragPreviewState = {
  type: 'project' | 'folder';
  label: string;
  x: number;
  y: number;
};

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
  const [draggedItem, setDraggedItem] = useState<
    | { type: 'project'; id: string }
    | { type: 'folder'; id: string }
    | null
  >(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
  const [toast, setToast] = useState<BrowserToast | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const showToast = useCallback((message: string, kind: BrowserToast['kind'] = 'success') => {
    setToast({ kind, message });
  }, []);

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
      const message = nextError instanceof Error ? nextError.message : 'Impossible de charger les projets.';
      setError(message);
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
      const message = nextError instanceof Error ? nextError.message : 'Échec de la création du projet.';
      setError(message);
      showToast(message, 'error');
    } finally {
      setCreatingProject(false);
    }
  }, [creatingProject, currentFolderId, onOpenProject, showToast]);

  const handleCreateFolder = useCallback(async () => {
    if (creatingFolder) return;
    setCreatingFolder(true);
    setError(null);
    try {
      const folder = await createProjectFolder(undefined, currentFolderId);
      setFolders((prev) => [folder, ...prev]);
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : 'Échec de la création du dossier.';
      setError(message);
      showToast(message, 'error');
    } finally {
      setCreatingFolder(false);
    }
  }, [creatingFolder, currentFolderId, showToast]);

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
        const message = nextError instanceof Error ? nextError.message : 'Échec du renommage.';
        setError(message);
        showToast(message, 'error');
      } finally {
        setBusy(id, false);
      }
    },
    [setBusy, showToast],
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
        const message = nextError instanceof Error ? nextError.message : 'Échec de la suppression.';
        setError(message);
        showToast(message, 'error');
      } finally {
        setBusy(id, false);
      }
    },
    [setBusy, showToast],
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
        const message =
          nextError instanceof Error ? nextError.message : 'Échec du renommage du dossier.';
        setError(message);
        showToast(message, 'error');
      } finally {
        setBusy(id, false);
      }
    },
    [setBusy, showToast],
  );

  const handleDeleteFolder = useCallback(
    async (id: string) => {
      setBusy(id, true);
      try {
        await deleteProjectFolder(id);
        setFolders((prev) => prev.filter((folder) => folder.id !== id));
        setCurrentFolderId((prev) => (prev === id ? null : prev));
      } catch (nextError) {
        const message =
          nextError instanceof Error ? nextError.message : 'Échec de la suppression du dossier.';
        setError(message);
        showToast(message, 'error');
      } finally {
        setBusy(id, false);
      }
    },
    [setBusy, showToast],
  );

  const handleOpenFolder = useCallback((folderId: string) => {
    setCurrentFolderId(folderId);
  }, []);

  const handleNavigateToFolder = useCallback((folderId: string | null) => {
    setCurrentFolderId(folderId);
  }, []);

  const handleMoveProject = useCallback(
    async (projectId: string, folderId: string | null) => {
      setBusy(projectId, true);
      setError(null);
      try {
        await moveProjectToFolder(projectId, folderId);
        setProjects((prev) =>
          prev.map((project) =>
            project.id === projectId
              ? { ...project, folderId, updatedAt: new Date().toISOString() }
              : project,
          ),
        );
        showToast(folderId ? 'Projet déplacé dans le dossier.' : 'Projet déplacé à la racine.');
      } catch (nextError) {
        const message =
          nextError instanceof Error ? nextError.message : 'Impossible de déplacer ce projet.';
        setError(message);
        showToast(message, 'error');
      } finally {
        setBusy(projectId, false);
      }
    },
    [setBusy, showToast],
  );

  const handleMoveFolder = useCallback(
    async (folderId: string, parentFolderId: string | null) => {
      setBusy(folderId, true);
      setError(null);
      try {
        await moveProjectFolder(folderId, parentFolderId);
        setFolders((prev) =>
          prev.map((folder) =>
            folder.id === folderId
              ? { ...folder, parentFolderId, updatedAt: new Date().toISOString() }
              : folder,
          ),
        );
        setCurrentFolderId((prev) => (prev === folderId && parentFolderId === folderId ? null : prev));
        showToast(parentFolderId ? 'Dossier déplacé.' : 'Dossier déplacé à la racine.');
      } catch (nextError) {
        const message =
          nextError instanceof Error ? nextError.message : 'Impossible de déplacer ce dossier.';
        setError(message);
        showToast(message, 'error');
      } finally {
        setBusy(folderId, false);
      }
    },
    [setBusy, showToast],
  );

  const handleDuplicateProject = useCallback(
    async (projectId: string) => {
      setBusy(projectId, true);
      setError(null);
      let duplicateProjectId: string | null = null;
      try {
        const source = await getProject(projectId);
        if (!source) throw new Error('Projet introuvable.');

        const siblingNames = projects
          .filter((project) => project.folderId === source.folder_id)
          .map((project) => project.name);
        const duplicateName = buildCopiedName(source.name, siblingNames);
        const duplicateData = structuredClone(source.data);
        duplicateData.name = duplicateName;
        duplicateData.privacy = source.privacy;
        duplicateData.savedAt = null;
        duplicateData.sizeBytes = null;

        const row = await createProject(duplicateName, duplicateData, source.folder_id);
        duplicateProjectId = row.id;

        const duplicateFitUploads = await duplicateProjectItineraryFitFiles(
          duplicateData.itineraries.map((itinerary) => ({
            id: itinerary.id,
            fitUploads: itinerary.fitUploads,
          })),
          row.id,
        );
        const nextDuplicateData = {
          ...duplicateData,
          itineraries: duplicateData.itineraries.map((itinerary) => ({
            ...itinerary,
            fitUploads: duplicateFitUploads[itinerary.id] ?? itinerary.fitUploads,
          })),
        };

        await saveProject(row.id, nextDuplicateData);
        const thumbnailCopied = await duplicateProjectThumbnail(projectId, row.id);
        const nextThumbnailUrls = thumbnailCopied ? await getProjectThumbnailUrls([row.id]) : {};

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
        if (thumbnailCopied) {
          setThumbnails((prev) => ({
            ...prev,
            [row.id]: nextThumbnailUrls[row.id] ?? null,
          }));
        }
        showToast(`Projet dupliqué: ${duplicateName}`);
      } catch (nextError) {
        if (duplicateProjectId) {
          try {
            await deleteProject(duplicateProjectId);
          } catch {
            // Best effort rollback; storage cleanup still runs below.
          }
          await Promise.allSettled([
            deleteProjectFitFiles(duplicateProjectId),
            deleteProjectThumbnail(duplicateProjectId),
          ]);
        }
        const message = nextError instanceof Error ? nextError.message : 'Impossible de dupliquer ce projet.';
        setError(message);
        showToast(message, 'error');
      } finally {
        setBusy(projectId, false);
      }
    },
    [projects, setBusy, showToast],
  );

  const handleDragStart = useCallback((item: { type: 'project' | 'folder'; id: string }, x = 0, y = 0) => {
    const label =
      item.type === 'project'
        ? projects.find((project) => project.id === item.id)?.name ?? 'Projet'
        : folders.find((folder) => folder.id === item.id)?.name ?? 'Dossier';
    setDraggedItem(item);
    setDropTarget(null);
    setDragPreview({ type: item.type, label, x, y });
  }, [folders, projects]);

  const handleDragMove = useCallback((x: number, y: number) => {
    setDragPreview((prev) => (prev ? { ...prev, x, y } : prev));
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedItem(null);
    setDropTarget(null);
    setDragPreview(null);
  }, []);

  const handleDragEnterTarget = useCallback((targetId: string) => {
    setDropTarget(targetId);
  }, []);

  const handleDragLeaveTarget = useCallback((targetId: string) => {
    setDropTarget((prev) => (prev === targetId ? null : prev));
  }, []);

  const handleDropIntoFolder = useCallback(
    async (folderId: string) => {
      if (!draggedItem) return;
      setDropTarget(null);
      if (draggedItem.type === 'project') {
        const project = projects.find((entry) => entry.id === draggedItem.id);
        if (!project || project.folderId === folderId) return;
        await handleMoveProject(draggedItem.id, folderId);
        return;
      }

      const folder = folders.find((entry) => entry.id === draggedItem.id);
      if (!folder || folder.id === folderId || folder.parentFolderId === folderId) return;
      await handleMoveFolder(draggedItem.id, folderId);
    },
    [draggedItem, folders, handleMoveFolder, handleMoveProject, projects],
  );

  const handleDropToRoot = useCallback(async () => {
    if (!draggedItem) return;
    setDropTarget(null);
    if (draggedItem.type === 'project') {
      const project = projects.find((entry) => entry.id === draggedItem.id);
      if (!project || project.folderId == null) return;
      await handleMoveProject(draggedItem.id, null);
      return;
    }

    const folder = folders.find((entry) => entry.id === draggedItem.id);
    if (!folder || folder.parentFolderId == null) return;
    await handleMoveFolder(draggedItem.id, null);
  }, [draggedItem, folders, handleMoveFolder, handleMoveProject, projects]);

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
    draggedItem,
    dropTarget,
    dragPreview,
    toast,
    refresh,
    handleCreateProject,
    handleCreateFolder,
    handleRenameProject: handleRename,
    handleDeleteProject: handleDelete,
    handleRenameFolder,
    handleDeleteFolder,
    handleDuplicateProject,
    handleMoveProject,
    handleMoveFolder,
    handleOpenFolder,
    handleNavigateToFolder,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    handleDragEnterTarget,
    handleDragLeaveTarget,
    handleDropIntoFolder,
    handleDropToRoot,
    q,
    visibleFolders,
    visibleProjects,
  };
}