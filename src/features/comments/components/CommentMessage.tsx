import { memo, useState } from 'react';

import type { ProjectCommentMessage } from '@/features/itineraryPanel/types';
import { UserAvatar } from '@/shared/components/UserAvatar/UserAvatar';
import { useAppI18n } from '@/shared/i18n';

import { groupReactions, type CommentTextInput } from '../lib/commentActions';
import { tokenizeMessage, type MentionCandidate } from '../lib/messageText';
import { formatFullDate, formatRelativeTime } from '../lib/relativeTime';
import { CommentComposer } from './CommentComposer';
import { CommentPopover } from './CommentPopover';
import { IconMore, IconSmile } from './icons';
import { ReactionPicker } from './ReactionPicker';

/**
 * Un message d'un fil : avatar, nom, date relative, « (modifié) », texte
 * (mentions surlignées, liens http(s)), réactions. Au survol : réagir, et pour
 * ses propres messages un menu Modifier / Supprimer (modification sur place).
 */

interface CommentMessageProps {
  message: ProjectCommentMessage;
  authorName: string;
  meId: string;
  members: readonly MentionCandidate[];
  candidates: readonly MentionCandidate[];
  now: number;
  /** Supprimer ce message supprime le fil (premier message). */
  deletesThread: boolean;
  canEdit: boolean;
  /** Lecture seule : ni réaction ni action au survol. */
  readOnly?: boolean;
  onEdit(input: CommentTextInput): boolean;
  onDelete(): void;
  onToggleReaction(emoji: string): void;
}

export const CommentMessage = memo(function CommentMessage({
  message,
  authorName,
  meId,
  members,
  candidates,
  now,
  deletesThread,
  canEdit,
  readOnly = false,
  onEdit,
  onDelete,
  onToggleReaction,
}: CommentMessageProps) {
  const { t, locale } = useAppI18n();
  const [editing, setEditing] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [reactAnchor, setReactAnchor] = useState<HTMLElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const mentioned = members.filter((member) => message.mentions?.includes(member.userId));
  const tokens = tokenizeMessage(message.text, mentioned);
  const reactions = groupReactions(message);
  const mine = new Set(reactions.filter((group) => group.userIds.includes(meId)).map((group) => group.emoji));
  const nameList = (userIds: readonly string[]) => userIds
    .map((id) => (id === meId ? t('Vous') : members.find((member) => member.userId === id)?.name ?? t('Éditeur')))
    .join(', ');

  const closeMenu = () => {
    setMenuAnchor(null);
    setConfirmDelete(false);
  };

  return (
    <article className={`rv-comment-message${editing ? ' is-editing' : ''}`}>
      <UserAvatar userId={message.authorId} name={authorName} size={24} title="" />
      <div className="rv-comment-message__body">
        <header className="rv-comment-message__header">
          <span className="rv-comment-message__name" data-rv-no-translate="true">{authorName}</span>
          <time className="rv-comment-message__time" dateTime={message.createdAt} title={formatFullDate(message.createdAt, locale)}>
            {formatRelativeTime(message.createdAt, now, locale)}
          </time>
          {message.editedAt ? <span className="rv-comment-message__edited">{t('(modifié)')}</span> : null}
        </header>
        {editing ? (
          <CommentComposer
            placeholder={t('Modifier le commentaire')}
            candidates={candidates}
            initialText={message.text}
            autoFocus
            editing
            onSubmit={(input) => {
              const saved = onEdit(input);
              // Texte identique : rien à enregistrer, on sort quand même.
              setEditing(false);
              return saved;
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <p className="rv-comment-message__text" data-rv-no-translate="true">
            {tokens.map((token, index) => {
              if (token.kind === 'mention') return <span key={index} className="rv-comment-message__mention">{token.text}</span>;
              if (token.kind === 'link') {
                return <a key={index} href={token.href} target="_blank" rel="noopener noreferrer">{token.text}</a>;
              }
              return <span key={index}>{token.text}</span>;
            })}
          </p>
        )}
        {reactions.length > 0 ? (
          <div className="rv-comment-message__reactions">
            {reactions.map((group) => (
              <button
                key={group.emoji}
                type="button"
                className={`rv-comment-reaction${mine.has(group.emoji) ? ' is-mine' : ''}`}
                aria-pressed={mine.has(group.emoji)}
                title={nameList(group.userIds)}
                disabled={readOnly}
                onClick={() => onToggleReaction(group.emoji)}
              >
                <span data-rv-no-translate="true">{group.emoji}</span>
                <span>{group.userIds.length}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {!editing && !readOnly ? (
        <div className={`rv-comment-message__actions${menuAnchor || reactAnchor ? ' is-visible' : ''}`}>
          <button
            type="button"
            className="rv-comment-icon-button"
            aria-label={t('Réagir')}
            title={t('Réagir')}
            onClick={(event) => {
              const anchor = event.currentTarget;
              setReactAnchor((current) => (current ? null : anchor));
            }}
          >
            <IconSmile />
          </button>
          {canEdit ? (
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
          ) : null}
        </div>
      ) : null}
      <ReactionPicker anchorEl={reactAnchor} open={reactAnchor !== null} onClose={() => setReactAnchor(null)} onPick={onToggleReaction} selected={mine} />
      <CommentPopover anchorEl={menuAnchor} open={menuAnchor !== null} onClose={closeMenu} width={200} className="rv-dropdown">
        <button
          type="button"
          role="menuitem"
          className="rv-dropdown__item rv-dropdown__item--no-check"
          onClick={() => {
            closeMenu();
            setEditing(true);
          }}
        >
          <span className="rv-dropdown__label">{t('Modifier')}</span>
        </button>
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
            onDelete();
          }}
        >
          <span className="rv-dropdown__label">
            {confirmDelete
              ? t('Confirmer la suppression')
              : deletesThread ? t('Supprimer le fil') : t('Supprimer')}
          </span>
        </button>
      </CommentPopover>
    </article>
  );
});
