import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useAppI18n } from '@/shared/i18n';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { IconEye, IconPlus, IconTrash } from '../icons';
import type { Itinerary, RouteProfile } from '../../types';

const MENU_WIDTH = 104;
const MENU_GAP = 6;
const VIEWPORT_PADDING = 8;

function IconKebab({ size = 14 }: { size?: number }) {
  const radius = Math.max(1.1, size * 0.1);
  const centerX = size / 2;
  const offsets = [size * 0.22, size / 2, size * 0.78];

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" aria-hidden>
      {offsets.map((centerY) => (
        <circle key={centerY} cx={centerX} cy={centerY} r={radius} fill="currentColor" />
      ))}
    </svg>
  );
}

interface ItineraryTabsProps {
  itineraries: Itinerary[];
  profiles: RouteProfile[];
  activeId: string;
  onSelect?: (id: string) => void;
  onToggleVisibility?: (id: string) => void;
  onAdd?: () => void;
  onAddButtonRef?: (element: HTMLButtonElement | null) => void;
  onDuplicate?: (id: string) => void;
  onRemove?: (id: string) => void;
  /**
    * Inline-rename handler. When provided, the overflow menu can switch the
    * current row into edit mode.
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
  onToggleVisibility,
  onAdd,
  onAddButtonRef,
  onDuplicate,
  onRemove,
  onRename,
}: ItineraryTabsProps) {
  const { t } = useAppI18n();
  const canRemove = Boolean(onRemove);
  const canDuplicate = Boolean(onDuplicate);
  const canRename = Boolean(onRename);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});

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
    setOpenMenuId(null);
    setMenuPosition(null);
    setEditingId(it.id);
    setDraft(it.name);
  };

  const commit = (id: string) => {
    const trimmed = draft.trim();
    if (trimmed && onRename) onRename(id, trimmed);
    setEditingId(null);
  };

  const cancel = () => setEditingId(null);

  useLayoutEffect(() => {
    if (!openMenuId) return;

    const updatePosition = () => {
      const trigger = triggerRefs.current[openMenuId];
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const rawLeft = rect.right - MENU_WIDTH;
      const maxLeft = window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING;
      const left = Math.max(VIEWPORT_PADDING, Math.min(rawLeft, maxLeft));
      const top = Math.min(
        rect.bottom + MENU_GAP,
        window.innerHeight - VIEWPORT_PADDING - 108,
      );
      setMenuPosition({ top, left });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [openMenuId]);

  useEffect(() => {
    if (!openMenuId) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const trigger = triggerRefs.current[openMenuId];
      if (menuRef.current?.contains(target) || trigger?.contains(target)) return;
      setOpenMenuId(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenuId(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenuId]);

  const resolveProfileLabel = (profileId: string) => {
    const profile = profiles.find((item) => item.id === profileId);
    if (profile) return profile.name;
    return t('Personnalisé');
  };

  const menuItinerary = openMenuId
    ? itineraries.find((itinerary) => itinerary.id === openMenuId) ?? null
    : null;

  const showMenuTrigger = canRename || canDuplicate || canRemove;

  return (
    <>
      <nav className="rvi-itins" aria-label={t('Itinéraires')}>
        {itineraries.map((it) => {
          const isActive = it.id === activeId;
          const isEditing = editingId === it.id;
          const isMenuOpen = openMenuId === it.id;
          const profileLabel = resolveProfileLabel(it.profileId);
          return (
            <div
              key={it.id}
              className={`rvi-itin-wrap${isActive ? ' is-active' : ''}${it.visible === false ? ' is-hidden' : ''}`}
            >
              <div
                role="button"
                tabIndex={0}
                className={`rvi-itin${isActive ? ' is-active' : ''}`}
                onClick={() => {
                  if (isEditing) return;
                  onSelect?.(it.id);
                }}
                onKeyDown={(e) => {
                  if (isEditing) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect?.(it.id);
                  }
                }}
                aria-pressed={isActive}
              >
                <button
                  type="button"
                  className="rvi-itin__eye"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleVisibility?.(it.id);
                  }}
                  aria-label={it.visible !== false ? t('Masquer l’itinéraire') : t('Afficher l’itinéraire')}
                  title={it.visible !== false ? t('Masquer l’itinéraire') : t('Afficher l’itinéraire')}
                >
                  <IconEye size={16} />
                </button>
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
                    <span className="rvi-itin__label" title={it.name}>
                      {it.name}
                    </span>
                  )}
                </span>
                <span className="rvi-itin__meta">
                  <span className="rvi-itin__profile" title={profileLabel}>
                    {profileLabel}
                  </span>
                </span>
              </div>
              {showMenuTrigger ? (
                <button
                  ref={(element) => {
                    triggerRefs.current[it.id] = element;
                  }}
                  type="button"
                  className={`rvi-itin__menu-trigger${isMenuOpen ? ' is-open' : ''}`}
                  aria-label={t('Actions pour {{name}}', { name: it.name })}
                  aria-haspopup="menu"
                  aria-expanded={isMenuOpen}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuPosition(null);
                    setOpenMenuId((current) => (current === it.id ? null : it.id));
                  }}
                >
                  <IconKebab size={14} />
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
      {openMenuId && menuItinerary && menuPosition && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              className="rvi-itin-actions-menu"
              role="menu"
              aria-label={t('Actions de l’itinéraire')}
              style={{ top: menuPosition.top, left: menuPosition.left, width: MENU_WIDTH }}
            >
              <MapCanvasGlassBackdrop blur={34} saturate={1.85} tint="rgba(10, 10, 12, 0.46)" />
              {canRename ? (
                <button
                  type="button"
                  className="rvi-itin-actions-menu__item"
                  role="menuitem"
                  onClick={() => startEdit(menuItinerary)}
                >
                  <span className="rvi-itin-actions-menu__label">{t('Renommer')}</span>
                  <span className="rvi-itin-actions-menu__icon" aria-hidden>
                    <SvgV2Icon name="edit-05.svg" size={12} />
                  </span>
                </button>
              ) : null}
              {canDuplicate ? (
                <button
                  type="button"
                  className="rvi-itin-actions-menu__item"
                  role="menuitem"
                  onClick={() => {
                    onDuplicate?.(menuItinerary.id);
                    setOpenMenuId(null);
                    setMenuPosition(null);
                  }}
                >
                  <span className="rvi-itin-actions-menu__label">{t('Dupliquer')}</span>
                  <span className="rvi-itin-actions-menu__icon" aria-hidden>
                    <SvgV2Icon name="copy-04.svg" size={12} />
                  </span>
                </button>
              ) : null}
              {canRemove ? (
                <button
                  type="button"
                  className="rvi-itin-actions-menu__item rvi-itin-actions-menu__item--danger"
                  role="menuitem"
                  onClick={() => {
                    onRemove?.(menuItinerary.id);
                    setOpenMenuId(null);
                    setMenuPosition(null);
                  }}
                >
                  <span className="rvi-itin-actions-menu__label">{t('Supprimer')}</span>
                  <span className="rvi-itin-actions-menu__icon" aria-hidden>
                    <IconTrash size={12} />
                  </span>
                </button>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}