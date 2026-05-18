import { useEffect, useRef, useState } from 'react';

import {
  IconChevronDown,
  IconFolderPlus,
  IconLayoutGrid,
  IconList,
  IconPlusCircle,
  IconSearch,
} from '@/features/itineraryPanel/components/icons';
import type { ProjectFolderSummary, ProjectSummary } from '@/shared/utils/projects';

import { buildFolderPathLabel, collectFolderDescendantIds } from '../../lib';
import { BrowserBreadcrumb } from './BrowserBreadcrumb';
import { FolderCard } from './FolderCard';
import { ProjectBrowserCardMenu } from './ProjectBrowserCardMenu';
import { ProjectBrowserDragPreview } from './ProjectBrowserDragPreview';
import { ProjectBrowserToast } from './ProjectBrowserToast';
import { ProjectCard } from './ProjectCard';

type MenuState =
  | { kind: 'project'; id: string; anchorEl: HTMLButtonElement }
  | { kind: 'folder'; id: string; anchorEl: HTMLButtonElement }
  | null;

type ToastState = {
  kind: 'success' | 'error' | 'info';
  message: string;
} | null;

type DragPreviewState = {
  type: 'project' | 'folder';
  label: string;
  x: number;
  y: number;
} | null;

type ProjectsPanelProps = {
  folders: ProjectFolderSummary[];
  view: 'grid' | 'list';
  setView: (view: 'grid' | 'list') => void;
  showSearch: boolean;
  setShowSearch: (show: boolean) => void;
  search: string;
  setSearch: (value: string) => void;
  handleCreateProject: () => void;
  handleCreateFolder: () => void;
  creatingProject: boolean;
  creatingFolder: boolean;
  error: string | null;
  loading: boolean;
  q: string;
  currentFolderId: string | null;
  breadcrumbs: ProjectFolderSummary[];
  visibleFolders: Array<ProjectFolderSummary & { aggregateSizeBytes: number }>;
  visibleProjects: ProjectSummary[];
  thumbnails: Record<string, string | null>;
  busyIds: Set<string>;
  draggedItem: { type: 'project' | 'folder'; id: string } | null;
  dropTarget: string | null;
  dragPreview: DragPreviewState;
  toast: ToastState;
  onOpenProject: (projectId: string) => void;
  onOpenFolder: (folderId: string) => void;
  onNavigateToFolder: (folderId: string | null) => void;
  handleRenameProject: (id: string, nextName: string) => Promise<void>;
  handleDeleteProject: (id: string) => Promise<void>;
  handleRenameFolder: (id: string, nextName: string) => Promise<void>;
  handleDeleteFolder: (id: string) => Promise<void>;
  handleDuplicateProject: (id: string) => Promise<void>;
  handleMoveProject: (id: string, folderId: string | null) => Promise<void>;
  handleMoveFolder: (id: string, folderId: string | null) => Promise<void>;
  handleDragStart: (item: { type: 'project' | 'folder'; id: string }, x: number, y: number) => void;
  handleDragMove: (x: number, y: number) => void;
  handleDragEnd: () => void;
  handleDragEnterTarget: (targetId: string) => void;
  handleDragLeaveTarget: (targetId: string) => void;
  handleDropIntoFolder: (folderId: string) => void;
  handleDropToRoot: () => void;
};

