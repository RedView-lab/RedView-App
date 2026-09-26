import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import { IconCheck, IconChevronDown, IconStar } from '../../components/icons';
import { KindBadge } from './KindBadge';
import type { TimelineFilterState } from './TimelineFilters';
import { DASHBOARD_POI_OPTIONS } from '@/pages/Dashboard/components/DashboardPlaceSearch.constants';
import type { DashboardPoiOptionId } from '@/pages/Dashboard/components/DashboardPlaceSearch.types';
import { PoiOptionMarker } from '@/pages/Dashboard/components/DashboardPlaceSearch.icons';

interface TimelineSheetFilterPanelProps {
  filters: TimelineFilterState;
  isOverridden: boolean;
  onChangeFilters: (next: TimelineFilterState) => void;
  onResetToGlobal?: () => void;
}

export function TimelineSheetFilterPanel({
  filters,
  isOverridden,
  onChangeFilters,
  onResetToGlobal,
}: TimelineSheetFilterPanelProps) {
  const { t } = useAppI18n();
  const menuId = useId();
  const [poiMenuOpen, setPoiMenuOpen] = useState(false);
  const poiMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const poiMenuContainerRef = useRef<HTMLDivElement | null>(null);

  const activeCategories = useMemo<Set<DashboardPoiOptionId>>(() => {
    if (!filters.categories || filters.categories.size === 0) {
      return new Set<DashboardPoiOptionId>(DASHBOARD_POI_OPTIONS.map((opt) => opt.id));
    }
    return new Set<DashboardPoiOptionId>(
      Array.from(filters.categories) as DashboardPoiOptionId[],
    );
  }, [filters.categories]);

  const totalCategoriesCount = DASHBOARD_POI_OPTIONS.length;
  const selectedCategoriesCount = activeCategories.size;
  const isAllCategoriesSelected = selectedCategoriesCount === totalCategoriesCount;

  const toggleFilter = (key: keyof Omit<TimelineFilterState, 'categories'>) => {
    onChangeFilters({
      ...filters,
      [key]: !filters[key],
    });
  };

  const handleTogglePoiMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setPoiMenuOpen((open) => !open);
  };

  const handleToggleCategory = (catId: DashboardPoiOptionId) => {
    const next = new Set<DashboardPoiOptionId>(activeCategories);
    if (next.has(catId)) {
      next.delete(catId);
    } else {
      next.add(catId);
    }
    // If all categories are selected, we can store empty set (which means all)
    const nextCategories = next.size === totalCategoriesCount ? undefined : (new Set(next) as Set<string>);
    onChangeFilters({
      ...filters,
      categories: nextCategories,
    });
  };

  const handleToggleAllCategories = () => {
    if (isAllCategoriesSelected) {
      // Uncheck all
      onChangeFilters({
        ...filters,
        categories: new Set<string>(),
      });
    } else {
      // Check all
      onChangeFilters({
        ...filters,
        categories: undefined,
      });
    }
  };

  // Close POI categories menu on outside click
  useEffect(() => {
    if (!poiMenuOpen) return;

    const handlePointerDown = (event: globalThis.MouseEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (poiMenuContainerRef.current?.contains(target) ||
          poiMenuTriggerRef.current?.contains(target))
      ) {
        return;
      }
      setPoiMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPoiMenuOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [poiMenuOpen]);

  return (
    <section
      className="rvi-tl-sheet-filters"
      aria-label={t('Filtres de la feuille de route')}
    >
      <div className="rvi-tl-sheet-filters__status">
        <span className="rvi-tl-sheet-filters__title">{t('Filtres du tableau')}</span>

        {isOverridden && onResetToGlobal ? (
          <button
            type="button"
            className="rvi-tl-filter-reset"
            onClick={onResetToGlobal}
            title={t('Réinitialiser aux filtres globaux')}
          >
            <svg
              className="rvi-tl-filter-reset__icon"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
            <span>{t('Réinitialiser')}</span>
          </button>
        ) : null}
      </div>

      <div
        className="rvi-tl-sheet-filters__chips"
        role="group"
        aria-label={t('Filtres de la feuille de route')}
      >
        {/* POIs chip with category dropdown */}
        <div
          className={`rvi-tl-sheet-filters__chip-group${
            filters.poi ? ' is-on' : ''
          }${poiMenuOpen ? ' is-menu-open' : ''}`}
        >
          <button
            type="button"
            className={`rvi-tl-sheet-filters__chip${filters.poi ? ' is-on' : ''}`}
            aria-pressed={filters.poi}
            onClick={() => toggleFilter('poi')}
          >
            <span className="rvi-tl-sheet-filters__chip-check" aria-hidden="true">
              {filters.poi ? <IconCheck size={10} /> : null}
            </span>
            <span className="rvi-tl-sheet-filters__chip-icon" aria-hidden="true">
              <KindBadge kind="water" size={18} />
            </span>
            <span className="rvi-tl-sheet-filters__chip-label">
              {t('POIs')}
              {!isAllCategoriesSelected ? (
                <span className="rvi-tl-sheet-filters__cat-count">
                  {` (${selectedCategoriesCount})`}
                </span>
              ) : null}
            </span>
          </button>

          <button
            ref={poiMenuTriggerRef}
            type="button"
            className={`rvi-tl-sheet-filters__chevron-btn${
              poiMenuOpen ? ' is-open' : ''
            }`}
            aria-label={t('Catégories POI')}
            aria-haspopup="menu"
            aria-expanded={poiMenuOpen}
            aria-controls={poiMenuOpen ? menuId : undefined}
            onClick={handleTogglePoiMenu}
          >
            <IconChevronDown size={14} />
          </button>

          {poiMenuOpen ? (
            <div
              id={menuId}
              ref={poiMenuContainerRef}
              className="rvi-tl-sheet-filters__poi-menu is-open"
              role="menu"
              aria-label={t('Catégories POI')}
              onWheel={(e) => e.stopPropagation()}
            >
              <MapCanvasGlassBackdrop
                blur={24}
                saturate={1.2}
                tint="rgba(14, 14, 18, 0.94)"
              />
              <div className="rvd-place-search__poi-menu-list">
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={isAllCategoriesSelected}
                  className="rvd-place-search__poi-option"
                  style={{
                    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                    marginBottom: 4,
                    paddingBottom: 6,
                  }}
                  onClick={handleToggleAllCategories}
                >
                  <span className="rvd-place-search__poi-checkbox" aria-hidden="true">
                    {isAllCategoriesSelected ? <SvgV2Icon name="check.svg" size={12} /> : null}
                  </span>
                  <span className="rvd-place-search__poi-option-label" style={{ fontWeight: 600 }}>
                    {t('Toutes les catégories')}
                  </span>
                </button>
                {DASHBOARD_POI_OPTIONS.map((option) => {
                  const selected = activeCategories.has(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={selected}
                      className="rvd-place-search__poi-option"
                      onClick={() => handleToggleCategory(option.id)}
                    >
                      <span className="rvd-place-search__poi-checkbox" aria-hidden="true">
                        {selected ? <SvgV2Icon name="check.svg" size={12} /> : null}
                      </span>
                      <span className="rvd-place-search__poi-option-marker">
                        <PoiOptionMarker option={option} />
                      </span>
                      <span className="rvd-place-search__poi-option-label">
                        {t(option.label)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        {/* Favoris chip */}
        <button
          type="button"
          className={`rvi-tl-sheet-filters__chip${filters.favorite ? ' is-on' : ''}`}
          aria-pressed={filters.favorite}
          onClick={() => toggleFilter('favorite')}
        >
          <span className="rvi-tl-sheet-filters__chip-check" aria-hidden="true">
            {filters.favorite ? <IconCheck size={10} /> : null}
          </span>
          <span className="rvi-tl-sheet-filters__chip-icon" aria-hidden="true">
            <span className="rvi-tl-edit__favorite-icon">
              <IconStar size={12} />
            </span>
          </span>
          <span className="rvi-tl-sheet-filters__chip-label">{t('Favoris')}</span>
        </button>

        {/* Pauses chip */}
        <button
          type="button"
          className={`rvi-tl-sheet-filters__chip${filters.pause ? ' is-on' : ''}`}
          aria-pressed={filters.pause}
          onClick={() => toggleFilter('pause')}
        >
          <span className="rvi-tl-sheet-filters__chip-check" aria-hidden="true">
            {filters.pause ? <IconCheck size={10} /> : null}
          </span>
          <span className="rvi-tl-sheet-filters__chip-icon" aria-hidden="true">
            <KindBadge kind="pause" size={18} />
          </span>
          <span className="rvi-tl-sheet-filters__chip-label">{t('Pauses')}</span>
        </button>

        {/* Waypoints chip */}
        <button
          type="button"
          className={`rvi-tl-sheet-filters__chip${filters.waypoint ? ' is-on' : ''}`}
          aria-pressed={filters.waypoint}
          onClick={() => toggleFilter('waypoint')}
        >
          <span className="rvi-tl-sheet-filters__chip-check" aria-hidden="true">
            {filters.waypoint ? <IconCheck size={10} /> : null}
          </span>
          <span className="rvi-tl-sheet-filters__chip-icon" aria-hidden="true">
            <KindBadge kind="waypoint" size={18} />
          </span>
          <span className="rvi-tl-sheet-filters__chip-label">
            {t('Points de passage')}
          </span>
        </button>

        {/* Étapes chip */}
        <button
          type="button"
          className={`rvi-tl-sheet-filters__chip${filters.etape ? ' is-on' : ''}`}
          aria-pressed={filters.etape}
          onClick={() => toggleFilter('etape')}
        >
          <span className="rvi-tl-sheet-filters__chip-check" aria-hidden="true">
            {filters.etape ? <IconCheck size={10} /> : null}
          </span>
          <span className="rvi-tl-sheet-filters__chip-icon" aria-hidden="true">
            <KindBadge kind="start" size={18} />
          </span>
          <span className="rvi-tl-sheet-filters__chip-label">{t('Étape')}</span>
        </button>
      </div>
    </section>
  );
}
