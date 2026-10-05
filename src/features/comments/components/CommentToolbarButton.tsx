import { useState } from 'react';

import { useAppI18n } from '@/shared/i18n';

import { useCommentToolOptional, type CommentSubTool } from '../context/commentTool';
import { CommentPopover } from './CommentPopover';
import { IconChevronDown, IconComment } from './icons';

/**
 * Outil « Commenter » de la barre d'outils (comme l'outil Commentaire de
 * Figma) : bouton du mode (touche C), point rouge s'il reste des fils non
 * lus ; chevron : commentaire sur un point ou sur une zone, bulles masquées.
 * `onBeforeArm` désarme les autres outils de la carte (Tracer, Découper…).
 */

interface CommentToolbarButtonProps {
  onBeforeArm(): void;
}

export function CommentToolbarButton({ onBeforeArm }: CommentToolbarButtonProps) {
  const tool = useCommentToolOptional();
  const { t } = useAppI18n();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  if (!tool) return null;

  const armWith = (subTool: CommentSubTool) => {
    if (!tool.armed) onBeforeArm();
    tool.arm(subTool);
    setMenuAnchor(null);
  };

  const title = tool.unreadCount > 0
    ? t('Commenter (C) · {{count}} non lu(s)', { count: tool.unreadCount })
    : t('Commenter (C)');

  return (
    <div className="rv-comment-tool">
      <button
        type="button"
        className={`rvc-center-toolbar__button rv-comment-tool__main${tool.armed ? ' rvc-center-toolbar__button--active' : ''}`}
        aria-label={t('Commenter')}
        title={title}
        aria-pressed={tool.armed}
        onClick={() => {
          if (!tool.armed) onBeforeArm();
          tool.toggle();
        }}
      >
        <IconComment />
        {tool.unreadCount > 0 ? <span className="rv-comment-tool__dot" aria-hidden="true" /> : null}
      </button>
      <button
        type="button"
        className={`rvc-center-toolbar__button rv-comment-tool__chevron${tool.armed ? ' rvc-center-toolbar__button--active' : ''}`}
        aria-label={t('Options de l’outil Commentaire')}
        title={t('Options de l’outil Commentaire')}
        aria-haspopup="menu"
        aria-expanded={menuAnchor !== null}
        onClick={(event) => {
          const anchor = event.currentTarget;
          setMenuAnchor((current) => (current ? null : anchor));
        }}
      >
        <IconChevronDown size={14} />
      </button>
      <CommentPopover anchorEl={menuAnchor} open={menuAnchor !== null} onClose={() => setMenuAnchor(null)} width={250} align="start" className="rv-dropdown">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={tool.armed && tool.subTool === 'point'}
          className={`rv-dropdown__item${tool.armed && tool.subTool === 'point' ? ' is-selected' : ''}`}
          onClick={() => armWith('point')}
        >
          <span className="rv-dropdown__label">{t('Commentaire')}</span>
          <kbd className="rv-comment-kbd">C</kbd>
        </button>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={tool.armed && tool.subTool === 'zone'}
          className={`rv-dropdown__item${tool.armed && tool.subTool === 'zone' ? ' is-selected' : ''}`}
          onClick={() => armWith('zone')}
        >
          <span className="rv-dropdown__label">{t('Commentaire de zone')}</span>
          <kbd className="rv-comment-kbd">{t('Maj + glisser')}</kbd>
        </button>
        <div className="rv-dropdown__divider" role="separator" />
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={tool.pinsHidden}
          className={`rv-dropdown__item${tool.pinsHidden ? ' is-selected' : ''}`}
          onClick={() => {
            tool.togglePinsHidden();
            setMenuAnchor(null);
          }}
        >
          <span className="rv-dropdown__label">{t('Masquer les bulles')}</span>
          <kbd className="rv-comment-kbd">{t('Maj+C')}</kbd>
        </button>
      </CommentPopover>
    </div>
  );
}
