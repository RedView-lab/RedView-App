import { useEffect, useState, type CSSProperties } from 'react';

import type { ProjectCommentSort, ProjectCommentThread } from '@/features/itineraryPanel/types';
import { UserAvatar } from '@/shared/components/UserAvatar/UserAvatar';
import { useAppI18n } from '@/shared/i18n';

import { useCommentToolOptional, type CommentToolValue } from '../context/commentTool';
import { commentRouteContext } from '../lib/routeContext';
import { formatRelativeTime } from '../lib/relativeTime';
import { isThreadUnread, isUserThread, threadMentionsUser } from '../lib/readState';
import { CommentPopover } from './CommentPopover';
import { IconClose, IconResolve, IconSearch, IconSort, IconZone } from './icons';
import '../styles/comments.css';

/**
 * Liste des commentaires du projet, à la place du panneau droit en mode
 * commentaire (la barre latérale de Figma) : recherche (texte, auteur), tri
 * par date / non lus / position sur l'itinéraire actif, filtres « Afficher les
 * résolus » et « Seulement mes fils ». Survoler une ligne fait ressortir sa
 * bulle ; un clic amène la caméra dessus et ouvre le fil.
 */

interface CommentsPanelProps {
  style?: CSSProperties;
}

const SORTS: ReadonlyArray<{ id: ProjectCommentSort; label: string }> = [
  { id: 'date', label: 'Trier par date' },
  { id: 'unread', label: 'Trier par non lus' },
  { id: 'route', label: 'Trier par position sur l’itinéraire' },
];

function lastActivity(thread: ProjectCommentThread): string {
  return thread.messages.at(-1)?.createdAt ?? thread.createdAt;
}

function sortThreads(threads: ProjectCommentThread[], tool: CommentToolValue, sort: ProjectCommentSort): ProjectCommentThread[] {
  const byDate = (a: ProjectCommentThread, b: ProjectCommentThread) => lastActivity(b).localeCompare(lastActivity(a));
  if (sort === 'unread') {
    const unread = (thread: ProjectCommentThread) => (isThreadUnread(thread, tool.me.userId, tool.view?.reads) ? 0 : 1);
    return [...threads].sort((a, b) => unread(a) - unread(b) || byDate(a, b));
  }
  if (sort === 'route') {
    const km = new Map(threads.map((thread) => [thread.id, commentRouteContext(thread.anchor, tool.activeItinerary)?.distanceKm ?? Infinity]));
    return [...threads].sort((a, b) => km.get(a.id)! - km.get(b.id)! || byDate(a, b));
  }
  return [...threads].sort(byDate);
}

export function CommentsPanel({ style }: CommentsPanelProps) {
  const tool = useCommentToolOptional();
  if (!tool) return null;
  return <CommentsPanelInner tool={tool} style={style} />;
}

