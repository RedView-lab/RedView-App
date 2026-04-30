import { useEffect, useRef, useState } from 'react';

import { IconEye, IconPlusCircle, IconTrash } from '../icons';
import type { Itinerary } from '../../types';

interface ItineraryTabsProps {
  itineraries: Itinerary[];
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
  activeId,
  onSelect,
  onAdd,
  onAddButtonRef,
  onRemove,
  onRename,
}: ItineraryTabsProps) {
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

  return (
    <nav className="rvi-itins" aria-label="Itinéraires">
      {itineraries.map((it) => {
        const isActive = it.id === activeId;
        const isEditing = editingId === it.id;
        return (
          <span
            key={it.id}
            className={`rvi-itin-wrap${isActive ? ' is-active' : ''}`}
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
            >
              <span className="rvi-itin__eye" aria-hidden>
                <IconEye size={16} />
              </span>
              <span className="rvi-itin__swatch" style={{ background: it.color }} />
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
                  aria-label={`Renommer ${it.name}`}
                />
              ) : (
                <span
                  className="rvi-itin__label"
                  title={canRename ? 'Cliquer à nouveau pour renommer' : it.name}
                >
                  {it.name}
                </span>
              )}
              {it.gpxRoute ? (
                <span className="rvi-itin__badge" title="Itinéraire chargé depuis un GPX">
                  GPX
                </span>
              ) : null}
            </button>
            {canRemove ? (
              <button
                type="button"
                className="rvi-itin__remove"
                aria-label={`Supprimer ${it.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove?.(it.id);
                }}
              >
                <IconTrash size={11} />
              </button>
            ) : null}
          </span>
        );
      })}
      <button
        ref={onAddButtonRef}
        type="button"
        className="rvi-itin rvi-itin--add"
        onClick={onAdd}
      >
        <IconPlusCircle size={12} />
        <span className="rvi-itin__label">Nouvel itinéraire</span>
      </button>
    </nav>
  );
}