import {
  IconChevronDown,
  IconFolderPlus,
  IconLayoutGrid,
  IconList,
  IconPlusCircle,
  IconSearch,
} from '@/features/itineraryPanel/components/icons';
import type { ProjectFolderSummary, ProjectSummary } from '@/shared/utils/projects';

import { BrowserBreadcrumb } from './BrowserBreadcrumb';
import { FolderCard } from './FolderCard';
import { ProjectCard } from './ProjectCard';

type ProjectsPanelProps = {
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
  onOpenProject: (projectId: string) => void;
  onOpenFolder: (folderId: string) => void;
  onNavigateToFolder: (folderId: string | null) => void;
  handleRenameProject: (id: string, nextName: string) => Promise<void>;
  handleDeleteProject: (id: string) => Promise<void>;
  handleRenameFolder: (id: string, nextName: string) => Promise<void>;
  handleDeleteFolder: (id: string) => Promise<void>;
};

export function ProjectsPanel({
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
  onOpenProject,
  onOpenFolder,
  onNavigateToFolder,
  handleRenameProject,
  handleDeleteProject,
  handleRenameFolder,
  handleDeleteFolder,
}: ProjectsPanelProps) {
  const visibleCount = visibleFolders.length + visibleProjects.length;

  return (
    <>
      <div className="rvpb-toolbar">
        <div className="rvpb-toolbar__start">
          <BrowserBreadcrumb breadcrumbs={breadcrumbs} onNavigate={onNavigateToFolder} />
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
          <button
            type="button"
            className="rvpb-create-button"
            onClick={handleCreateProject}
            disabled={creatingProject}
          >
            <IconPlusCircle size={20} />
            <span>{creatingProject ? 'Création…' : 'Créer un projet'}</span>
            <IconChevronDown size={16} />
          </button>
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
                onOpen={onOpenFolder}
                onRename={handleRenameFolder}
                onDelete={handleDeleteFolder}
              />
            ))}

            {visibleProjects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                thumbnailUrl={thumbnails[project.id] ?? null}
                busy={busyIds.has(project.id)}
                onOpen={onOpenProject}
                onRename={handleRenameProject}
                onDelete={handleDeleteProject}
              />
            ))}
          </>
        )}
      </section>
    </>
  );
}