import { useRef, useState } from 'react';

import {
  IconFolderPlus,
  IconLayoutGrid,
  IconList,
  IconPlusCircle,
  IconSearch,
} from '@/features/itineraryPanel/components/icons';
import { REDVIEW_FILE_EXTENSION } from '@/features/redviewFile/lib/format';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';
import { projectAgeBucket, trackAnalyticsEvent } from '@/shared/lib/analytics';
import type { ProjectFolderSummary, ProjectSummary } from '@/shared/utils/projects';

import { useFileDropImport } from '../../hooks/useFileDropImport';
import { buildFolderPathLabel, collectFolderDescendantIds } from '../../lib';
import { BrowserBreadcrumb } from './BrowserBreadcrumb';
import { FolderCard } from './FolderCard';
import { ProjectBrowserCardMenu } from './ProjectBrowserCardMenu';
import { ProjectBrowserDragPreview } from './ProjectBrowserDragPreview';
import { ProjectCard } from './ProjectCard';
import { useMultiplayerAvailable } from '@/features/collab/queries/multiplayerHealth';

import { ShareProjectDialog } from './ShareProjectDialog';

type MenuState =
  | { kind: 'project'; id: string; anchorEl: HTMLButtonElement }
  | { kind: 'folder'; id: string; anchorEl: HTMLButtonElement }
  | null;

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
  handleImportProjects: (files: File[]) => Promise<void>;
  creatingProject: boolean;
  importingProject: boolean;
  creatingFolder: boolean;
  error: string | null;
  loading: boolean;
  q: string;
  currentFolderId: string | null;
  breadcrumbs: ProjectFolderSummary[];
  visibleFolders: Array<ProjectFolderSummary & { aggregateSizeBytes: number }>;
  visibleProjects: ProjectSummary[];
  /** Projets partagés par d'autres propriétaires (section « Partagés avec moi », à la racine). */
  sharedProjects: ProjectSummary[];
  userId: string | null;
  thumbnails: Record<string, string | null>;
  thumbnailLoadingIds: Set<string>;
  busyIds: Set<string>;
  draggedItem: { type: 'project' | 'folder'; id: string } | null;
  dropTarget: string | null;
  dragPreview: DragPreviewState;
  onOpenProject: (projectId: string) => void;
  onOpenFolder: (folderId: string) => void;
  onNavigateToFolder: (folderId: string | null) => void;
  handleRenameProject: (id: string, nextName: string) => Promise<void>;
  handleDeleteProject: (id: string) => Promise<void>;
  handleRenameFolder: (id: string, nextName: string) => Promise<void>;
  handleDeleteFolder: (id: string) => Promise<void>;
  handleDuplicateProject: (id: string) => Promise<void>;
  handleExportProject: (id: string) => Promise<void>;
  handleLeaveProject: (id: string) => Promise<void>;
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
  handleImportProjects,
  creatingProject,
  importingProject,
  creatingFolder,
  error,
  loading,
  q,
  currentFolderId,
  breadcrumbs,
  visibleFolders,
  visibleProjects,
  sharedProjects,
  userId,
  thumbnails,
  thumbnailLoadingIds,
  busyIds,
  draggedItem,
  dropTarget,
  dragPreview,
  onOpenProject,
  onOpenFolder,
  onNavigateToFolder,
  handleRenameProject,
  handleDeleteProject,
  handleRenameFolder,
  handleDeleteFolder,
  handleDuplicateProject,
  handleExportProject,
  handleLeaveProject,
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
  const { t } = useAppI18n();
  const visibleSharedProjects = currentFolderId === null
    ? sharedProjects.filter((project) => !q || project.name.toLowerCase().includes(q))
    : [];
  const visibleCount = visibleFolders.length + visibleProjects.length + visibleSharedProjects.length;
  const [menuState, setMenuState] = useState<MenuState>(null);
  // Retour sur un projet : étape « project_opened » de l'entonnoir (anonyme, docs/ANALYTICS.md).
  const openProject = (project: ProjectSummary, id: string) => {
    trackAnalyticsEvent({
      name: 'project_opened',
      data: { last_saved: projectAgeBucket(project.updatedAt), shared: Boolean(project.sharedWithMe) },
    });
    onOpenProject(id);
  };
  // Partage proposé seulement quand le serveur temps réel répond.
  const multiplayerAvailable = useMultiplayerAvailable();
  const [shareTarget, setShareTarget] = useState<{ project: ProjectSummary; anchorEl: HTMLElement } | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const fileDropActive = useFileDropImport({
    accepting: !importingProject,
    onFiles: (files) => void handleImportProjects(files),
  });

  const activeProject = menuState?.kind === 'project'
    ? visibleProjects.find((project) => project.id === menuState.id)
      ?? visibleSharedProjects.find((project) => project.id === menuState.id)
      ?? null
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
          label: t('Racine / Projets'),
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
    const nextName = window.prompt(t('Nouveau nom du projet'), project.name)?.trim();
    if (!nextName || nextName === project.name) return;
    await handleRenameProject(project.id, nextName);
  };

  const requestRenameFolder = async (folder: ProjectFolderSummary) => {
    const nextName = window.prompt(t('Nouveau nom du dossier'), folder.name)?.trim();
    if (!nextName || nextName === folder.name) return;
    await handleRenameFolder(folder.id, nextName);
  };

  const confirmDeleteProject = async (project: ProjectSummary) => {
    const ok = window.confirm(t('Supprimer définitivement « {{name}} » ?', { name: project.name }));
    if (!ok) return;
    await handleDeleteProject(project.id);
  };

  const confirmLeaveProject = async (project: ProjectSummary) => {
    if (!window.confirm(t('Quitter « {{name}} » ? Vous n’y aurez plus accès.', { name: project.name }))) return;
    await handleLeaveProject(project.id);
  };

  const confirmDeleteFolder = async (folder: ProjectFolderSummary) => {
    const ok = window.confirm(
      t('Supprimer définitivement le dossier « {{name}} » ? Il doit être vide avant suppression.', {
        name: folder.name,
      }),
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
          {showSearch ? (
            <input
              className="rvpb-search-input"
              autoFocus
              placeholder={t('Rechercher…')}
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
              aria-label={t('Rechercher un projet')}
              title={t('Rechercher un projet')}
              onClick={() => setShowSearch(true)}
            >
              <IconSearch size={18} />
            </button>
          )}

          <div className="rvpb-view-toggle" role="group" aria-label={t('Affichage des projets')}>
            <button
              type="button"
              className={`rvpb-view-toggle__item${view === 'grid' ? ' is-active' : ''}`}
              aria-pressed={view === 'grid'}
              onClick={() => setView('grid')}
            >
              <span>{t('Grille')}</span>
              <IconLayoutGrid size={12} />
            </button>
            <button
              type="button"
              className={`rvpb-view-toggle__item${view === 'list' ? ' is-active' : ''}`}
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              <span>{t('Liste')}</span>
              <IconList size={16} />
            </button>
          </div>

          <button
            type="button"
            className="rvpb-square-button"
            aria-label={creatingFolder ? t('Création…') : t('Créer un dossier')}
            title={t('Créer un dossier')}
            onClick={handleCreateFolder}
            disabled={creatingFolder}
          >
            {creatingFolder ? (
              <span className="rvpb-square-button__spinner" aria-hidden="true" />
            ) : (
              <IconFolderPlus size={18} />
            )}
          </button>

          <input
            ref={importInputRef}
            type="file"
            accept={REDVIEW_FILE_EXTENSION}
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              // Même fichier choisi deux fois de suite : `change` doit repartir.
              event.target.value = '';
              if (files.length > 0) void handleImportProjects(files);
            }}
          />
          <button
            type="button"
            className="rvpb-create-button rvpb-create-button--secondary"
            title={t('Ouvrir un fichier .redview partagé (ou le déposer sur cette page)')}
            onClick={() => importInputRef.current?.click()}
            disabled={importingProject}
          >
            {importingProject ? (
              <span className="rvpb-square-button__spinner" aria-hidden="true" />
            ) : (
              <SvgV2Icon name="upload-01.svg" size={20} />
            )}
            <span>{importingProject ? t('Import…') : t('Importer un projet')}</span>
          </button>

          <button
            type="button"
            className="rvpb-create-button"
            onClick={handleCreateProject}
            disabled={creatingProject}
          >
            <IconPlusCircle size={20} />
            <span>{creatingProject ? t('Création…') : t('Créer un projet')}</span>
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
        aria-label={currentFolderId ? t('Contenu du dossier courant') : t('Liste des projets')}
      >
        {loading && visibleCount === 0 ? (
          <div className="rvpb-empty">{t('Chargement…')}</div>
        ) : visibleCount === 0 ? (
          <div className="rvpb-empty">
            {q
              ? t('Aucun dossier ou projet ne correspond à votre recherche.')
              : currentFolderId
                ? t('Ce dossier est vide. Créez un sous-dossier ou un projet pour commencer.')
                : t('Vous n’avez pas encore de projet. Créez un dossier ou un projet pour commencer.')}
          </div>
        ) : (
          <>
            {visibleFolders.map((folder) => (
              <FolderCard
                key={folder.id}
                folder={folder}
                view={view}
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
                view={view}
                thumbnailUrl={thumbnails[project.id] ?? null}
                thumbnailLoading={thumbnailLoadingIds.has(project.id)}
                busy={busyIds.has(project.id)}
                dragActive={draggedItem?.type === 'project' && draggedItem.id === project.id}
                onOpen={(id) => openProject(project, id)}
                onRename={handleRenameProject}
                onOpenMenu={(id, anchorEl) => setMenuState({ kind: 'project', id, anchorEl })}
                onDragStart={handleDragStart}
                onDragMove={handleDragMove}
                onDragEnd={handleDragEnd}
              />
            ))}

            {visibleSharedProjects.length > 0 ? (
              <>
                <h2 className="rvpb-shared-section-title">{t('Partagés avec moi')}</h2>
                {visibleSharedProjects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    view={view}
                    thumbnailUrl={thumbnails[project.id] ?? null}
                    thumbnailLoading={thumbnailLoadingIds.has(project.id)}
                    busy={busyIds.has(project.id)}
                    dragActive={false}
                    onOpen={(id) => openProject(project, id)}
                    onRename={handleRenameProject}
                    onOpenMenu={(id, anchorEl) => setMenuState({ kind: 'project', id, anchorEl })}
                    onDragStart={handleDragStart}
                    onDragMove={handleDragMove}
                    onDragEnd={handleDragEnd}
                  />
                ))}
              </>
            ) : null}
          </>
        )}
      </section>

      {menuState && activeProject && activeProject.sharedWithMe ? (
        <ProjectBrowserCardMenu
          anchorEl={menuState.anchorEl}
          title="Actions du projet"
          onClose={() => setMenuState(null)}
          onShare={() => {
            setShareTarget({ project: activeProject, anchorEl: menuState.anchorEl });
            setMenuState(null);
          }}
          onDuplicate={() => {
            void handleDuplicateProject(activeProject.id);
            setMenuState(null);
          }}
          onExport={() => {
            void handleExportProject(activeProject.id);
            setMenuState(null);
          }}
          onLeave={() => {
            void confirmLeaveProject(activeProject);
            setMenuState(null);
          }}
        />
      ) : null}

      {menuState && activeProject && !activeProject.sharedWithMe ? (
        <ProjectBrowserCardMenu
          anchorEl={menuState.anchorEl}
          title="Actions du projet"
          destinations={moveDestinations}
          onClose={() => setMenuState(null)}
          // Projet local (compte de démo, hors cloud) : pas de partage.
          onShare={!multiplayerAvailable || activeProject.id.startsWith('local-') ? undefined : () => {
            setShareTarget({ project: activeProject, anchorEl: menuState.anchorEl });
            setMenuState(null);
          }}
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
          onExport={() => {
            void handleExportProject(activeProject.id);
            setMenuState(null);
          }}
          onDelete={() => {
            void confirmDeleteProject(activeProject);
            setMenuState(null);
          }}
        />
      ) : null}

      {shareTarget ? (
        <ShareProjectDialog
          projectId={shareTarget.project.id}
          projectName={shareTarget.project.name}
          sharedWithMe={shareTarget.project.sharedWithMe}
          anchorEl={shareTarget.anchorEl}
          userId={userId}
          onClose={() => setShareTarget(null)}
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

      {fileDropActive ? (
        <div className="rvpb-file-drop" aria-hidden="true">
          <div className="rvpb-file-drop__panel">
            <SvgV2Icon name="upload-03.svg" size={32} />
            <span className="rvpb-file-drop__title">{t('Déposez le fichier .redview pour importer le projet')}</span>
            <span className="rvpb-file-drop__hint">
              {currentFolderId
                ? t('Il sera ajouté au dossier « {{name}} ».', { name: breadcrumbs[breadcrumbs.length - 1]?.name ?? '' })
                : t('Il sera ajouté à vos projets.')}
            </span>
          </div>
        </div>
      ) : null}

      {dragPreview ? <ProjectBrowserDragPreview {...dragPreview} /> : null}
    </>
  );
}