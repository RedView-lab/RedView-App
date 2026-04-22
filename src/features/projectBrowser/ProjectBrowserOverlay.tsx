import { useCallback, useEffect, useRef, useState } from 'react';

import {
  IconArrowLeft,
  IconDownload,
  IconLayoutGrid,
  IconList,
  IconMapPin,
  IconPlusCircle,
  IconRoute,
  IconSearch,
  IconSettingsCog,
  IconSettingsSliders,
  IconShare,
  IconStopwatch,
  IconTrash,
} from '@/features/itineraryPanel/components/icons';

import {
  createProject,
  deleteProject,
  listProjects,
  renameProject,
  type ProjectSummary,
} from '@/lib/projects';

import { PROJECT_BROWSER_PREVIEW_URL } from './projectBrowserData';
import './styles.css';

interface ProjectBrowserOverlayProps {
  open: boolean;
  displayName: string;
  /** Called once a project has been opened (existing or freshly created). */
  onOpenProject: (projectId: string) => void;
  /** Close request from the user (Escape / outside click). Ignored when `canClose` is false. */
  onRequestClose: () => void;
  /** When false, the overlay refuses to close — used to force selection on first login. */
  canClose?: boolean;
}

/* ------------------------------------------------------------------ */
/* formatting helpers                                                  */
/* ------------------------------------------------------------------ */

function formatSavedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const hh = String(d.getHours()).padStart(2, '0');
  const mn = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yy} à ${hh}:${mn}`;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes}o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}ko`;
  return `${Math.round(bytes / (1024 * 1024))}mo`;
}

function privacyLabel(p: ProjectSummary['privacy']): string {
  return p === 'public' ? 'Public' : 'Privé';
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

interface ProjectCardProps {
  project: ProjectSummary;
  onOpen: (id: string) => void;
  onRename: (id: string, nextName: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  busy: boolean;
}

function ProjectCard({ project, onOpen, onRename, onDelete, busy }: ProjectCardProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const commitRename = async () => {
    const next = draft.trim();
    if (!next || next === project.name) {
      setRenaming(false);
      setDraft(project.name);
      return;
    }
    try {
      await onRename(project.id, next);
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = async () => {
    const ok = window.confirm(`Supprimer définitivement « ${project.name} » ?`);
    if (!ok) return;
    await onDelete(project.id);
  };

  return (
    <article className="rvpb-card">
      <div className="rvpb-card__header">
        <div className="rvpb-card__title-stack">
          {renaming ? (
            <input
              ref={inputRef}
              className="rvpb-card__rename-input"
              value={draft}
              autoFocus
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename();
                if (e.key === 'Escape') {
                  setRenaming(false);
                  setDraft(project.name);
                }
              }}
            />
          ) : (
            <h3
              onDoubleClick={() => setRenaming(true)}
              title="Double-cliquer pour renommer"
            >
              {project.name}
            </h3>
          )}
          <div className="rvpb-card__meta">
            <span className="rvpb-card__badge">{privacyLabel(project.privacy)}</span>
            <span>{formatSavedAt(project.updatedAt)}</span>
            <span>{formatSize(project.sizeBytes)}</span>
          </div>
        </div>

        <div className="rvpb-card__actions">
          <button
            type="button"
            className="rvpb-icon-button"
            aria-label="Renommer le projet"
            disabled={busy}
            onClick={() => setRenaming(true)}
          >
            <IconSettingsCog size={16} />
          </button>
          <button
            type="button"
            className="rvpb-icon-button"
            aria-label="Supprimer le projet"
            disabled={busy}
            onClick={handleDelete}
          >
            <IconTrash size={16} />
          </button>
          <button
            type="button"
            className="rvpb-card__open"
            aria-label={`Ouvrir ${project.name}`}
            disabled={busy}
            onClick={() => onOpen(project.id)}
          >
            <IconArrowLeft size={18} />
          </button>
        </div>
      </div>

      <button
        type="button"
        className="rvpb-card__preview"
        onClick={() => onOpen(project.id)}
        disabled={busy}
        aria-label={`Entrer dans ${project.name}`}
      >
        <img src={PROJECT_BROWSER_PREVIEW_URL} alt="Aperçu de projet" />
      </button>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Overlay                                                             */
/* ------------------------------------------------------------------ */

export function ProjectBrowserOverlay({
  open,
  displayName,
  onOpenProject,
  onRequestClose,
  canClose = true,
}: ProjectBrowserOverlayProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Impossible de charger les projets.');
    } finally {
      setLoading(false);
    }
  }, []);

  // (Re)load whenever the overlay opens.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Escape closes — but only when allowed.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && canClose) onRequestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onRequestClose, canClose]);

  const handleCreate = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const row = await createProject();
      // Optimistic prepend so the card is visible if the user backs out.
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Échec de la création du projet.');
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
          prev.map((p) =>
            p.id === id
              ? { ...p, name: nextName, updatedAt: new Date().toISOString() }
              : p,
          ),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Échec du renommage.');
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
        setProjects((prev) => prev.filter((p) => p.id !== id));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Échec de la suppression.');
      } finally {
        setBusy(id, false);
      }
    },
    [setBusy],
  );

  if (!open) return null;

  const q = search.trim().toLowerCase();
  const filtered = q
    ? projects.filter((p) => p.name.toLowerCase().includes(q))
    : projects;

  const lastEdited = projects[0];

  return (
    <div
      className="rvpb-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Sélecteur de projet principal"
    >
      <div className="rvpb-shell">
        <header className="rvpb-header">
          <div className="rvpb-user">
            <div className="rvpb-user__name">{displayName || 'Utilisateur'}</div>
            <div className="rvpb-user__meta">
              <span className="rvpb-user__badge">Premium</span>
              <span>
                {lastEdited
                  ? `Dernière modification ${formatSavedAt(lastEdited.updatedAt)}`
                  : 'Aucun projet enregistré'}
              </span>
            </div>
          </div>

          <div className="rvpb-header__actions">
            <button type="button" className="rvpb-icon-button" aria-label="Paramètres du compte">
              <IconSettingsCog size={16} />
            </button>
            <button type="button" className="rvpb-icon-button" aria-label="Télécharger vos projets">
              <IconDownload size={16} />
            </button>
            <button type="button" className="rvpb-icon-button" aria-label="Partager">
              <IconShare size={16} />
            </button>
          </div>
        </header>

        <div className="rvpb-divider" />

        <nav className="rvpb-top-tabs" aria-label="Navigation principale du menu projet">
          <button type="button" className="rvpb-top-tabs__item is-active">
            <IconRoute size={13.333} />
            <span>Projets</span>
          </button>
          <button type="button" className="rvpb-top-tabs__item">
            <IconStopwatch size={16} />
            <span>Compte</span>
          </button>
          <button type="button" className="rvpb-top-tabs__item">
            <IconMapPin size={16} />
            <span>Réglages</span>
          </button>
        </nav>

        <div className="rvpb-divider" />

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
                onChange={(e) => setSearch(e.target.value)}
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
          {loading && projects.length === 0 ? (
            <div className="rvpb-empty">Chargement…</div>
          ) : filtered.length === 0 ? (
            <div className="rvpb-empty">
              {q
                ? 'Aucun projet ne correspond à votre recherche.'
                : 'Vous n’avez pas encore de projet. Cliquez sur « Créer un projet » pour commencer.'}
            </div>
          ) : (
            filtered.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                busy={busyIds.has(p.id)}
                onOpen={onOpenProject}
                onRename={handleRename}
                onDelete={handleDelete}
              />
            ))
          )}
        </section>
      </div>
    </div>
  );
}