export function ProjectsPanel({
  folders,
  view,
  setView,
  showSearch,
  setShowSearch,
  search,
  setSearch,
  handleCreateProject,
  handleCreateFolder,
  creatingProject,
  creatingFolder,
  error,
  loading,
  q,
  currentFolderId,
  breadcrumbs,
  visibleFolders,
  visibleProjects,
  thumbnails,
  busyIds,
  draggedItem,
  dropTarget,
  dragPreview,
  toast,
  onOpenProject,
  onOpenFolder,
  onNavigateToFolder,
  handleRenameProject,
  handleDeleteProject,
  handleRenameFolder,
  handleDeleteFolder,
  handleDuplicateProject,
  handleMoveProject,
  handleMoveFolder,
  handleDragStart,
  handleDragMove,
  handleDragEnd,
  handleDragEnterTarget,
  handleDragLeaveTarget,
  handleDropIntoFolder,
  handleDropToRoot,
}: ProjectsPanelProps) {
  const visibleCount = visibleFolders.length + visibleProjects.length;
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [menuState, setMenuState] = useState<MenuState>(null);
  const createMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!createMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!createMenuRef.current?.contains(event.target as Node)) {
        setCreateMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCreateMenuOpen(false);
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [createMenuOpen]);

  const activeProject = menuState?.kind === 'project'
    ? visibleProjects.find((project) => project.id === menuState.id) ?? null
    : null;
  const activeFolder = menuState?.kind === 'folder'
    ? visibleFolders.find((folder) => folder.id === menuState.id) ?? null
    : null;
  const folderDescendants = activeFolder ? collectFolderDescendantIds(folders, activeFolder.id) : new Set<string>();
  const moveDestinations = menuState == null
    ? []
    : [
        {
          id: null,
          label: 'Racine / Projets',
          disabled:
            menuState.kind === 'project'
              ? activeProject?.folderId == null
              : activeFolder?.parentFolderId == null,
        },
        ...folders
          .filter((folder) => {
            if (menuState.kind === 'project') {
              return folder.id !== activeProject?.folderId;
            }
            return folder.id !== activeFolder?.id && !folderDescendants.has(folder.id);
          })
          .map((folder) => ({
            id: folder.id,
            label: buildFolderPathLabel(folders, folder.id),
            disabled: false,
          })),
      ];

  const requestRenameProject = async (project: ProjectSummary) => {
    const nextName = window.prompt('Nouveau nom du projet', project.name)?.trim();
    if (!nextName || nextName === project.name) return;
    await handleRenameProject(project.id, nextName);
  };

  const requestRenameFolder = async (folder: ProjectFolderSummary) => {
    const nextName = window.prompt('Nouveau nom du dossier', folder.name)?.trim();
    if (!nextName || nextName === folder.name) return;
    await handleRenameFolder(folder.id, nextName);
  };

  const confirmDeleteProject = async (project: ProjectSummary) => {
    const ok = window.confirm(`Supprimer définitivement « ${project.name} » ?`);
    if (!ok) return;
    await handleDeleteProject(project.id);
  };

  const confirmDeleteFolder = async (folder: ProjectFolderSummary) => {
    const ok = window.confirm(
      `Supprimer définitivement le dossier « ${folder.name} » ? Il doit être vide avant suppression.`,
    );
    if (!ok) return;
    await handleDeleteFolder(folder.id);
  };

  return (
    <>
      <div className="rvpb-toolbar">
        <div className="rvpb-toolbar__start">
          <BrowserBreadcrumb
            breadcrumbs={breadcrumbs}
            onNavigate={onNavigateToFolder}
            rootDropActive={dropTarget === '__root__'}
            onDragEnterRoot={() => handleDragEnterTarget('__root__')}
            onDragLeaveRoot={() => handleDragLeaveTarget('__root__')}
            onDropToRoot={handleDropToRoot}
          />
        </div>

        <div className="rvpb-toolbar__actions">
          <div className="rvpb-view-toggle" role="tablist" aria-label="Affichage des projets">
            <button
              type="button"
              className={`rvpb-view-toggle__item${view === 'grid' ? ' is-active' : ''}`}
              aria-pressed={view === 'grid'}
              onClick={() => setView('grid')}
            >
              <span>Grille</span>
              <IconLayoutGrid size={12} />
            </button>
            <button
              type="button"
              className={`rvpb-view-toggle__item${view === 'list' ? ' is-active' : ''}`}
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              <span>Liste</span>
              <IconList size={16} />
            </button>
          </div>

          {showSearch ? (
            <input
              className="rvpb-search-input"
              autoFocus
              placeholder="Rechercher…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onBlur={() => {
                if (!search) setShowSearch(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="rvpb-square-button"
              aria-label="Rechercher un projet"
              onClick={() => setShowSearch(true)}
            >
              <IconSearch size={18} />
            </button>
          )}
          <button
            type="button"
            className="rvpb-square-button"
            aria-label="Créer un dossier"
            onClick={handleCreateFolder}
            disabled={creatingFolder}
          >
            <IconFolderPlus size={18} />
          </button>

          <div className={`rvpb-create-menu${createMenuOpen ? ' is-open' : ''}`} ref={createMenuRef}>
            <button
              type="button"
              className="rvpb-create-button"
              aria-haspopup="menu"
              aria-expanded={createMenuOpen}
              onClick={() => setCreateMenuOpen((prev) => !prev)}
              disabled={creatingProject || creatingFolder}
            >
              <IconPlusCircle size={20} />
              <span>
                {creatingProject ? 'Création…' : creatingFolder ? 'Création…' : 'Créer un projet'}
              </span>
              <IconChevronDown size={16} />
            </button>

            {createMenuOpen ? (
              <div className="rvpb-create-menu__dropdown" role="menu" aria-label="Créer un élément">
                <button
                  type="button"
                  className="rvpb-create-menu__item"
                  role="menuitem"
                  onClick={() => {
                    setCreateMenuOpen(false);
                    handleCreateProject();
                  }}
                >
                  <IconPlusCircle size={18} />
                  <span>Créer un projet ici</span>
                </button>
                <button
                  type="button"
                  className="rvpb-create-menu__item"
                  role="menuitem"
                  onClick={() => {
                    setCreateMenuOpen(false);
                    handleCreateFolder();
                  }}
                >
                  <IconFolderPlus size={18} />
                  <span>Créer un dossier ici</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {error ? (
        <div className="rvpb-error" role="alert">
          {error}
        </div>
      ) : null}

      <section
        className={`rvpb-grid-shell${view === 'list' ? ' is-list' : ''}`}
        aria-label={currentFolderId ? 'Contenu du dossier courant' : 'Liste des projets'}
      >
        {loading && visibleCount === 0 ? (
          <div className="rvpb-empty">Chargement…</div>
        ) : visibleCount === 0 ? (
          <div className="rvpb-empty">
            {q
              ? 'Aucun dossier ou projet ne correspond à votre recherche.'
              : currentFolderId
                ? 'Ce dossier est vide. Créez un sous-dossier ou un projet pour commencer.'
                : 'Vous n’avez pas encore de projet. Créez un dossier ou un projet pour commencer.'}
          </div>
        ) : (
          <>
            {visibleFolders.map((folder) => (
              <FolderCard
                key={folder.id}
                folder={folder}
                sizeBytes={folder.aggregateSizeBytes}
                busy={busyIds.has(folder.id)}
                dragActive={draggedItem?.type === 'folder' && draggedItem.id === folder.id}
                dropActive={dropTarget === folder.id}
                onOpen={onOpenFolder}
                onRename={handleRenameFolder}
                onOpenMenu={(id, anchorEl) => setMenuState({ kind: 'folder', id, anchorEl })}
                onDragStart={handleDragStart}
                onDragMove={handleDragMove}
                onDragEnd={handleDragEnd}
                onDragEnterTarget={handleDragEnterTarget}
                onDragLeaveTarget={handleDragLeaveTarget}
                onDropIntoFolder={handleDropIntoFolder}
              />
            ))}

            {visibleProjects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                thumbnailUrl={thumbnails[project.id] ?? null}
                busy={busyIds.has(project.id)}
                dragActive={draggedItem?.type === 'project' && draggedItem.id === project.id}
                onOpen={onOpenProject}
                onRename={handleRenameProject}
                onOpenMenu={(id, anchorEl) => setMenuState({ kind: 'project', id, anchorEl })}
                onDragStart={handleDragStart}
                onDragMove={handleDragMove}
                onDragEnd={handleDragEnd}
              />
            ))}
          </>
        )}
      </section>

      {menuState && activeProject ? (
        <ProjectBrowserCardMenu
          anchorEl={menuState.anchorEl}
          title="Actions du projet"
          destinations={moveDestinations}
          onClose={() => setMenuState(null)}
          onRename={() => {
            void requestRenameProject(activeProject);
            setMenuState(null);
          }}
          onMove={(destinationId) => {
            void handleMoveProject(activeProject.id, destinationId);
          }}
          onDuplicate={() => {
            void handleDuplicateProject(activeProject.id);
            setMenuState(null);
          }}
          onDelete={() => {
            void confirmDeleteProject(activeProject);
            setMenuState(null);
          }}
        />
      ) : null}

      {menuState && activeFolder ? (
        <ProjectBrowserCardMenu
          anchorEl={menuState.anchorEl}
          title="Actions du dossier"
          destinations={moveDestinations}
          onClose={() => setMenuState(null)}
          onRename={() => {
            void requestRenameFolder(activeFolder);
            setMenuState(null);
          }}
          onMove={(destinationId) => {
            void handleMoveFolder(activeFolder.id, destinationId);
          }}
          onDelete={() => {
            void confirmDeleteFolder(activeFolder);
            setMenuState(null);
          }}
        />
      ) : null}

      {dragPreview ? <ProjectBrowserDragPreview {...dragPreview} /> : null}
      {toast ? <ProjectBrowserToast kind={toast.kind} message={toast.message} /> : null}
    </>
  );
}