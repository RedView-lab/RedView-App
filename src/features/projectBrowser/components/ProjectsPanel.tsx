import {
  IconLayoutGrid,
  IconList,
  IconPlusCircle,
  IconSearch,
  IconSettingsSliders,
} from '@/features/itineraryPanel/components/icons';
import type { ProjectSummary } from '@/shared/utils/projects';

import { ProjectCard } from './ProjectCard';

type ProjectsPanelProps = {
  view: 'grid' | 'list';
  setView: (view: 'grid' | 'list') => void;
  showSearch: boolean;
  setShowSearch: (show: boolean) => void;
  search: string;
  setSearch: (value: string) => void;
  handleCreate: () => void;
  creating: boolean;
  error: string | null;
  loading: boolean;
  q: string;
  filtered: ProjectSummary[];
  thumbnails: Record<string, string | null>;
  busyIds: Set<string>;
  onOpenProject: (projectId: string) => void;
  handleRename: (id: string, nextName: string) => Promise<void>;
  handleDelete: (id: string) => Promise<void>;
};

export function ProjectsPanel({
  view,
  setView,
  showSearch,
  setShowSearch,
  search,
  setSearch,
  handleCreate,
  creating,
  error,
  loading,
  q,
  filtered,
  thumbnails,
  busyIds,
  onOpenProject,
  handleRename,
  handleDelete,
}: ProjectsPanelProps) {
  return (
    <>
      <div className="rvpb-toolbar">
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

        <div className="rvpb-toolbar__actions">
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
          <button type="button" className="rvpb-square-button" aria-label="Filtrer les projets">
            <IconSettingsSliders size={18} />
          </button>
          <button
            type="button"
            className="rvpb-create-button"
            onClick={handleCreate}
            disabled={creating}
          >
            <IconPlusCircle size={20} />
            <span>{creating ? 'Création…' : 'Créer un projet'}</span>
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
        aria-label="Liste des projets"
      >
        {loading && filtered.length === 0 ? (
          <div className="rvpb-empty">Chargement…</div>
        ) : filtered.length === 0 ? (
          <div className="rvpb-empty">
            {q
              ? 'Aucun projet ne correspond à votre recherche.'
              : 'Vous n’avez pas encore de projet. Cliquez sur « Créer un projet » pour commencer.'}
          </div>
        ) : (
          filtered.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              thumbnailUrl={thumbnails[project.id] ?? null}
              busy={busyIds.has(project.id)}
              onOpen={onOpenProject}
              onRename={handleRename}
              onDelete={handleDelete}
            />
          ))
        )}
      </section>
    </>
  );
}