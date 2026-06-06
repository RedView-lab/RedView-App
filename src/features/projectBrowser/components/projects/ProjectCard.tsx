import { useEffect, useRef, useState } from 'react';

import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';
import {
  IconArrowLeft,
  IconSave,
} from '@/features/itineraryPanel/components/icons';
import type { ProjectSummary } from '@/shared/utils/projects';

import { formatSavedAt, formatSize, privacyLabel } from '../../lib';

type ProjectCardProps = {
  project: ProjectSummary;
  thumbnailUrl: string | null;
  thumbnailLoading: boolean;
  onOpen: (id: string) => void;
  onRename: (id: string, nextName: string) => Promise<void> | void;
  busy: boolean;
  dragActive: boolean;
  onOpenMenu: (id: string, anchorEl: HTMLButtonElement) => void;
  onDragStart: (item: { type: 'project'; id: string }, x: number, y: number) => void;
  onDragMove: (x: number, y: number) => void;
  onDragEnd: () => void;
};

const EMPTY_DRAG_IMAGE =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

export function ProjectCard({
  project,
  thumbnailUrl,
  thumbnailLoading,
  onOpen,
  onRename,
  busy,
  dragActive,
  onOpenMenu,
  onDragStart,
  onDragMove,
  onDragEnd,
}: ProjectCardProps) {
  const { t } = useAppI18n();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [previewSrc, setPreviewSrc] = useState(thumbnailUrl);
  const [previewReady, setPreviewReady] = useState(false);
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
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
    setDraft(project.name);
  }, [project.name]);

  useEffect(() => {
    setPreviewSrc(thumbnailUrl);
    setPreviewReady(false);
    setPreviewUnavailable(false);
  }, [thumbnailUrl]);

  const hasPreviewImage = Boolean(previewSrc) && !previewUnavailable;
  const showLoadingPlaceholder = !previewUnavailable && (thumbnailLoading || (hasPreviewImage && !previewReady));
  const showPlaceholder = !hasPreviewImage || !previewReady;

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

  return (
    <article
      className={`rvpb-card${dragActive ? ' is-dragging' : ''}`}
      draggable={!renaming && !busy}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        if (dragImageRef.current) {
          event.dataTransfer.setDragImage(dragImageRef.current, 0, 0);
        }
        onDragStart({ type: 'project', id: project.id }, event.clientX, event.clientY);
      }}
      onDrag={(event) => {
        if (event.clientX || event.clientY) {
          onDragMove(event.clientX, event.clientY);
        }
      }}
      onDragEnd={onDragEnd}
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
                  setDraft(project.name);
                }
              }}
            />
          ) : (
            <h3 onDoubleClick={() => setRenaming(true)} title={t('Double-cliquer pour renommer')}>
              {project.name}
            </h3>
          )}
          <div className="rvpb-card__meta">
            <span className="rvpb-card__badge">{privacyLabel(project.privacy)}</span>
            <span className="rvpb-card__meta-group">
              <IconSave size={14} />
              <span>{formatSavedAt(project.updatedAt)}</span>
            </span>
            <span>{formatSize(project.sizeBytes)}</span>
          </div>
        </div>

        <div className="rvpb-card__actions">
          <button
            ref={menuButtonRef}
            type="button"
            className="rvpb-icon-button rvpb-card__menu-button"
            aria-label={t('Actions du projet')}
            disabled={busy}
            onClick={() => {
              if (!menuButtonRef.current) return;
              onOpenMenu(project.id, menuButtonRef.current);
            }}
          >
            <SvgV2Icon name="dots-vertical.svg" size={16} />
          </button>
          <button
            type="button"
            className="rvpb-card__open"
            aria-label={t('Ouvrir {{name}}', { name: project.name })}
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
        aria-label={t('Entrer dans {{name}}', { name: project.name })}
      >
        {hasPreviewImage ? (
          <img
            className={`rvpb-card__preview-image${previewReady ? ' is-ready' : ''}`}
            src={previewSrc ?? undefined}
            alt={t('Aperçu de projet')}
            loading="lazy"
            onLoad={() => setPreviewReady(true)}
            onError={() => {
              setPreviewReady(false);
              setPreviewUnavailable(true);
            }}
          />
        ) : null}
        {showPlaceholder ? (
          <div
            className={`rvpb-card__preview-placeholder${showLoadingPlaceholder ? ' is-loading' : ''}`}
            aria-hidden="true"
          >
            <SvgV2Icon name={showLoadingPlaceholder ? 'arrow-down.svg' : 'map-01.svg'} size={40} />
          </div>
        ) : null}
      </button>
    </article>
  );
}