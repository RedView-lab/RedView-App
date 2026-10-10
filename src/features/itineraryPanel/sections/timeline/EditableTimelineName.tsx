import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useAppI18n } from '@/shared/i18n';
import type { TimelineItem } from '../../types';
import { MAX_TIMELINE_NAME_LENGTH } from './timelineNames';

interface TimelineNameInputProps {
  item: TimelineItem;
  className: string;
  onRename: (id: string, label: string) => void;
  /** Fin de l'édition (validée ou annulée). */
  onDone: () => void;
}

/**
 * Champ d'édition du nom : Entrée / perte du focus valident, Échap annule,
 * un nom vidé revient au nom d'origine.
 */
export function TimelineNameInput({ item, className, onRename, onDone }: TimelineNameInputProps) {
  const { t } = useAppI18n();
  const [draft, setDraft] = useState(item.label);
  const commit = () => {
    if (draft.trim() !== item.label.trim()) onRename(item.id, draft);
    onDone();
  };
  return (
    <input
      type="text"
      className={className}
      value={draft}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      maxLength={MAX_TIMELINE_NAME_LENGTH}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onDone();
        }
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      aria-label={t('Modifier le nom')}
      placeholder={t('Nom d’origine')}
    />
  );
}

interface EditableTimelineNameProps {
  item: TimelineItem;
  /** Classe du nom affiché ; `${className}--editable` s'y ajoute. */
  className: string;
  inputClassName: string;
  onRename: (id: string, label: string) => void;
}

/**
 * Nom d'un POI dans la feuille de route : un clic (ou Entrée) le rend
 * modifiable — horaires, nom raccourci… — et l'export GPS le reprend tel quel.
 */
export function EditableTimelineName({ item, className, inputClassName, onRename }: EditableTimelineNameProps) {
  const { t } = useAppI18n();
  const [editing, setEditing] = useState(false);

  const startEdit = (event: MouseEvent | KeyboardEvent) => {
    event.stopPropagation();
    setEditing(true);
  };

  if (editing) {
    return <TimelineNameInput item={item} className={inputClassName} onRename={onRename} onDone={() => setEditing(false)} />;
  }

  return (
    <span
      className={`${className} ${className}--editable`}
      title={t('{{name}} · cliquer pour modifier (horaires, nom court…), repris par l’export GPS', { name: item.label })}
      onClick={startEdit}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'F2') {
          event.preventDefault();
          startEdit(event);
        }
      }}
    >
      {item.label}
    </span>
  );
}
