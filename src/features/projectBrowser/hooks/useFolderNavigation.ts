import { useMemo, useState } from 'react';

import type { ProjectFolderSummary, ProjectSummary } from '@/shared/services/projects';

import { buildFolderBreadcrumbs } from '../lib/projects/tree';
import { resolveCurrentFolderId, selectVisibleItems } from '../lib/projects/visibility';

/** Dossier courant, recherche et mode d'affichage du gestionnaire de projets. */
export function useFolderNavigation(folders: ProjectFolderSummary[], projects: ProjectSummary[]) {
  const [requestedFolderId, setRequestedFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [view, setView] = useState<'grid' | 'list'>('grid');

  // Dossier supprimé ou déplacé ailleurs : retour à la racine, sans effet à synchroniser.
  const currentFolderId = resolveCurrentFolderId(folders, requestedFolderId);
  const breadcrumbs = useMemo(() => buildFolderBreadcrumbs(folders, currentFolderId), [folders, currentFolderId]);
  const { visibleFolders, visibleProjects } = useMemo(
    () => selectVisibleItems(folders, projects, currentFolderId, search),
    [folders, projects, currentFolderId, search],
  );

  return {
    currentFolderId,
    navigateToFolder: setRequestedFolderId,
    breadcrumbs,
    visibleFolders,
    visibleProjects,
    search,
    setSearch,
    q: search.trim().toLowerCase(),
    showSearch,
    setShowSearch,
    view,
    setView,
  };
}
