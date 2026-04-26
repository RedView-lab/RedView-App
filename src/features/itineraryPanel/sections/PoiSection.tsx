import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { MapCanvasGlassBackdrop } from '@/components/MapCanvasGlassBackdrop';

import { CheckboxField } from '../components/PanelCheckbox';
import { ToggleRow } from '../components/PanelToggle';
import {
  IconCheck,
  IconChevronDown,
  IconDownloadCircle,
  IconPlusCircle,
} from '../components/icons';
import type { PoiCategory, PoiEntry, PoiState } from '../types';

const DEFAULT_REFINE_LIMIT_PER_KM = 4;

const REFINE_LIMIT_OPTIONS = [
  {
    value: 2 as const,
    label: '2 POI / type / km',
    description: 'Filtrage fort pour les centres-villes très denses.',
  },
  {
    value: 4 as const,
    label: '4 POI / type / km',
    description: 'Réglage conseillé pour éviter les grappes sans perdre les arrêts utiles.',
  },
  {
    value: 6 as const,
    label: '6 POI / type / km',
    description: 'Filtrage léger, utile quand tu veux garder plus d’options.',
  },
] as const;

interface PoiSectionProps {
  poi: PoiState;
  onChangeEntry?: (category: PoiCategory, next: PoiEntry) => void;
  onChangeRefine?: (value: boolean) => void;
  onChangeRefineLimit?: (value: 2 | 4 | 6) => void;
  onOpenCategories?: () => void;
  onLoad?: () => void;
  /** Map-level POI loading state. */
  loading?: boolean;
  /** 0..1 progress of the corridor search (chunks completed / total). */
  progress?: number | null;
  /** Number of POIs currently rendered on the map (0 when none). */
  poiCount?: number;
  /** Last error from the POI engine (Overpass / network). */
  error?: string | null;
  /**
   * When true, the "Charger" button is greyed out — typically because no
   * GPX route is attached to the active itinerary or no category is on.
   */
  disabled?: boolean;
  /** Optional helper text shown when the button is disabled. */
  disabledReason?: string | null;
}

interface PoiRefineMenuProps {
  anchorEl: HTMLElement | null;
  open: boolean;
  value: 2 | 4 | 6;
  onSelect?: (value: 2 | 4 | 6) => void;
  onClose?: () => void;
}

const POI_ROWS: { key: PoiCategory; label: string }[][] = [
  [
    { key: 'fountains', label: 'Fontaines' },
    { key: 'toilets', label: 'Toilettes' },
  ],
  [
    { key: 'supermarkets', label: 'Supermarchés' },
    { key: 'gasStations', label: 'Station Service' },
  ],
  [
    { key: 'bakeries', label: 'Boulangerie' },
    { key: 'fastFood', label: 'Fast-food' },
  ],
  [
    { key: 'cafes', label: 'Café' },
    { key: 'bars', label: 'Bar' },
  ],
  [
    { key: 'restaurants', label: 'Restaurant' },
    { key: 'bikeShops', label: 'Magasin de vélo' },
  ],
  [
    { key: 'hotels', label: 'Hôtels' },
    { key: 'refuges', label: 'Refuges' },
  ],
];

