import { useEffect, useRef, useState } from 'react';

import { useAppI18n } from '@/shared/i18n';
import { IconEye, IconPlus, IconTrash } from '../icons';
import type { Itinerary, RouteProfile } from '../../types';

interface ItineraryTabsProps {
  itineraries: Itinerary[];
  profiles: RouteProfile[];
  activeId: string;
  onSelect?: (id: string) => void;
  onAdd?: () => void;
  onAddButtonRef?: (element: HTMLButtonElement | null) => void;
  /** Optional remove-itinerary handler. When provided AND there is more than
   * one itinerary, each tab shows a small trash button next to its name. */
  onRemove?: (id: string) => void;
  /**
   * Inline-rename handler. When provided, double-clicking the active tab's
   * label (or single-click on the already-active tab) opens an input field.
   * Confirmed values propagate to every consumer of the project store
   * (center panel synth, right-panel "Itinéraires" section, etc.).
   */
  onRename?: (id: string, name: string) => void;
}

export function ItineraryTabs({
  itineraries,
  profiles,
  activeId,
  onSelect,
  onAdd,
  onAddButtonRef,
  onRemove,
  onRename,
}: ItineraryTabsProps) {
  const { t } = useAppI18n();
  const canRemove = itineraries.length > 1 && Boolean(onRemove);
  const canRename = Boolean(onRename);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editingId) return;
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [editingId]);

  const startEdit = (it: Itinerary) => {
    if (!canRename) return;
    setEditingId(it.id);
    setDraft(it.name);
  };

  const commit = (id: string) => {
    const trimmed = draft.trim();
    if (trimmed && onRename) onRename(id, trimmed);
    setEditingId(null);
  };

  const cancel = () => setEditingId(null);

  const resolveProfileLabel = (profileId: string) => {
    const profile = profiles.find((item) => item.id === profileId);
    if (profile) return profile.name;
    return t('Personnalisé');
  };

  return (
    <nav className="rvi-itins" aria-label={t('Itinéraires')}>
      {itineraries.map((it) => {
        const isActive = it.id === activeId;
        const isEditing = editingId === it.id;
        const profileLabel = resolveProfileLabel(it.profileId);
        return (
          <div
            key={it.id}
            className={`rvi-itin-wrap${isActive ? ' is-active' : ''}${it.visible === false ? ' is-hidden' : ''}`}
          >
            <button
              type="button"
              className={`rvi-itin${isActive ? ' is-active' : ''}`}
              onClick={() => {
                if (isEditing) return;
                if (isActive && canRename) {
                  startEdit(it);
                } else {
                  onSelect?.(it.id);
                }
              }}
              onDoubleClick={() => {
                if (canRename) startEdit(it);
              }}
              aria-pressed={isActive}
            >
              <span className="rvi-itin__eye" aria-hidden>
                <IconEye size={16} />
              </span>
              <span className="rvi-itin__swatch" style={{ background: it.color }} />
              <span className="rvi-itin__main">
                {isEditing ? (
                  <input
                    ref={inputRef}
                    className="rvi-itin__label rvi-itin__label--edit"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commit(it.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commit(it.id);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancel();
                      }
                    }}
                    aria-label={t('Renommer {{name}}', { name: it.name })}
                  />
                ) : (
                  <span
                    className="rvi-itin__label"
                    title={canRename ? t('Cliquer à nouveau pour renommer') : it.name}
                  >
                    {it.name}
                  </span>
                )}
              </span>
              <span className="rvi-itin__meta">
                {it.gpxRoute ? (
                  <span className="rvi-itin__badge" title={t('Itinéraire chargé depuis un GPX')}>
                    GPX
                  </span>
                ) : null}
                <span className="rvi-itin__profile" title={profileLabel}>
                  {profileLabel}
                </span>
              </span>
            </button>
            {canRemove ? (
              <button
                type="button"
                className="rvi-itin__remove"
                aria-label={t('Supprimer {{name}}', { name: it.name })}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove?.(it.id);
                }}
              >
                <IconTrash size={11} />
              </button>
            ) : null}
          </div>
        );
      })}
      <button
        ref={onAddButtonRef}
        type="button"
        className="rvi-itin rvi-itin--add"
        onClick={onAdd}
      >
        <span className="rvi-itin__add-icon" aria-hidden>
          <IconPlus size={13} />
        </span>
        <span className="rvi-itin__label">{t('Nouvel itinéraire')}</span>
      </button>
    </nav>
  );
}