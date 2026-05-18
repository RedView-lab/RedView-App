import { useEffect, useRef, useState } from 'react';

import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import {
  IconArrowLeft,
  IconFolder,
  IconSave,
} from '@/features/itineraryPanel/components/icons';
import type { ProjectFolderSummary } from '@/shared/utils/projects';

import { formatSavedAt, formatSize, privacyLabel } from '../../lib';

type FolderCardProps = {
  folder: ProjectFolderSummary;
  sizeBytes: number;
  busy: boolean;
  dragActive: boolean;
  dropActive: boolean;
  onOpen: (id: string) => void;
  onRename: (id: string, nextName: string) => Promise<void> | void;
  onOpenMenu: (id: string, anchorEl: HTMLButtonElement) => void;
  onDragStart: (item: { type: 'folder'; id: string }, x: number, y: number) => void;
  onDragMove: (x: number, y: number) => void;
  onDragEnd: () => void;
  onDragEnterTarget: (targetId: string) => void;
  onDragLeaveTarget: (targetId: string) => void;
  onDropIntoFolder: (folderId: string) => void;
};

const EMPTY_DRAG_IMAGE =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

export function FolderCard({
  folder,
  sizeBytes,
  busy,
  dragActive,
  dropActive,
  onOpen,
  onRename,
  onOpenMenu,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDragEnterTarget,
  onDragLeaveTarget,
  onDropIntoFolder,
}: FolderCardProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(folder.name);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const dragImageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  useEffect(() => {
    const image = new Image();
    image.src = EMPTY_DRAG_IMAGE;
    dragImageRef.current = image;
  }, []);

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

  return (
    <article
      className={`rvpb-card rvpb-folder-card${dragActive ? ' is-dragging' : ''}${dropActive ? ' is-drop-target' : ''}`}
      draggable={!renaming && !busy}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        if (dragImageRef.current) {
          event.dataTransfer.setDragImage(dragImageRef.current, 0, 0);
        }
        onDragStart({ type: 'folder', id: folder.id }, event.clientX, event.clientY);
      }}
      onDrag={(event) => {
        if (event.clientX || event.clientY) {
          onDragMove(event.clientX, event.clientY);
        }
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => event.preventDefault()}
      onDragEnter={() => onDragEnterTarget(folder.id)}
      onDragLeave={() => onDragLeaveTarget(folder.id)}
      onDrop={(event) => {
        event.preventDefault();
        onDropIntoFolder(folder.id);
      }}
    >
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
            ref={menuButtonRef}
            type="button"
            className="rvpb-icon-button rvpb-card__menu-button"
            aria-label="Actions du dossier"
            disabled={busy}
            onClick={() => {
              if (!menuButtonRef.current) return;
              onOpenMenu(folder.id, menuButtonRef.current);
            }}
          >
            <SvgV2Icon name="dots-vertical.svg" size={16} />
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