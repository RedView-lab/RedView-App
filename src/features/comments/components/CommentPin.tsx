import { memo, type MouseEvent } from 'react';

import type { ProjectCommentThread } from '@/features/itineraryPanel/types';
import { UserAvatar, UserAvatarStack } from '@/shared/components/UserAvatar/UserAvatar';
import { useAppI18n } from '@/shared/i18n';

import { formatRelativeTime } from '../lib/relativeTime';
import { IconZone } from './icons';

/**
 * Bulle posée sur la carte (contenu de carte : identique dans les deux
 * thèmes). Avatar de l'auteur dans une bulle dont la pointe, en bas à gauche,
 * désigne le point du relief ; au survol elle se déplie (nom, date, début du
 * texte, réponses), comme les bulles de Figma.
 */

interface CommentPinProps {
  thread: ProjectCommentThread;
  authorName: string;
  unread: boolean;
  open: boolean;
  highlighted: boolean;
  now: number;
  onOpen(threadId: string): void;
  onHover(threadId: string | null): void;
}

export const CommentPin = memo(function CommentPin({ thread, authorName, unread, open, highlighted, now, onOpen, onHover }: CommentPinProps) {
  const { t, locale } = useAppI18n();
  const first = thread.messages[0];
  const replies = thread.messages.length - 1;
  const resolved = thread.resolvedAt !== undefined;
  const className = [
    'rv-comment-pin',
    unread ? 'is-unread' : '',
    open ? 'is-open' : '',
    highlighted ? 'is-highlighted' : '',
    resolved ? 'is-resolved' : '',
  ].filter(Boolean).join(' ');

  const handleClick = (event: MouseEvent) => {
    event.stopPropagation();
    onOpen(thread.id);
  };

  return (
    <button
      type="button"
      className={className}
      data-rv-comment-pin={thread.id}
      aria-label={t('Commentaire de {{name}}', { name: authorName })}
      aria-expanded={open}
      onClick={handleClick}
      onMouseEnter={() => onHover(thread.id)}
      onMouseLeave={() => onHover(null)}
    >
      <span className="rv-comment-pin__avatar" data-rv-no-translate="true">
        <UserAvatar userId={first?.authorId ?? thread.createdBy} name={authorName} size={28} title="" />
      </span>
      <span className="rv-comment-pin__preview" aria-hidden="true">
        <span className="rv-comment-pin__preview-inner">
          <span className="rv-comment-pin__preview-content">
            <span className="rv-comment-pin__meta">
              <span className="rv-comment-pin__name" data-rv-no-translate="true">{authorName}</span>
              <span className="rv-comment-pin__time">{first ? formatRelativeTime(first.createdAt, now, locale) : ''}</span>
            </span>
            <span className="rv-comment-pin__text" data-rv-no-translate="true">{first?.text}</span>
            {replies > 0 || thread.zone ? (
              <span className="rv-comment-pin__footer">
                {replies > 0 ? <span>{replies === 1 ? t('1 réponse') : t('{{count}} réponses', { count: replies })}</span> : null}
                {thread.zone ? <span className="rv-comment-pin__zone"><IconZone size={12} />{t('Zone')}</span> : null}
              </span>
            ) : null}
          </span>
        </span>
      </span>
      {unread ? <span className="rv-comment-pin__dot" /> : null}
    </button>
  );
});

interface CommentClusterPinProps {
  threads: readonly ProjectCommentThread[];
  nameOf(userId: string, fallback?: string): string;
  unread: boolean;
  onOpen(threadIds: readonly string[]): void;
}

/** Groupe de bulles qui se chevauchent : avatars empilés et nombre ; un clic zoome dessus. */
export const CommentClusterPin = memo(function CommentClusterPin({ threads, nameOf, unread, onOpen }: CommentClusterPinProps) {
  const { t } = useAppI18n();
  const authors = [...new Map(threads.map((thread) => [thread.createdBy, thread.messages[0]?.authorName ?? ''])).entries()]
    .slice(0, 3)
    .map(([userId, fallback]) => ({ userId, name: nameOf(userId, fallback) }));
  return (
    <button
      type="button"
      className={`rv-comment-pin rv-comment-pin--cluster${unread ? ' is-unread' : ''}`}
      data-rv-comment-pin="cluster"
      aria-label={t('{{count}} commentaires', { count: threads.length })}
      title={t('{{count}} commentaires', { count: threads.length })}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(threads.map((thread) => thread.id));
      }}
    >
      <span className="rv-comment-pin__stack" data-rv-no-translate="true">
        <UserAvatarStack people={authors} max={authors.length} />
      </span>
      <span className="rv-comment-pin__count">{threads.length}</span>
      {unread ? <span className="rv-comment-pin__dot" /> : null}
    </button>
  );
});

interface DraftPinProps {
  userId: string;
  name: string;
}

/** Bulle provisoire (nouveau commentaire en cours de saisie). */
export function CommentDraftPin({ userId, name }: DraftPinProps) {
  return (
    <span className="rv-comment-pin is-draft" data-rv-comment-pin="draft" aria-hidden="true">
      <span className="rv-comment-pin__avatar" data-rv-no-translate="true">
        <UserAvatar userId={userId} name={name} size={28} title="" />
      </span>
    </span>
  );
}
