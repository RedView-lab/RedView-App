import { useEffect, useRef, useState } from 'react';

import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';
import {
  IconArrowLeft,
  IconFolder,
  IconSave,
} from '@/features/itineraryPanel/components/icons';
import type { ProjectFolderSummary } from '@/shared/utils/projects';

import { formatSavedAt, formatSize, privacyLabel } from '../../lib';

type FolderCardProps = {
  folder: ProjectFolderSummary;
  view: 'grid' | 'list';
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
  view,
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
  const { t } = useAppI18n();
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

  const placeholderIconSize = view === 'list' ? 20 : 40;
  const previewContent = (
    <div className="rvpb-card__preview-placeholder rvpb-folder-card__placeholder" aria-hidden="true">
      <IconFolder size={placeholderIconSize} />
    </div>
  );

  if (view === 'list') {
    const titleContent = renaming ? (
      <input
        ref={inputRef}
        className="rvpb-card__rename-input rvpb-card__rename-input--list"
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
      <span
        className="rvpb-card__list-title"
        title={t('Double-cliquer pour renommer')}
        onDoubleClick={(event) => {
          event.stopPropagation();
          setRenaming(true);
        }}
      >
        {folder.name}
      </span>
    );

    const mainContent = (
      <>
        <div className="rvpb-card__list-preview rvpb-folder-card__list-preview" aria-hidden="true">
          {previewContent}
        </div>
        {titleContent}
        <span className="rvpb-card__list-size">{formatSize(sizeBytes)}</span>
        <span className="rvpb-card__list-saved">
          <IconSave size={14} />
          <span>{formatSavedAt(folder.updatedAt)}</span>
        </span>
        <span className="rvpb-card__badge rvpb-card__badge--list">{privacyLabel(folder.privacy)}</span>
      </>
    );

    return (
      <article
        className={`rvpb-card rvpb-card--list rvpb-folder-card${dragActive ? ' is-dragging' : ''}${dropActive ? ' is-drop-target' : ''}`}
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
        {renaming ? (
          <div className="rvpb-card__list-main is-static">{mainContent}</div>
        ) : (
          <button
            type="button"
            className="rvpb-card__list-main"
            onClick={() => onOpen(folder.id)}
            disabled={busy}
            aria-label={t('Entrer dans le dossier {{name}}', { name: folder.name })}
          >
            {mainContent}
          </button>
        )}

        <div className="rvpb-card__list-actions">
          <button
            ref={menuButtonRef}
            type="button"
            className="rvpb-icon-button rvpb-card__menu-button rvpb-card__menu-button--list"
            aria-label={t('Actions du dossier')}
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
            aria-label={t('Ouvrir le dossier {{name}}', { name: folder.name })}
            disabled={busy}
            onClick={() => onOpen(folder.id)}
          >
            <IconArrowLeft size={18} />
          </button>
        </div>
      </article>
    );
  }

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
            <h3 onDoubleClick={() => setRenaming(true)} title={t('Double-cliquer pour renommer')}>
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
            aria-label={t('Actions du dossier')}
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
            aria-label={t('Ouvrir le dossier {{name}}', { name: folder.name })}
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
        aria-label={t('Entrer dans le dossier {{name}}', { name: folder.name })}
      >
        {previewContent}
      </button>
    </article>
  );
}