function CommentsPanelInner({ tool, style }: { tool: CommentToolValue; style?: CSSProperties }) {
  const { t, locale } = useAppI18n();
  const [query, setQuery] = useState('');
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const sort = tool.view?.sort ?? 'date';
  const showResolved = Boolean(tool.view?.showResolved);
  const onlyMine = Boolean(tool.view?.onlyMine);
  const needle = query.trim().toLocaleLowerCase();

  const filtered = tool.threads.filter((thread) => {
    if (!showResolved && thread.resolvedAt !== undefined) return false;
    if (onlyMine && !isUserThread(thread, tool.me.userId)) return false;
    if (!needle) return true;
    return thread.messages.some((message) => message.text.toLocaleLowerCase().includes(needle)
      || tool.nameOf(message.authorId, message.authorName).toLocaleLowerCase().includes(needle));
  });
  const threads = sortThreads(filtered, tool, sort);
  const resolvedCount = tool.threads.filter((thread) => thread.resolvedAt !== undefined).length;

  return (
    <section className="rv-comments-panel" style={style} aria-label={t('Commentaires')} data-rv-comments-panel="">
      <header className="rv-comments-panel__header">
        <h2 className="rv-comments-panel__title">{t('Commentaires')}</h2>
        {tool.unreadCount > 0 ? (
          <span className="rv-comments-panel__badge" title={t('Non lus')}>{tool.unreadCount}</span>
        ) : null}
        <span className="rv-comments-panel__spacer" />
        <button
          type="button"
          className={`rv-comment-icon-button${sort !== 'date' || showResolved || onlyMine ? ' is-active' : ''}`}
          aria-label={t('Trier et filtrer')}
          title={t('Trier et filtrer')}
          aria-haspopup="menu"
          onClick={(event) => {
            const anchor = event.currentTarget;
            setMenuAnchor((current) => (current ? null : anchor));
          }}
        >
          <IconSort />
        </button>
        <button type="button" className="rv-comment-icon-button" aria-label={t('Quitter le mode commentaire')} title={t('Quitter le mode commentaire (Échap)')} onClick={tool.deactivate}>
          <IconClose />
        </button>
      </header>

      <label className="rv-comments-panel__search">
        <IconSearch />
        <input
          type="search"
          value={query}
          placeholder={t('Rechercher')}
          aria-label={t('Rechercher dans les commentaires')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </label>

      {tool.statusMessage ? <p className="rv-comments-panel__hint" role="status">{tool.statusMessage}</p> : null}

      {threads.length === 0 ? (
        <div className="rv-comments-panel__empty">
          <p className="rv-comments-panel__empty-title">
            {tool.threads.length === 0 ? t('Aucun commentaire') : t('Aucun commentaire ne correspond')}
          </p>
          <p className="rv-comments-panel__empty-text">
            {tool.threads.length === 0
              ? t('Cliquez sur la carte pour poser une bulle d’info, ou Maj + glisser pour commenter une zone.')
              : !showResolved && resolvedCount > 0
                ? t('Les commentaires résolus sont masqués.')
                : t('Essayez une autre recherche.')}
          </p>
        </div>
      ) : (
        <ul className="rv-comments-panel__list">
          {threads.map((thread) => {
            const first = thread.messages[0];
            const unread = isThreadUnread(thread, tool.me.userId, tool.view?.reads);
            const mentioned = threadMentionsUser(thread, tool.me.userId);
            const route = commentRouteContext(thread.anchor, tool.activeItinerary);
            const replies = thread.messages.length - 1;
            const authorName = tool.nameOf(first?.authorId ?? thread.createdBy, first?.authorName);
            const className = [
              'rv-comments-panel__item',
              unread ? 'is-unread' : '',
              thread.id === tool.openThreadId ? 'is-open' : '',
              thread.resolvedAt !== undefined ? 'is-resolved' : '',
            ].filter(Boolean).join(' ');
            return (
              <li key={thread.id}>
                <button
                  type="button"
                  className={className}
                  onMouseEnter={() => tool.setHoveredThreadId(thread.id)}
                  onMouseLeave={() => tool.setHoveredThreadId(null)}
                  onFocus={() => tool.setHoveredThreadId(thread.id)}
                  onBlur={() => tool.setHoveredThreadId(null)}
                  onClick={() => tool.openThread(thread.id, { fly: true })}
                >
                  <UserAvatar userId={first?.authorId ?? thread.createdBy} name={authorName} size={24} title="" />
                  <span className="rv-comments-panel__item-body">
                    <span className="rv-comments-panel__item-meta">
                      <span className="rv-comments-panel__item-name" data-rv-no-translate="true">{authorName}</span>
                      <span className="rv-comments-panel__item-time">{formatRelativeTime(lastActivity(thread), now, locale)}</span>
                      {unread ? <span className="rv-comments-panel__dot" aria-label={t('Non lu')} /> : null}
                    </span>
                    <span className="rv-comments-panel__item-text" data-rv-no-translate="true">{first?.text}</span>
                    <span className="rv-comments-panel__item-footer">
                      {replies > 0 ? <span>{replies === 1 ? t('1 réponse') : t('{{count}} réponses', { count: replies })}</span> : null}
                      {route ? <span>{t('km {{km}}', { km: route.distanceKm.toFixed(1).replace('.', ',') })}</span> : null}
                      {thread.zone ? <span className="rv-comments-panel__tag"><IconZone size={12} />{t('Zone')}</span> : null}
                      {mentioned ? <span className="rv-comments-panel__tag rv-comments-panel__tag--mention">{t('@ vous')}</span> : null}
                      {thread.resolvedAt !== undefined ? <span className="rv-comments-panel__tag"><IconResolve size={12} />{t('Résolu')}</span> : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <CommentPopover anchorEl={menuAnchor} open={menuAnchor !== null} onClose={() => setMenuAnchor(null)} width={260} className="rv-dropdown">
        {SORTS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="menuitemradio"
            aria-checked={sort === option.id}
            className={`rv-dropdown__item${sort === option.id ? ' is-selected' : ''}`}
            disabled={option.id === 'route' && !tool.activeItinerary?.gpxRoute}
            onClick={() => tool.setViewOptions({ sort: option.id })}
          >
            <span className="rv-dropdown__label">{t(option.label)}</span>
          </button>
        ))}
        <div className="rv-dropdown__divider" role="separator" />
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={showResolved}
          className={`rv-dropdown__item${showResolved ? ' is-selected' : ''}`}
          onClick={() => tool.setViewOptions({ showResolved: !showResolved })}
        >
          <span className="rv-dropdown__label">{t('Afficher les résolus')}</span>
        </button>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={onlyMine}
          className={`rv-dropdown__item${onlyMine ? ' is-selected' : ''}`}
          onClick={() => tool.setViewOptions({ onlyMine: !onlyMine })}
        >
          <span className="rv-dropdown__label">{t('Seulement mes fils')}</span>
        </button>
        <div className="rv-dropdown__divider" role="separator" />
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={!tool.pinsHidden}
          className={`rv-dropdown__item${tool.pinsHidden ? '' : ' is-selected'}`}
          title={t('Maj+C')}
          onClick={tool.togglePinsHidden}
        >
          <span className="rv-dropdown__label">{t('Bulles visibles hors du mode commentaire')}</span>
        </button>
      </CommentPopover>
    </section>
  );
}
