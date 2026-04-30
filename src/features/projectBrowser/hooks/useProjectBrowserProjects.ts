import { useCallback, useEffect, useState } from 'react';

import {
  createProject,
  deleteProject,
  deleteProjectFitFiles,
  deleteProjectThumbnail,
  getProjectThumbnailUrls,
  listProjects,
  renameProject,
  type ProjectSummary,
} from '@/shared/utils/projects';

export function useProjectBrowserProjects({
  open,
  onOpenProject,
}: {
  open: boolean;
  onOpenProject: (projectId: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [showSearch, setShowSearch] = useState(false);

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
      const rows = await listProjects();
      setProjects(rows);
      if (rows.length > 0) {
        getProjectThumbnailUrls(rows.map((row) => row.id))
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

  const handleCreate = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const row = await createProject();
      setProjects((prev) => [
        {
          id: row.id,
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
      setCreating(false);
    }
  }, [creating, onOpenProject]);

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

  const q = search.trim().toLowerCase();
  const filtered = q
    ? projects.filter((project) => project.name.toLowerCase().includes(q))
    : projects;

  return {
    projects,
    thumbnails,
    loading,
    error,
    busyIds,
    creating,
    search,
    setSearch,
    view,
    setView,
    showSearch,
    setShowSearch,
    refresh,
    handleCreate,
    handleRename,
    handleDelete,
    q,
    filtered,
  };
}