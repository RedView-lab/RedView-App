import { useEffect, useMemo, useRef, useState } from 'react';

import type { ProjectCommentThread } from '@/features/itineraryPanel/types';
import { useAppI18n } from '@/shared/i18n';
import { notify } from '@/shared/lib/notify';

import type { CommentToolValue } from '../context/commentTool';
import { canEditMessage, canManageThread } from '../lib/commentActions';
import { commentRouteContext } from '../lib/routeContext';
import { CommentComposer } from './CommentComposer';
import { CommentMessage } from './CommentMessage';
import { CommentPopover } from './CommentPopover';
import { IconClose, IconMore, IconNext, IconPrevious, IconResolve, IconZone } from './icons';

/**
 * Fil ouvert, à côté de sa bulle (comme le fil de Figma) : en-tête avec fil
 * précédent / suivant, Résoudre, menu « … » (marquer comme non lu, copier le
 * texte, supprimer le fil pour son créateur), fermer ; messages ; réponse.
 */

interface CommentThreadCardProps {
  tool: CommentToolValue;
  thread: ProjectCommentThread;
  now: number;
}

export function CommentThreadCard({ tool, thread, now }: CommentThreadCardProps) {
  const { t } = useAppI18n();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const resolved = thread.resolvedAt !== undefined;
  const readOnly = tool.readOnly === true;
  const canDelete = !readOnly && canManageThread(thread, tool.me);
  const candidates = useMemo(() => tool.members.filter((member) => member.userId !== tool.me.userId), [tool.me.userId, tool.members]);
  const route = commentRouteContext(thread.anchor, tool.activeItinerary);
  const navigable = tool.threads.filter((candidate) => candidate.resolvedAt === undefined || candidate.id === thread.id).length > 1;

  // Nouveau message (le sien ou celui d'un autre) : la liste descend en bas.
  const lastMessageId = thread.messages.at(-1)?.id;
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [lastMessageId]);

  const closeMenu = () => {
    setMenuAnchor(null);
    setConfirmDelete(false);
  };

  const copyText = () => {
    closeMenu();
    const text = thread.messages.map((message) => `${tool.nameOf(message.authorId, message.authorName)} : ${message.text}`).join('\n');
    void navigator.clipboard?.writeText(text).then(
      () => notify.success('Commentaire copié'),
      () => notify.error('Copie impossible'),
    );
  };

  return (
    <section className="rv-comment-card rv-comment-card--thread" data-rv-comment-card={thread.id} aria-label={t('Fil de commentaires')}>
      <header className="rv-comment-card__header">
        {navigable ? (
          <div className="rv-comment-card__nav">
            <button type="button" className="rv-comment-icon-button" aria-label={t('Commentaire précédent')} title={t('Commentaire précédent')} onClick={() => tool.navigate(-1)}>
              <IconPrevious />
            </button>
            <button type="button" className="rv-comment-icon-button" aria-label={t('Commentaire suivant')} title={t('Commentaire suivant')} onClick={() => tool.navigate(1)}>
              <IconNext />
            </button>
          </div>
        ) : null}
        <div className="rv-comment-card__title">
          <span>{t('Commentaire')}</span>
          {route ? (
            <span className="rv-comment-card__context" title={tool.activeItinerary?.name}>
              {t('km {{km}}', { km: route.distanceKm.toFixed(1).replace('.', ',') })}
            </span>
          ) : null}
          {thread.zone ? <span className="rv-comment-card__context"><IconZone size={12} />{t('Zone')}</span> : null}
        </div>
        {readOnly ? null : (
          <>
            <button
              type="button"
              className={`rv-comment-icon-button${resolved ? ' is-active' : ''}`}
              aria-label={resolved ? t('Rouvrir') : t('Résoudre')}
              title={resolved ? t('Rouvrir') : t('Résoudre')}
              aria-pressed={resolved}
              onClick={() => {
                tool.setResolved(thread.id, !resolved);
                if (!resolved) tool.closeThread();
              }}
            >
              <IconResolve />
            </button>
            <button
              type="button"
              className="rv-comment-icon-button"
              aria-label={t('Plus d’actions')}
              title={t('Plus d’actions')}
              aria-haspopup="menu"
              onClick={(event) => {
                const anchor = event.currentTarget;
                setMenuAnchor((current) => (current ? null : anchor));
                setConfirmDelete(false);
              }}
            >
              <IconMore />
            </button>
          </>
        )}
        <button type="button" className="rv-comment-icon-button" aria-label={t('Fermer')} title={t('Fermer')} onClick={tool.closeThread}>
          <IconClose />
        </button>
      </header>

      {resolved ? (
        <div className="rv-comment-card__resolved">
          <span data-rv-no-translate="true">
            {t('Résolu par {{name}}', { name: thread.resolvedBy === tool.me.userId ? t('vous') : tool.nameOf(thread.resolvedBy ?? '') })}
          </span>
          {readOnly ? null : (
            <button type="button" className="rv-comment-text-button" onClick={() => tool.setResolved(thread.id, false)}>{t('Rouvrir')}</button>
          )}
        </div>
      ) : null}

      <div ref={listRef} className="rv-comment-card__messages">
        {thread.messages.map((message, index) => (
          <CommentMessage
            key={message.id}
            message={message}
            authorName={tool.nameOf(message.authorId, message.authorName)}
            meId={tool.me.userId}
            members={tool.members}
            candidates={candidates}
            now={now}
            deletesThread={index === 0}
            canEdit={!readOnly && canEditMessage(message, tool.me) && (index > 0 || canDelete)}
            readOnly={readOnly}
            onEdit={(input) => tool.editMessage(thread.id, message.id, input)}
            onDelete={() => tool.deleteMessage(thread.id, message.id)}
            onToggleReaction={(emoji) => tool.toggleReaction(thread.id, message.id, emoji)}
          />
        ))}
      </div>

      <footer className="rv-comment-card__reply">
        {readOnly ? (
          <p className="rv-comment-card__readonly">{t('Rouvrez le projet dans RedView pour répondre.')}</p>
        ) : (
          <CommentComposer
            placeholder={t('Répondre')}
            candidates={candidates}
            onSubmit={(input) => tool.reply(thread.id, input)}
            onCancel={tool.closeThread}
          />
        )}
      </footer>

      <CommentPopover anchorEl={menuAnchor} open={menuAnchor !== null} onClose={closeMenu} width={220} className="rv-dropdown">
        <button
          type="button"
          role="menuitem"
          className="rv-dropdown__item rv-dropdown__item--no-check"
          onClick={() => {
            closeMenu();
            tool.markUnread(thread.id);
          }}
        >
          <span className="rv-dropdown__label">{t('Marquer comme non lu')}</span>
        </button>
        <button type="button" role="menuitem" className="rv-dropdown__item rv-dropdown__item--no-check" onClick={copyText}>
          <span className="rv-dropdown__label">{t('Copier le texte')}</span>
        </button>
        {canDelete ? (
          <>
            <div className="rv-dropdown__divider" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="rv-dropdown__item rv-dropdown__item--no-check rv-dropdown__item--danger"
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                closeMenu();
                tool.deleteThread(thread.id);
              }}
            >
              <span className="rv-dropdown__label">{confirmDelete ? t('Confirmer la suppression') : t('Supprimer le fil')}</span>
            </button>
          </>
        ) : null}
      </CommentPopover>
    </section>
  );
}

interface CommentDraftCardProps {
  tool: CommentToolValue;
}

/** Nouveau commentaire : la petite saisie de Figma, à côté de la bulle provisoire. */
export function CommentDraftCard({ tool }: CommentDraftCardProps) {
  const { t } = useAppI18n();
  const candidates = useMemo(() => tool.members.filter((member) => member.userId !== tool.me.userId), [tool.me.userId, tool.members]);
  return (
    <section className="rv-comment-card rv-comment-card--draft" data-rv-comment-card="draft" aria-label={t('Nouveau commentaire')}>
      {tool.draft?.zone ? (
        <div className="rv-comment-card__draft-context"><IconZone size={12} />{t('Commentaire de zone')}</div>
      ) : null}
      <CommentComposer
        placeholder={t('Ajouter un commentaire')}
        candidates={candidates}
        autoFocus
        focusRequest={tool.draftFocusRequest}
        textRef={tool.draftTextRef}
        onSubmit={tool.submitDraft}
        onCancel={tool.cancelDraft}
      />
    </section>
  );
}
