import { useEffect, useRef, useState } from 'react';

import {
  IconArrowLeft,
  IconSettingsCog,
  IconTrash,
} from '@/features/itineraryPanel/components/icons';
import type { ProjectSummary } from '@/lib/projects';

import { formatSavedAt, formatSize, privacyLabel } from './utils';

type ProjectCardProps = {
  project: ProjectSummary;
  thumbnailUrl: string | null;
  onOpen: (id: string) => void;
  onRename: (id: string, nextName: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  busy: boolean;
};

export function ProjectCard({
  project,
  thumbnailUrl,
  onOpen,
  onRename,
  onDelete,
  busy,
}: ProjectCardProps) {
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
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commitRename();
                if (event.key === 'Escape') {
                  setRenaming(false);
                  setDraft(project.name);
                }
              }}
            />
          ) : (
            <h3 onDoubleClick={() => setRenaming(true)} title="Double-cliquer pour renommer">
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
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt="Aperçu de projet" />
        ) : (
          <div className="rvpb-card__preview-placeholder" aria-hidden="true" />
        )}
      </button>
    </article>
  );
}