import { useEffect, useRef, useState } from 'react';

import {
  IconArrowLeft,
  IconFolder,
  IconSave,
  IconSettingsCog,
  IconTrash,
} from '@/features/itineraryPanel/components/icons';
import type { ProjectFolderSummary } from '@/shared/utils/projects';

import { formatSavedAt, formatSize, privacyLabel } from '../lib/utils';

type FolderCardProps = {
  folder: ProjectFolderSummary;
  sizeBytes: number;
  busy: boolean;
  onOpen: (id: string) => void;
  onRename: (id: string, nextName: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
};

export function FolderCard({
  folder,
  sizeBytes,
  busy,
  onOpen,
  onRename,
  onDelete,
}: FolderCardProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(folder.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  useEffect(() => {
    setDraft(folder.name);
  }, [folder.name]);

  const commitRename = async () => {
    const next = draft.trim();
    if (!next || next === folder.name) {
      setRenaming(false);
      setDraft(folder.name);
      return;
    }
    try {
      await onRename(folder.id, next);
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = async () => {
    const ok = window.confirm(
      `Supprimer définitivement le dossier « ${folder.name} » ? Il doit être vide avant suppression.`,
    );
    if (!ok) return;
    await onDelete(folder.id);
  };

  return (
    <article className="rvpb-card rvpb-folder-card">
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
                  setDraft(folder.name);
                }
              }}
            />
          ) : (
            <h3 onDoubleClick={() => setRenaming(true)} title="Double-cliquer pour renommer">
              {folder.name}
            </h3>
          )}

          <div className="rvpb-card__meta">
            <span className="rvpb-card__badge">{privacyLabel(folder.privacy)}</span>
            <span className="rvpb-card__meta-group">
              <IconSave size={14} />
              <span>{formatSavedAt(folder.updatedAt)}</span>
            </span>
            <span>{formatSize(sizeBytes)}</span>
          </div>
        </div>

        <div className="rvpb-card__actions">
          <button
            type="button"
            className="rvpb-icon-button"
            aria-label="Renommer le dossier"
            disabled={busy}
            onClick={() => setRenaming(true)}
          >
            <IconSettingsCog size={16} />
          </button>
          <button
            type="button"
            className="rvpb-icon-button"
            aria-label="Supprimer le dossier"
            disabled={busy}
            onClick={handleDelete}
          >
            <IconTrash size={16} />
          </button>
          <button
            type="button"
            className="rvpb-card__open"
            aria-label={`Ouvrir le dossier ${folder.name}`}
            disabled={busy}
            onClick={() => onOpen(folder.id)}
          >
            <IconArrowLeft size={18} />
          </button>
        </div>
      </div>

      <button
        type="button"
        className="rvpb-card__preview rvpb-folder-card__preview"
        onClick={() => onOpen(folder.id)}
        disabled={busy}
        aria-label={`Entrer dans le dossier ${folder.name}`}
      >
        <div className="rvpb-card__preview-placeholder rvpb-folder-card__placeholder" aria-hidden="true">
          <IconFolder size={40} />
        </div>
      </button>
    </article>
  );
}