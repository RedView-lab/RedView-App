import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MutableRefObject,
} from 'react';

import { UserAvatar } from '@/shared/components/UserAvatar/UserAvatar';
import { useAppI18n } from '@/shared/i18n';

import type { CommentTextInput } from '../lib/commentActions';
import { MAX_COMMENT_TEXT_CHARS } from '../lib/limits';
import {
  activeMentionQuery,
  extractMentions,
  filterMentionCandidates,
  insertMention,
  type MentionCandidate,
} from '../lib/messageText';
import { normalizeCommentText } from '../lib/commentActions';
import { IconAt, IconSend, IconSmile } from './icons';
import { ReactionPicker } from './ReactionPicker';

/**
 * Saisie d'un commentaire (nouveau fil, réponse, modification), comme celle de
 * Figma : petite, s'agrandit avec le texte ; Entrée envoie, Maj+Entrée va à la
 * ligne, Échap annule ; `@` propose les membres du projet (flèches + Entrée),
 * le bouton emoji insère une réaction rapide ; envoi grisé tant que c'est vide.
 */

interface CommentComposerProps {
  placeholder: string;
  /** Membres mentionnables (sans l'utilisateur). */
  candidates: readonly MentionCandidate[];
  initialText?: string;
  autoFocus?: boolean;
  /** Incrémenté : la saisie reprend le focus. */
  focusRequest?: number;
  /** Texte courant, tenu à jour pour le parent (brouillon jamais perdu). */
  textRef?: MutableRefObject<string>;
  /** Mode modification : boutons Annuler / Enregistrer au lieu de l'envoi. */
  editing?: boolean;
  onSubmit(input: CommentTextInput): boolean;
  onCancel?(): void;
}

const MAX_HEIGHT_PX = 132;
const MAX_SUGGESTIONS = 6;

export function CommentComposer({
  placeholder,
  candidates,
  initialText = '',
  autoFocus = false,
  focusRequest = 0,
  textRef,
  editing = false,
  onSubmit,
  onCancel,
}: CommentComposerProps) {
  const { t } = useAppI18n();
  const [text, setText] = useState(initialText);
  const [caret, setCaret] = useState(initialText.length);
  const [activeIndex, setActiveIndex] = useState(0);
  const [mentionDismissedAt, setMentionDismissedAt] = useState<number | null>(null);
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | null>(null);

  const query = activeMentionQuery(text, caret);
  const suggestions = query && candidates.length > 0 && mentionDismissedAt !== query.start
    ? filterMentionCandidates(candidates, query.query).slice(0, MAX_SUGGESTIONS)
    : [];
  const menuOpen = suggestions.length > 0;
  const canSend = normalizeCommentText(text) !== null;

  useEffect(() => {
    if (textRef) textRef.current = text;
  }, [text, textRef]);

  // Hauteur suivant le texte (plafonnée, puis défilement).
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(MAX_HEIGHT_PX, textarea.scrollHeight)}px`;
    if (pendingCaretRef.current !== null) {
      textarea.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current);
      pendingCaretRef.current = null;
    }
  }, [text]);

  useEffect(() => {
    if (!autoFocus && focusRequest === 0) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const frame = window.requestAnimationFrame(() => {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus, focusRequest]);

  const update = (next: string, nextCaret: number) => {
    setText(next);
    setCaret(nextCaret);
    setActiveIndex(0);
  };

  const insertAtCaret = (insert: string) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? text.length;
    const end = textarea?.selectionEnd ?? text.length;
    const next = `${text.slice(0, start)}${insert}${text.slice(end)}`.slice(0, MAX_COMMENT_TEXT_CHARS);
    pendingCaretRef.current = start + insert.length;
    update(next, start + insert.length);
    setMentionDismissedAt(null);
    textarea?.focus({ preventScroll: true });
  };

  const pickMention = (candidate: MentionCandidate) => {
    if (!query) return;
    const inserted = insertMention(text, query.start, caret, candidate.name);
    pendingCaretRef.current = inserted.caret;
    update(inserted.text, inserted.caret);
    textareaRef.current?.focus({ preventScroll: true });
  };

  const submit = () => {
    if (!canSend) return;
    const accepted = onSubmit({ text, mentions: extractMentions(text, candidates) });
    if (accepted && !editing) update('', 0);
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    update(event.target.value, event.target.selectionStart ?? event.target.value.length);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Raccourcis de l'app (C, Suppr, Ctrl+Z…) : jamais pendant la saisie.
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((index) => (index + step + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pickMention(suggestions[Math.min(activeIndex, suggestions.length - 1)]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMentionDismissedAt(query?.start ?? null);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel?.();
    }
  };

  return (
    <div className={`rv-comment-composer${editing ? ' rv-comment-composer--editing' : ''}`}>
      <textarea
        ref={textareaRef}
        className="rv-comment-composer__input"
        value={text}
        placeholder={placeholder}
        rows={1}
        maxLength={MAX_COMMENT_TEXT_CHARS}
        aria-label={placeholder}
        data-rv-no-translate="true"
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
      />
      {menuOpen ? (
        <div className="rv-comment-mentions" role="listbox" aria-label={t('Mentionner')}>
          {suggestions.map((candidate, index) => (
            <button
              key={candidate.userId}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`rv-comment-mentions__item${index === activeIndex ? ' is-active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => pickMention(candidate)}
            >
              <UserAvatar userId={candidate.userId} name={candidate.name} size={20} title="" />
              <span data-rv-no-translate="true">{candidate.name}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="rv-comment-composer__bar">
        <div className="rv-comment-composer__tools">
          {candidates.length > 0 ? (
            <button
              type="button"
              className="rv-comment-icon-button"
              aria-label={t('Mentionner quelqu’un')}
              title={t('Mentionner quelqu’un')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertAtCaret(text.length > 0 && !/\s$/.test(text.slice(0, caret)) ? ' @' : '@')}
            >
              <IconAt />
            </button>
          ) : null}
          <button
            type="button"
            className="rv-comment-icon-button"
            aria-label={t('Ajouter un emoji')}
            title={t('Ajouter un emoji')}
            aria-expanded={emojiAnchor !== null}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              const anchor = event.currentTarget;
              setEmojiAnchor((current) => (current ? null : anchor));
            }}
          >
            <IconSmile />
          </button>
          <ReactionPicker anchorEl={emojiAnchor} open={emojiAnchor !== null} onClose={() => setEmojiAnchor(null)} onPick={insertAtCaret} />
        </div>
        {editing ? (
          <div className="rv-comment-composer__actions">
            <button type="button" className="rv-comment-text-button" onClick={onCancel}>{t('Annuler')}</button>
            <button type="button" className="rv-comment-text-button rv-comment-text-button--primary" disabled={!canSend} onClick={submit}>
              {t('Enregistrer')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="rv-comment-send"
            aria-label={t('Envoyer')}
            title={t('Envoyer')}
            disabled={!canSend}
            onMouseDown={(event) => event.preventDefault()}
            onClick={submit}
          >
            <IconSend />
          </button>
        )}
      </div>
    </div>
  );
}
