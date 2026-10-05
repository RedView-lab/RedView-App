import { useAppI18n } from '@/shared/i18n';

import { COMMENT_REACTIONS } from '../lib/commentActions';
import { CommentPopover } from './CommentPopover';

interface ReactionPickerProps {
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose(): void;
  onPick(emoji: string): void;
  /** Emojis déjà posés par l'utilisateur (marqués). */
  selected?: ReadonlySet<string>;
}

/** Réactions rapides (comme le sélecteur de Figma) ; aussi l'emoji de la saisie. */
export function ReactionPicker({ anchorEl, open, onClose, onPick, selected }: ReactionPickerProps) {
  const { t } = useAppI18n();
  return (
    <CommentPopover anchorEl={anchorEl} open={open} onClose={onClose} width={4 * 36 + 8} role="dialog" label={t('Réactions')} className="rv-comment-reactions">
      {COMMENT_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className={`rv-comment-reactions__emoji${selected?.has(emoji) ? ' is-selected' : ''}`}
          aria-pressed={selected?.has(emoji) ?? undefined}
          data-rv-no-translate="true"
          onClick={() => {
            onPick(emoji);
            onClose();
          }}
        >
          {emoji}
        </button>
      ))}
    </CommentPopover>
  );
}
