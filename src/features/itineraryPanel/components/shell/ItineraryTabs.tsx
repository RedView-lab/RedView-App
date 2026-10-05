import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useAppI18n } from '@/shared/i18n';
import { appScaledOverlayStyle, readAppScale } from '@/shared/lib/appScale';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { IconEye, IconEyeOff, IconKebab, IconPlus, IconTrash } from '../icons';
import type { Itinerary, RouteProfile } from '../../types';

const MENU_WIDTH = 140;
const MENU_MAX_HEIGHT = 90;
const MENU_GAP = 6;
const VIEWPORT_PADDING = 8;

interface ItineraryTabsProps {
  itineraries: Itinerary[];
  profiles: RouteProfile[];
  activeId: string;
  /**
   * Name of a GPX file currently being parsed. While set, a non-interactive
   * "loading" row is rendered after the real itineraries and before the add
   * button, so the user sees the import in flight in the same list that will
   * hold the result. The row is replaced by the actual itinerary row as soon as
   * `addItineraryFromGpxFile` resolves.
   */
  pendingImportName?: string | null;
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
  pendingImportName,
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
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; scale: number } | null>(null);
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
      const scale = readAppScale(trigger);
      const menuWidth = MENU_WIDTH * scale;
      const rawLeft = rect.right - menuWidth;
      const maxLeft = window.innerWidth - menuWidth - VIEWPORT_PADDING;
      const left = Math.max(VIEWPORT_PADDING, Math.min(rawLeft, maxLeft));
      const top = Math.min(
        rect.bottom + MENU_GAP * scale,
        window.innerHeight - VIEWPORT_PADDING - MENU_MAX_HEIGHT * scale,
      );
      setMenuPosition({ top, left, scale });
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

  const resolveProfileLabel = (profileId: string, activityType?: string) => {
    const profile = profiles.find((item) => item.id === profileId);
    if (profile) return profile.name;
    if (activityType) {
      const actProfile = profiles.find((item) => item.id === activityType);
      if (actProfile) return actProfile.name;
    }
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
          const profileLabel =
            it.discipline === 'trail'
              ? t('Trail')
              : it.discipline === 'running'
                ? t('Running')
                : resolveProfileLabel(it.profileId, it.roadTypes?.activityType);
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
                  aria-pressed={it.visible !== false}
                  title={it.visible !== false ? t('Masquer l’itinéraire') : t('Afficher l’itinéraire')}
                >
                  {it.visible !== false ? <IconEye size={16} /> : <IconEyeOff size={16} />}
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
        {/* GPX import in flight: a non-interactive row in the same list that
            will receive the parsed itinerary, so the result lands where the
            user is already looking. */}
        {pendingImportName ? (
          <div className="rvi-itin-wrap rvi-itin-wrap--pending" aria-live="polite">
            <div className="rvi-itin rvi-itin--pending">
              <span className="rvi-itin__spinner" aria-hidden />
              <div className="rvi-itin__main">
                <span className="rvi-itin__label-wrap">
                  <span className="rvi-itin__label" title={pendingImportName}>
                    {pendingImportName}
                  </span>
                </span>
                <span className="rvi-itin__meta">
                  <span className="rvi-itin__profile" title={t('Chargement…')}>
                    {t('Chargement…')}
                  </span>
                </span>
              </div>
            </div>
          </div>
        ) : null}
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
              className="rv-dropdown rvi-itin-actions-menu"
              role="menu"
              aria-label={t('Actions de l’itinéraire')}
              style={{
                ...appScaledOverlayStyle(menuPosition),
                width: MENU_WIDTH,
              }}
            >
              {canRename ? (
                <button
                  type="button"
                  className="rv-dropdown__item"
                  role="menuitem"
                  onClick={() => startEdit(menuItinerary)}
                >
                  <span className="rv-dropdown__label">{t('Renommer')}</span>
                  <span className="rv-dropdown__icon" aria-hidden>
                    <SvgV2Icon name="edit-05.svg" size={16} />
                  </span>
                </button>
              ) : null}
              {canDuplicate ? (
                <button
                  type="button"
                  className="rv-dropdown__item"
                  role="menuitem"
                  onClick={() => {
                    onDuplicate?.(menuItinerary.id);
                    setOpenMenuId(null);
                    setMenuPosition(null);
                  }}
                >
                  <span className="rv-dropdown__label">{t('Dupliquer')}</span>
                  <span className="rv-dropdown__icon" aria-hidden>
                    <SvgV2Icon name="copy-04.svg" size={16} />
                  </span>
                </button>
              ) : null}
              {canRemove ? (
                <button
                  type="button"
                  className="rv-dropdown__item rv-dropdown__item--danger"
                  role="menuitem"
                  onClick={() => {
                    onRemove?.(menuItinerary.id);
                    setOpenMenuId(null);
                    setMenuPosition(null);
                  }}
                >
                  <span className="rv-dropdown__label">{t('Supprimer')}</span>
                  <span className="rv-dropdown__icon" aria-hidden>
                    <IconTrash size={14} />
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