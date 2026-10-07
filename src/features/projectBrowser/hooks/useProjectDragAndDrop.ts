import { useCallback, useState } from 'react';

import { translateAppText } from '@/shared/i18n';
import type { ProjectFolderSummary, ProjectSummary } from '@/shared/services/projects';

import { resolveDropAction, type DraggedBrowserItem } from '../lib/projects/dropAction';

type DragPreviewState = {
  type: 'project' | 'folder';
  label: string;
  x: number;
  y: number;
};

/**
 * Glisser-déposer des cartes projet / dossier (interne au gestionnaire ; le
 * dépôt de fichiers `.redview` est useFileDropImport). Le déplacement lui-même
 * est confié à `moveProject` / `moveFolder` (mutations).
 */
export function useProjectDragAndDrop({
  folders,
  projects,
  moveProject,
  moveFolder,
}: {
  folders: ProjectFolderSummary[];
  projects: ProjectSummary[];
  moveProject: (projectId: string, folderId: string | null) => Promise<void>;
  moveFolder: (folderId: string, parentFolderId: string | null) => Promise<void>;
}) {
  const [draggedItem, setDraggedItem] = useState<DraggedBrowserItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);

  const handleDragStart = useCallback(
    (item: DraggedBrowserItem, x = 0, y = 0) => {
      const label =
        item.type === 'project'
          ? projects.find((project) => project.id === item.id)?.name ?? translateAppText('Projet')
          : folders.find((folder) => folder.id === item.id)?.name ?? translateAppText('Dossier');
      setDraggedItem(item);
      setDropTarget(null);
      setDragPreview({ type: item.type, label, x, y });
    },
    [folders, projects],
  );

  const handleDragMove = useCallback((x: number, y: number) => {
    setDragPreview((previous) => (previous ? { ...previous, x, y } : previous));
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
    setDropTarget((previous) => (previous === targetId ? null : previous));
  }, []);

  const drop = useCallback(
    async (targetFolderId: string | null) => {
      setDropTarget(null);
      const action = resolveDropAction(draggedItem, targetFolderId, folders, projects);
      if (!action) return;
      if (action.kind === 'move-project') await moveProject(action.projectId, action.folderId);
      else await moveFolder(action.folderId, action.parentFolderId);
    },
    [draggedItem, folders, moveFolder, moveProject, projects],
  );

  const handleDropIntoFolder = useCallback((folderId: string) => drop(folderId), [drop]);
  const handleDropToRoot = useCallback(() => drop(null), [drop]);

  return {
    draggedItem,
    dropTarget,
    dragPreview,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    handleDragEnterTarget,
    handleDragLeaveTarget,
    handleDropIntoFolder,
    handleDropToRoot,
  };
}