/** Parses a `"40m"`-style string into a positive integer or null. */
function parseDistance(raw: string): number | null {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function DistanceInput({
  value,
  onChange,
  ariaLabel,
}: {
  value: number | null;
  onChange?: (next: number | null) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="rvi-chip-input">
      <input
        className="rvi-chip-input__native"
        value={value !== null ? `${value}m` : ''}
        onChange={(e) => onChange?.(parseDistance(e.target.value))}
        placeholder="40m"
        aria-label={ariaLabel}
      />
    </div>
  );
}

function PoiRefineMenu({
  anchorEl,
  open,
  value,
  onSelect,
  onClose,
}: PoiRefineMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<{
    top: number;
    left: number;
    width: number;
    scale: number;
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
  } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchorEl) {
      setMenuStyle(null);
      return;
    }

    const update = () => {
      const rect = anchorEl.getBoundingClientRect();
      const computed = window.getComputedStyle(anchorEl);
      const rawScale = Number.parseFloat(computed.getPropertyValue('--app-scale'));
      const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
      const menuWidth = 248 * scale;
      const menuHeight = 188 * scale;
      const offset = 6 * scale;
      const maxLeft = Math.max(8, window.innerWidth - menuWidth - 8);
      const left = Math.min(Math.max(8, rect.left), maxLeft);
      const topBelow = rect.bottom + offset;
      const topAbove = rect.top - menuHeight - offset;
      const top =
        topBelow + menuHeight > window.innerHeight - 8 && topAbove >= 8
          ? topAbove
          : topBelow;

      setMenuStyle({
        top,
        left,
        width: 248,
        scale,
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        lineHeight: computed.lineHeight,
      });
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorEl, open]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onClose?.();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose?.();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorEl, onClose, open]);

  if (!open || !anchorEl || !menuStyle) {
    return null;
  }

  return createPortal(
    <div
      ref={menuRef}
      className="rvi-poi-refine-menu"
      role="dialog"
      aria-label="Réglage de l’affinage POI"
      style={{
        top: menuStyle.top,
        left: menuStyle.left,
        width: menuStyle.width,
        transform: `scale(${menuStyle.scale})`,
        transformOrigin: 'top left',
        fontFamily: menuStyle.fontFamily,
        fontSize: menuStyle.fontSize,
        fontWeight: menuStyle.fontWeight,
        lineHeight: menuStyle.lineHeight,
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <MapCanvasGlassBackdrop blur={60} saturate={1.8} />
      <div className="rvi-poi-refine-menu__head">
        <div className="rvi-poi-refine-menu__title">Limiter les doublons urbains</div>
        <div className="rvi-poi-refine-menu__sub">
          Garde seulement un nombre max de POI d’un même type sur une fenêtre glissante de 1 km.
        </div>
      </div>
      <div className="rvi-poi-refine-menu__options" role="radiogroup" aria-label="Limite POI par kilomètre">
        {REFINE_LIMIT_OPTIONS.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`rvi-poi-refine-menu__option${selected ? ' is-selected' : ''}`}
              onClick={() => {
                onSelect?.(option.value);
                onClose?.();
              }}
            >
              <span className="rvi-poi-refine-menu__option-copy">
                <span className="rvi-poi-refine-menu__option-label">{option.label}</span>
                <span className="rvi-poi-refine-menu__option-sub">{option.description}</span>
              </span>
              {selected ? <IconCheck size={16} className="rvi-poi-refine-menu__option-check" /> : null}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

export function PoiSection({
  poi,
  onChangeEntry,
  onChangeRefine,
  onChangeRefineLimit,
  onOpenCategories,
  onLoad,
  loading = false,
  progress = null,
  poiCount = 0,
  error = null,
  disabled = false,
}: PoiSectionProps) {
  const [refineMenuOpen, setRefineMenuOpen] = useState(false);
  const refineButtonRef = useRef<HTMLButtonElement | null>(null);
  const refineLimit = poi.refineLimitPerKm ?? DEFAULT_REFINE_LIMIT_PER_KM;
  const buttonDisabled = disabled || loading;
  const pct =
    progress !== null && Number.isFinite(progress)
      ? Math.max(0, Math.min(100, Math.round(progress * 100)))
      : null;
  const buttonLabel = loading
    ? pct !== null
      ? `Recherche… ${pct}%`
      : 'Recherche…'
    : poiCount > 0
      ? `Recharger (${poiCount})`
      : 'Rechercher';

  useEffect(() => {
    if (!poi.refineResults) {
      setRefineMenuOpen(false);
    }
  }, [poi.refineResults]);

  const handleRefineToggle = (next: boolean) => {
    onChangeRefine?.(next);
    setRefineMenuOpen(next);
  };

  return (
    <div className="rvi-params">
      <div className="rvi-divider" />

      {POI_ROWS.map((row) => (
        <div key={row.map((c) => c.key).join('-')} className="rvi-row">
          {row.map((cell) => {
            const entry = poi[cell.key];
            return (
              <CheckboxField
                key={cell.key}
                checked={entry.enabled}
                onToggle={(v) =>
                  onChangeEntry?.(cell.key, {
                    ...entry,
                    enabled: v,
                    distanceM: v ? entry.distanceM ?? 40 : entry.distanceM,
                  })
                }
                label={cell.label}
                trailing={
                  <DistanceInput
                    value={entry.distanceM}
                    onChange={(dist) =>
                      onChangeEntry?.(cell.key, { ...entry, distanceM: dist })
                    }
                    ariaLabel={`Distance ${cell.label}`}
                  />
                }
              />
            );
          })}
        </div>
      ))}

      <div className="rvi-row rvi-poi-refine">
        <div className="rvi-poi-refine__toggle">
          <ToggleRow
            checked={poi.refineResults}
            onChange={handleRefineToggle}
            label="Affiner les résultats (beta)"
          />
        </div>
        <button
          type="button"
          className="rvi-categories-btn"
          onClick={onOpenCategories}
        >
          <IconPlusCircle size={16} />
          <span className="rvi-categories-btn__label">Catégories</span>
          <IconChevronDown size={14} className="rvi-categories-btn__chevron" />
        </button>
      </div>

      {poi.refineResults ? (
        <div className="rvi-poi-refine__config-row">
          <button
            ref={refineButtonRef}
            type="button"
            className={`rvi-poi-refine__config-btn${refineMenuOpen ? ' is-open' : ''}`}
            onClick={() => setRefineMenuOpen((open) => !open)}
          >
            <span className="rvi-poi-refine__config-copy">
              <span className="rvi-poi-refine__config-label">Filtre ville</span>
              <span className="rvi-poi-refine__config-value">{refineLimit} POI / type / km</span>
            </span>
            <IconChevronDown size={14} className="rvi-poi-refine__config-chevron" />
          </button>
        </div>
      ) : null}

      <button
        type="button"
        className={`rvi-redbtn rvi-redbtn--full${buttonDisabled ? ' is-disabled' : ''}`}
        onClick={onLoad}
        disabled={buttonDisabled}
        aria-busy={loading}
      >
        <IconDownloadCircle size={16} />
        <span>{buttonLabel}</span>
      </button>

      {error ? (
        <div className="rvi-poi-msg rvi-poi-msg--error" role="alert">
          {error}
        </div>
      ) : null}

      <PoiRefineMenu
        anchorEl={refineButtonRef.current}
        open={refineMenuOpen}
        value={refineLimit}
        onSelect={(value) => onChangeRefineLimit?.(value)}
        onClose={() => setRefineMenuOpen(false)}
      />
    </div>
  );
}
