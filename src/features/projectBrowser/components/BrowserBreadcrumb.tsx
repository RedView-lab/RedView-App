import type { ProjectFolderSummary } from '@/shared/utils/projects';

type BrowserBreadcrumbProps = {
  breadcrumbs: ProjectFolderSummary[];
  onNavigate: (folderId: string | null) => void;
  rootDropActive?: boolean;
  onDropToRoot?: () => void;
  onDragEnterRoot?: () => void;
  onDragLeaveRoot?: () => void;
};

export function BrowserBreadcrumb({
  breadcrumbs,
  onNavigate,
  rootDropActive = false,
  onDropToRoot,
  onDragEnterRoot,
  onDragLeaveRoot,
}: BrowserBreadcrumbProps) {
  return (
    <nav className="rvpb-breadcrumb" aria-label="Chemin du dossier courant">
      <button
        type="button"
        className={`rvpb-breadcrumb__item${breadcrumbs.length === 0 ? ' is-current' : ''}${rootDropActive ? ' is-drop-target' : ''}`}
        onClick={() => onNavigate(null)}
        onDragOver={(event) => event.preventDefault()}
        onDragEnter={() => onDragEnterRoot?.()}
        onDragLeave={() => onDragLeaveRoot?.()}
        onDrop={(event) => {
          event.preventDefault();
          onDropToRoot?.();
        }}
      >
        Projets
      </button>

      {breadcrumbs.map((folder, index) => {
        const isCurrent = index === breadcrumbs.length - 1;
        return (
          <span key={folder.id} className="rvpb-breadcrumb__segment">
            <span className="rvpb-breadcrumb__separator">/</span>
            <button
              type="button"
              className={`rvpb-breadcrumb__item${isCurrent ? ' is-current' : ''}`}
              onClick={() => onNavigate(folder.id)}
            >
              {folder.name}
            </button>
          </span>
        );
      })}
    </nav>
  );
}