import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { MapCanvasGlassBackdrop } from '@/components/MapCanvasGlassBackdrop';
import { SvgV2Icon } from '@/components/SvgV2Icon';
import {
  IconCheck,
  IconDotsVertical,
  IconEye,
  IconSettingsSliders,
} from './CenterPanelIcons';
import {
  useProjectStoreOptional,
  type Itinerary,
} from '@/features/itineraryPanel';
import { IconCopy04, IconTrash } from '@/features/itineraryPanel/components/icons';

const PLACEHOLDER = '--';
const MENU_WIDTH = 270;
const MENU_ROW_HEIGHT = 32;
const MENU_GAP = 6;
const RENAME_MENU_HEIGHT = 112;

const HEADER_CELLS = [
  'Distance',
  'Durée',
  'Dénivelé /',
  'Dénivelé -',
  'Pente moyenne',
  'Tarmac',
  'Off-road',
  '7%',
  '7%',
  '7%',
];

function formatDistance(km: number | undefined): string {
  if (km == null || !Number.isFinite(km)) return PLACEHOLDER;
  return km.toFixed(2);
}

function formatDuration(sec: number | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return PLACEHOLDER;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

function formatAscent(m: number | undefined): string {
  if (m == null || !Number.isFinite(m)) return PLACEHOLDER;
  return `+${Math.round(m)}`;
}

function formatDescent(m: number | undefined): string {
  if (m == null || !Number.isFinite(m)) return PLACEHOLDER;
  return `-${Math.round(m)}`;
}

function formatPercent(p: number | undefined): string {
  if (p == null || !Number.isFinite(p)) return PLACEHOLDER;
  return `${Math.round(p)}%`;
}

/**
 * Pull the active distance for an itinerary. Prefers the explicit
 * `metrics.distanceKm` (set by the BRouter recompute) but falls back to
 * the timeline "end" row's `distanceKm` for projects that pre-date the
 * `metrics` field.
 */
function itineraryDistanceKm(it: Itinerary): number | undefined {
  if (it.metrics?.distanceKm != null) return it.metrics.distanceKm;
  const endRow = it.timeline.find((r) => r.kind === 'end');
  return endRow?.distanceKm ?? undefined;
}

function buildValues(it: Itinerary): string[] {
  const m = it.metrics ?? {};
  return [
    formatDistance(itineraryDistanceKm(it)),
    formatDuration(m.durationSec),
    formatAscent(m.ascentM),
    formatDescent(m.descentM),
    formatPercent(m.avgSlopePercent),
    formatPercent(m.tarmacPercent),
    formatPercent(m.offroadPercent),
    PLACEHOLDER,
    PLACEHOLDER,
    PLACEHOLDER,
  ];
}

const EMPTY_VALUES: string[] = HEADER_CELLS.map(() => PLACEHOLDER);

interface SummaryRowProps {
  itinerary: Itinerary;
  onToggleAnalysisVisibility?: (id: string, visible: boolean) => void;
  onOpenMenu?: (itinerary: Itinerary, anchorEl: HTMLButtonElement) => void;
}

function SummaryRow({ itinerary, onToggleAnalysisVisibility, onOpenMenu }: SummaryRowProps) {
  const values = buildValues(itinerary);
  const analysisVisible = itinerary.analysisVisible !== false;
  return (
    <div className="rvc-center-summary__row rvc-center-summary__row--item">
      <div
        className="rvc-center-summary__route"
        style={{ opacity: analysisVisible ? 1 : 0.45 }}
      >
        <button
          type="button"
          className="rvc-center-summary__eye-button"
          onClick={() => onToggleAnalysisVisibility?.(itinerary.id, !analysisVisible)}
          aria-pressed={analysisVisible}
          aria-label={analysisVisible ? 'Masquer le graphique' : 'Afficher le graphique'}
          title={analysisVisible ? 'Masquer le graphique' : 'Afficher le graphique'}
          data-visible={analysisVisible ? 'true' : 'false'}
        >
          <IconEye size={14} />
        </button>
        <span
          className="rvc-center-summary__color"
          aria-hidden="true"
          style={{ background: itinerary.color }}
        />
        <span
          className="rvc-center-summary__name"
          title={itinerary.name}
        >
          {itinerary.name}
        </span>
      </div>
      <div className="rvc-center-summary__metrics">
        {values.map((cell, index) => (
          <div
            key={`${itinerary.id}-${index}`}
            className="rvc-center-summary__metric"
            title={`${HEADER_CELLS[index]}: ${cell}`}
          >
            {cell}
          </div>
        ))}
      </div>
      <button
        className="rvc-center-summary__ghost-button"
        type="button"
        aria-label={`Plus d'options pour ${itinerary.name}`}
        onClick={(event) => onOpenMenu?.(itinerary, event.currentTarget)}
      >
        <IconDotsVertical size={16} />
      </button>
    </div>
  );
}

function EmptyRow() {
  return (
    <div className="rvc-center-summary__row rvc-center-summary__row--item">
      <div className="rvc-center-summary__route" style={{ opacity: 0.5 }}>
        <span className="rvc-center-summary__eye" aria-hidden="true">
          <IconEye size={14} />
        </span>
        <span
          className="rvc-center-summary__color"
          aria-hidden="true"
          style={{ background: 'rgba(255,255,255,0.18)' }}
        />
        <span className="rvc-center-summary__name">Aucun itinéraire</span>
      </div>
      <div className="rvc-center-summary__metrics">
        {EMPTY_VALUES.map((cell, index) => (
          <div
            key={`empty-${index}`}
            className="rvc-center-summary__metric"
            title={cell}
          >
            {cell}
          </div>
        ))}
      </div>
      <button
        className="rvc-center-summary__ghost-button"
        type="button"
        aria-label="Plus d'options"
        disabled
      >
        <IconDotsVertical size={16} />
      </button>
    </div>
  );
}

type SummaryMenuMode = 'actions' | 'rename';

interface SummaryActionMenuProps {
  itinerary: Itinerary;
  anchorEl: HTMLButtonElement;
  mode: SummaryMenuMode;
  draft: string;
  canDelete: boolean;
  onDraftChange: (value: string) => void;
  onClose: () => void;
  onStartRename: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function SummaryActionMenu({
  itinerary,
  anchorEl,
  mode,
  draft,
  canDelete,
  onDraftChange,
  onClose,
  onStartRename,
  onRename,
  onDuplicate,
  onDelete,
}: SummaryActionMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const firstActionRef = useRef<HTMLButtonElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<{
    top: number;
    left: number;
    scale: number;
    fontFamily: string;
    transformOrigin: string;
  } | null>(null);

  useEffect(() => {
    const onDocPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorEl.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchorEl, onClose]);

  useEffect(() => {
    const handle = window.requestAnimationFrame(() => {
      if (mode === 'rename') {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
        return;
      }
      firstActionRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(handle);
  }, [mode]);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const rect = anchorEl.getBoundingClientRect();
      const computed = window.getComputedStyle(anchorEl);
      const rawScale = Number.parseFloat(computed.getPropertyValue('--app-scale'));
      const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
      const menuHeight = (mode === 'rename' ? RENAME_MENU_HEIGHT : MENU_ROW_HEIGHT * 3) * scale;
      const gap = MENU_GAP * scale;
      const maxLeft = Math.max(8, window.innerWidth - MENU_WIDTH * scale - 8);
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const placeAbove = spaceBelow < menuHeight && rect.top > spaceBelow;

      setMenuStyle({
        top: placeAbove ? rect.top - menuHeight - gap : rect.bottom + gap,
        left: Math.min(rect.left, maxLeft),
        scale,
        fontFamily: computed.fontFamily,
        transformOrigin: placeAbove ? 'bottom left' : 'top left',
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    const resizeObserver = new ResizeObserver(updatePosition);
    resizeObserver.observe(anchorEl);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorEl, mode]);

  if (!menuStyle) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="rvc-center-summary__menu"
      role="menu"
      aria-label={`Actions pour ${itinerary.name}`}
      style={{
        top: menuStyle.top,
        left: menuStyle.left,
        width: MENU_WIDTH,
        transform: `scale(${menuStyle.scale})`,
        transformOrigin: menuStyle.transformOrigin,
        fontFamily: menuStyle.fontFamily,
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <MapCanvasGlassBackdrop blur={34} saturate={1.85} tint="rgba(10, 10, 12, 0.46)" />

      {mode === 'rename' ? (
        <>
          <div className="rvc-center-summary__rename-panel">
            <div className="rvc-center-summary__rename-title">Renommer la trace</div>
            <input
              ref={renameInputRef}
              className="rvc-center-summary__rename-input"
              value={draft}
              onChange={(event: ChangeEvent<HTMLInputElement>) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onRename();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  onClose();
                }
              }}
              aria-label={`Nouveau nom pour ${itinerary.name}`}
            />
          </div>
          <div className="rvc-center-summary__rename-actions">
            <button
              type="button"
              className="rvc-center-summary__menu-item"
              onClick={onClose}
            >
              <span className="rvc-center-summary__menu-label">Annuler</span>
              <span className="rvc-center-summary__menu-icon" aria-hidden>
                <SvgV2Icon name="x-close.svg" size={16} />
              </span>
            </button>
            <button
              type="button"
              className="rvc-center-summary__menu-item"
              onClick={onRename}
              disabled={!draft.trim()}
            >
              <span className="rvc-center-summary__menu-label">Valider</span>
              <span className="rvc-center-summary__menu-icon" aria-hidden>
                <IconCheck size={14} />
              </span>
            </button>
          </div>
        </>
      ) : (
        <>
          <button
            ref={firstActionRef}
            type="button"
            className="rvc-center-summary__menu-item"
            role="menuitem"
            onClick={onStartRename}
          >
            <span className="rvc-center-summary__menu-label">Renommer la trace</span>
            <span className="rvc-center-summary__menu-icon" aria-hidden>
              <SvgV2Icon name="edit-05.svg" size={16} />
            </span>
          </button>
          <button
            type="button"
            className="rvc-center-summary__menu-item"
            role="menuitem"
            onClick={onDuplicate}
          >
            <span className="rvc-center-summary__menu-label">Dupliquer la trace</span>
            <span className="rvc-center-summary__menu-icon" aria-hidden>
              <IconCopy04 size={16} />
            </span>
          </button>
          <button
            type="button"
            className="rvc-center-summary__menu-item rvc-center-summary__menu-item--danger"
            role="menuitem"
            onClick={onDelete}
            disabled={!canDelete}
          >
            <span className="rvc-center-summary__menu-label">Supprimer la trace</span>
            <span className="rvc-center-summary__menu-icon" aria-hidden>
              <IconTrash size={14} />
            </span>
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

export function CenterPanelSummary() {
  const store = useProjectStoreOptional();
  const itineraries = store?.project.itineraries ?? [];
  const handleToggleAnalysisVisibility =
    store?.setItineraryAnalysisVisibility;
  const [menuState, setMenuState] = useState<{
    itineraryId: string;
    anchorEl: HTMLButtonElement;
    mode: SummaryMenuMode;
    draft: string;
  } | null>(null);

  const selectedItinerary = menuState
    ? itineraries.find((itinerary) => itinerary.id === menuState.itineraryId) ?? null
    : null;

  useEffect(() => {
    if (menuState && !selectedItinerary) {
      setMenuState(null);
    }
  }, [menuState, selectedItinerary]);

  const handleOpenMenu = (itinerary: Itinerary, anchorEl: HTMLButtonElement) => {
    setMenuState((current) => {
      if (current && current.itineraryId === itinerary.id && current.anchorEl === anchorEl) {
        return null;
      }
      return {
        itineraryId: itinerary.id,
        anchorEl,
        mode: 'actions',
        draft: itinerary.name,
      };
    });
  };

  const handleCloseMenu = () => setMenuState(null);

  const handleRename = () => {
    if (!selectedItinerary || !menuState) return;
    const trimmed = menuState.draft.trim();
    if (!trimmed) return;
    store?.setItineraryName(selectedItinerary.id, trimmed);
    setMenuState(null);
  };

  const handleDuplicate = () => {
    if (!selectedItinerary) return;
    store?.duplicateItinerary(selectedItinerary.id);
    setMenuState(null);
  };

  const handleDelete = () => {
    if (!selectedItinerary) return;
    store?.removeItinerary(selectedItinerary.id);
    setMenuState(null);
  };

  return (
    <section className="rvc-center-summary" aria-label="Synthèse d'itinéraire">
      <div className="rvc-center-summary__row rvc-center-summary__row--header">
        <div className="rvc-center-summary__title">Synthèse</div>
        <div className="rvc-center-summary__metrics" aria-hidden="true">
          {HEADER_CELLS.map((cell) => (
            <div
              key={cell}
              className="rvc-center-summary__metric rvc-center-summary__metric--header"
              title={cell}
            >
              {cell}
            </div>
          ))}
        </div>
        <button
          className="rvc-center-summary__icon-button"
          type="button"
          aria-label="Réglages"
        >
          <IconSettingsSliders size={16} />
        </button>
      </div>

      {itineraries.length === 0 ? (
        <EmptyRow />
      ) : (
        itineraries.map((it) => (
          <SummaryRow
            key={it.id}
            itinerary={it}
            onToggleAnalysisVisibility={handleToggleAnalysisVisibility}
            onOpenMenu={handleOpenMenu}
          />
        ))
      )}

      {menuState && selectedItinerary ? (
        <SummaryActionMenu
          itinerary={selectedItinerary}
          anchorEl={menuState.anchorEl}
          mode={menuState.mode}
          draft={menuState.draft}
          canDelete={itineraries.length > 1}
          onDraftChange={(draft) =>
            setMenuState((current) => (current ? { ...current, draft } : current))
          }
          onClose={handleCloseMenu}
          onStartRename={() =>
            setMenuState((current) =>
              current
                ? { ...current, mode: 'rename', draft: selectedItinerary.name }
                : current,
            )
          }
          onRename={handleRename}
          onDuplicate={handleDuplicate}
          onDelete={handleDelete}
        />
      ) : null}
    </section>
  );
}
