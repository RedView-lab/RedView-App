import { useState, useRef } from 'react';
import { useAppI18n } from '@/shared/i18n';
import type { PrioritiesState, RoadPreference, RoadTypesState, RouteProfile } from '../types';
import {
  IconBikeShop,
  IconComfort,
  IconFigmaCheck,
  IconFigmaChevronDown,
  IconFlash,
  IconTelescope,
} from '../components/iconsFigma';
import { PortalDropdown } from '../components/controls/PortalDropdown';
import {
  syncTracageOnActivityChange,
  syncTracageOnTracingModeChange,
  syncTracageOnSurfaceChange,
  type ActivityType,
  type TracingModeType,
  type SurfaceType,
} from '../lib/project/syncTracageParams';

export interface TracageSectionProps {
  priorities: PrioritiesState;
  roadTypes: RoadTypesState;
  profiles?: RouteProfile[];
  activeProfileId?: string;
  onChangeProfile?: (id: string) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onSaveProfile?: () => void;
  onChangePriority?: (key: keyof PrioritiesState, value: number) => void;
  onChangeRoadType?: <K extends keyof RoadTypesState>(
    key: K,
    value: RoadTypesState[K],
  ) => void;
  onBatchChangeRoadTypes?: (
    roadUpdates: Partial<RoadTypesState>,
    priorityUpdates?: Partial<PrioritiesState>,
  ) => void;
  onApply?: () => void;
  onCancelApply?: () => void;
  applyLoading?: boolean;
  resultLabel?: string | null;
}

const ROAD_PREF_OPTIONS: { value: RoadPreference; label: string }[] = [
  { value: 'prefer', label: 'Privilégier' },
  { value: 'tolerate', label: 'Tolérer' },
  { value: 'avoid', label: 'Éviter' },
  { value: 'forbid', label: 'Interdire' },
];

const TOLERANCE_OPTIONS = [5, 10, 15, 20, 25, 30];

const SLOPE_OPTIONS = [8, 10, 12, 15, 20, 25];

const SURFACES: { id: SurfaceType; label: string; pct: number }[] = [
  { id: 'tarmac', label: 'Tarmac', pct: 0 },
  { id: 'paved', label: 'Paved', pct: 33.333 },
  { id: 'gravel', label: 'Gravel', pct: 66.667 },
  { id: 'other', label: 'Other', pct: 100 },
];

/**
 * TracageSection — Pixel perfect implementation of Figma nodes 5918:103512 & 5918:112682.
 */
export function TracageSection({
  roadTypes,
  profiles = [],
  activeProfileId,
  onChangeProfile,
  onChangeRoadType,
  onBatchChangeRoadTypes,
  onApply,
  onCancelApply,
  applyLoading = false,
  resultLabel = null,
}: TracageSectionProps) {
  const { t } = useAppI18n();

  // Collapsible additional params (smooth accordion)
  const [paramsOpen, setParamsOpen] = useState(true);

  // Activity type dropdown state
  const [activityOpen, setActivityOpen] = useState(false);
  const activityBtnRef = useRef<HTMLButtonElement>(null);

  // Tracing mode dropdown state
  const [tracingOpen, setTracingOpen] = useState(false);
  const tracingBtnRef = useRef<HTMLButtonElement>(null);

  // Tolerance dropdown state
  const [toleranceOpen, setToleranceOpen] = useState(false);
  const toleranceBtnRef = useRef<HTMLButtonElement>(null);

  // Active surface preference
  const currentSurface: SurfaceType =
    roadTypes.surfacePreference ?? (roadTypes.gravel === 'prefer' ? 'gravel' : 'tarmac');

  // Active tolerance percent
  const currentTolerance = roadTypes.surfaceTolerance ?? 10;

  // Active tracing mode
  const currentTracingMode: TracingModeType = roadTypes.tracingMode ?? 'vitesse';

  // Resolved active activity ID
  const resolvedActivityId: ActivityType =
    roadTypes.activityType === 'road' || activeProfileId === 'road'
      ? 'road'
      : roadTypes.activityType === 'mtb' || activeProfileId === 'mtb'
        ? 'mtb'
        : 'gravel-default';

  // Resolved active activity name displayed in the top selector
  const currentActivityName =
    resolvedActivityId === 'road'
      ? t('Vélo de route')
      : resolvedActivityId === 'mtb'
        ? 'MTB'
        : t('Gravel');

  // Surface slider position and smooth dragging
  const sliderWrapRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragPct, setDragPct] = useState<number | null>(null);

  const activeSurfaceIndex = SURFACES.findIndex((s) => s.id === currentSurface);
  const activeSurfacePct = activeSurfaceIndex >= 0 ? SURFACES[activeSurfaceIndex].pct : 0;

  const applyRoadUpdates = (updates: Partial<RoadTypesState>) => {
    (Object.keys(updates) as (keyof RoadTypesState)[]).forEach((key) => {
      const val = updates[key];
      if (val !== undefined) {
        onChangeRoadType?.(key, val);
      }
    });
  };

  // Global change handlers with automatic synchronization to "Paramètres additionnels" and backend
  const handleActivitySelect = (activityId: string) => {
    const activityKey: ActivityType =
      activityId === 'road' ? 'road' : activityId === 'mtb' ? 'mtb' : 'gravel-default';
    const syncResult = syncTracageOnActivityChange(
      activityKey,
      currentTracingMode,
      currentTolerance,
    );

    if (onBatchChangeRoadTypes) {
      onBatchChangeRoadTypes(syncResult.roadTypes, syncResult.priorities);
    } else {
      applyRoadUpdates(syncResult.roadTypes);
    }
    onChangeProfile?.(activityKey);
    setActivityOpen(false);
  };

  const handleTracingModeSelect = (mode: TracingModeType) => {
    const syncResult = syncTracageOnTracingModeChange(
      mode,
      resolvedActivityId,
    );

    if (onBatchChangeRoadTypes) {
      onBatchChangeRoadTypes(syncResult.roadTypes, syncResult.priorities);
    } else {
      applyRoadUpdates(syncResult.roadTypes);
    }
    setTracingOpen(false);
  };

  const handleSurfaceSelect = (surface: SurfaceType) => {
    const syncResult = syncTracageOnSurfaceChange(surface, resolvedActivityId);

    if (onBatchChangeRoadTypes) {
      onBatchChangeRoadTypes(syncResult.roadTypes);
    } else {
      applyRoadUpdates(syncResult.roadTypes);
    }
  };

  const handleToleranceSelect = (val: number) => {
    onChangeRoadType?.('surfaceTolerance', val);
    setToleranceOpen(false);
  };

  const getRatioFromPointerEvent = (clientX: number): number => {
    if (!sliderWrapRef.current) return 0;
    const rect = sliderWrapRef.current.getBoundingClientRect();
    const usableWidth = rect.width - 38;
    if (usableWidth <= 0) return 0;
    const clickX = clientX - rect.left - 19;
    return Math.max(0, Math.min(1, clickX / usableWidth));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);

    const ratio = getRatioFromPointerEvent(e.clientX);
    const pct = ratio * 100;
    setDragPct(pct);

    const nearestIndex = Math.round(ratio * (SURFACES.length - 1));
    handleSurfaceSelect(SURFACES[nearestIndex].id);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    e.preventDefault();
    const ratio = getRatioFromPointerEvent(e.clientX);
    const pct = ratio * 100;
    setDragPct(pct);

    const nearestIndex = Math.round(ratio * (SURFACES.length - 1));
    handleSurfaceSelect(SURFACES[nearestIndex].id);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    setIsDragging(false);
    setDragPct(null);
  };

  // Interpolated knob position: constrained within [19px, 100% - 19px] so it NEVER crops
  const effectivePct = isDragging && dragPct !== null ? dragPct : activeSurfacePct;
  const knobLeftStyle = `calc(19px + (100% - 38px) * ${effectivePct / 100})`;
  const fillWidthStyle = `calc(19px + (100% - 38px) * ${effectivePct / 100})`;

  return (
    <div className="rvi-tracage">
      {/* ── Top Row: Type d'activité & Mode de traçage (Figma 5918:103513) ── */}
      <div className="rvi-tracage__mode-row">
        {/* Column 1: Type d’activité */}
        <div className="rvi-tracage__mode-col">
          <span className="rvi-tracage__label">{t('Type d’activité')}</span>
          <button
            ref={activityBtnRef}
            type="button"
            className="rvi-tracage__mode-btn rvi-tracage__mode-btn--activity"
            onClick={() => setActivityOpen((prev) => !prev)}
            aria-expanded={activityOpen}
            aria-haspopup="listbox"
          >
            <span className="rvi-tracage__mode-btn-icon">
              <IconBikeShop size={16} />
            </span>
            <span className="rvi-tracage__mode-btn-text" title={currentActivityName}>
              {currentActivityName}
            </span>
            <span className={`rvi-tracage__mode-btn-chevron${activityOpen ? ' is-open' : ''}`}>
              <IconFigmaChevronDown size={14} />
            </span>
          </button>

          <PortalDropdown
            open={activityOpen}
            anchorRef={activityBtnRef}
            onClose={() => setActivityOpen(false)}
            minWidth={140}
            align="left"
          >
            {profiles.length > 0 ? (
              profiles
                .filter((p) => p.id !== 'custom')
                .map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`rvi-tracage__mode-menu-item${p.id === resolvedActivityId ? ' is-selected' : ''}`}
                    onClick={() => handleActivitySelect(p.id)}
                  >
                    <IconBikeShop size={15} />
                    <span>{p.id === 'mtb' ? 'MTB' : p.name}</span>
                  </button>
                ))
            ) : (
              <>
                <button
                  type="button"
                  className={`rvi-tracage__mode-menu-item${resolvedActivityId === 'road' ? ' is-selected' : ''}`}
                  onClick={() => handleActivitySelect('road')}
                >
                  <IconBikeShop size={15} />
                  <span>{t('Vélo de route')}</span>
                </button>
                <button
                  type="button"
                  className={`rvi-tracage__mode-menu-item${resolvedActivityId === 'gravel-default' ? ' is-selected' : ''}`}
                  onClick={() => handleActivitySelect('gravel-default')}
                >
                  <IconBikeShop size={15} />
                  <span>{t('Gravel')}</span>
                </button>
                <button
                  type="button"
                  className={`rvi-tracage__mode-menu-item${resolvedActivityId === 'mtb' ? ' is-selected' : ''}`}
                  onClick={() => handleActivitySelect('mtb')}
                >
                  <IconBikeShop size={15} />
                  <span>MTB</span>
                </button>
              </>
            )}
          </PortalDropdown>
        </div>

        {/* Column 2: Mode de traçage */}
        <div className="rvi-tracage__mode-col">
          <span className="rvi-tracage__label">{t('Mode de traçage ')}</span>
          <button
            ref={tracingBtnRef}
            type="button"
            className="rvi-tracage__mode-btn rvi-tracage__mode-btn--tracing"
            onClick={() => setTracingOpen((prev) => !prev)}
            aria-expanded={tracingOpen}
            aria-haspopup="listbox"
          >
            <span className="rvi-tracage__mode-btn-icon">
              {currentTracingMode === 'vitesse' && <IconFlash size={16} />}
              {currentTracingMode === 'aventure' && <IconTelescope size={16} />}
              {currentTracingMode === 'comfort' && <IconComfort size={16} />}
            </span>
            <span className="rvi-tracage__mode-btn-text">
              {currentTracingMode === 'vitesse' && t('Vitesse')}
              {currentTracingMode === 'aventure' && t('Aventure')}
              {currentTracingMode === 'comfort' && t('Comfort')}
            </span>
            <span className={`rvi-tracage__mode-btn-chevron${tracingOpen ? ' is-open' : ''}`}>
              <IconFigmaChevronDown size={14} />
            </span>
          </button>

          <PortalDropdown
            open={tracingOpen}
            anchorRef={tracingBtnRef}
            onClose={() => setTracingOpen(false)}
            minWidth={140}
            align="right"
          >
            <button
              type="button"
              className={`rvi-tracage__mode-menu-item${currentTracingMode === 'vitesse' ? ' is-selected' : ''}`}
              onClick={() => handleTracingModeSelect('vitesse')}
            >
              <IconFlash size={15} />
              <span>{t('Vitesse')}</span>
            </button>
            <button
              type="button"
              className={`rvi-tracage__mode-menu-item${currentTracingMode === 'aventure' ? ' is-selected' : ''}`}
              onClick={() => handleTracingModeSelect('aventure')}
            >
              <IconTelescope size={15} />
              <span>{t('Aventure')}</span>
            </button>
            <button
              type="button"
              className={`rvi-tracage__mode-menu-item${currentTracingMode === 'comfort' ? ' is-selected' : ''}`}
              onClick={() => handleTracingModeSelect('comfort')}
            >
              <IconComfort size={15} />
              <span>{t('Comfort')}</span>
            </button>
          </PortalDropdown>
        </div>
      </div>

      {/* ── Surfaces (Figma 5918:103521 & 5918:112691) ── */}
      <div className="rvi-tracage__surfaces">
        <span className="rvi-tracage__label">{t('Surfaces')}</span>
        <div className="rvi-tracage__surfaces-row">
          {/* Sliders Frame */}
          <div className="rvi-tracage__slider-box">
            <div className="rvi-tracage__slider-frame">
              <div
                ref={sliderWrapRef}
                className="rvi-tracage__slider-track-wrap"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                role="slider"
                aria-label={t('Surfaces')}
                aria-valuemin={0}
                aria-valuemax={3}
                aria-valuenow={activeSurfaceIndex}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                    const next = Math.min(SURFACES.length - 1, activeSurfaceIndex + 1);
                    handleSurfaceSelect(SURFACES[next].id);
                  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                    const prev = Math.max(0, activeSurfaceIndex - 1);
                    handleSurfaceSelect(SURFACES[prev].id);
                  }
                }}
              >
                {/* Background track line */}
                <div className="rvi-tracage__slider-track" />
                {/* Active RED line */}
                <div
                  className={`rvi-tracage__slider-fill${isDragging ? ' is-dragging' : ''}`}
                  style={{ width: fillWidthStyle }}
                />

                {/* Discrete 4 Ticks aligned to knob centers */}
                {SURFACES.map((s, idx) => {
                  const tickLeft =
                    idx === 0
                      ? '19px'
                      : idx === SURFACES.length - 1
                        ? 'calc(100% - 19px)'
                        : `calc(19px + (100% - 38px) * ${s.pct / 100})`;
                  return (
                    <div
                      key={s.id}
                      className="rvi-tracage__slider-tick"
                      style={{
                        left: tickLeft,
                        background:
                          s.pct <= effectivePct
                            ? '#ffffff'
                            : 'rgba(255, 255, 255, 0.28)',
                      }}
                    />
                  );
                })}

                {/* Knob Pill (38px x 24px) constrained so it NEVER crops on left or right */}
                <div
                  className={`rvi-tracage__slider-knob${isDragging ? ' is-dragging' : ''}`}
                  style={{ left: knobLeftStyle }}
                />
              </div>
            </div>

            {/* Ticks labels row */}
            <div className="rvi-tracage__ticks-labels">
              {SURFACES.map((s) => (
                <span
                  key={s.id}
                  className={`rvi-tracage__tick-label${s.id === currentSurface ? ' is-active' : ''}`}
                  onClick={() => handleSurfaceSelect(s.id)}
                >
                  {s.label}
                </span>
              ))}
            </div>
          </div>

          {/* Tolerance Column with red border */}
          <div className="rvi-tracage__tolerance-col">
            <button
              ref={toleranceBtnRef}
              type="button"
              className={`rvi-tracage__tolerance-btn${toleranceOpen ? ' is-open' : ''}`}
              onClick={() => setToleranceOpen((prev) => !prev)}
              aria-expanded={toleranceOpen}
              aria-label={t('Tolérance')}
            >
              <span>{`${currentTolerance}%`}</span>
              <IconFigmaChevronDown size={12} />
            </button>
            <span className="rvi-tracage__tolerance-sublabel">{t('Tolérance')}</span>

            <PortalDropdown
              open={toleranceOpen}
              anchorRef={toleranceBtnRef}
              onClose={() => setToleranceOpen(false)}
              width={76}
              align="right"
              estimatedHeight={200}
            >
              {TOLERANCE_OPTIONS.map((val) => (
                <button
                  key={val}
                  type="button"
                  className={`rvi-tracage__mode-menu-item${val === currentTolerance ? ' is-selected' : ''}`}
                  style={{ justifyContent: 'center', height: 30 }}
                  onClick={() => handleToleranceSelect(val)}
                >
                  <span>{`${val}%`}</span>
                </button>
              ))}
            </PortalDropdown>
          </div>
        </div>
      </div>

      {/* ── Paramètres additionnels (Smooth Accordion & Red Small Dropdowns) ── */}
      <div className="rvi-tracage__params">
        <button
          type="button"
          className="rvi-tracage__params-trigger"
          onClick={() => setParamsOpen((prev) => !prev)}
          aria-expanded={paramsOpen}
        >
          <span className="rvi-tracage__params-title">{t('Paramètres additionnels')}</span>
          <span className={`rvi-tracage__params-chevron${paramsOpen ? ' is-open' : ''}`}>
            <IconFigmaChevronDown size={15} />
          </span>
        </button>

        {/* Smooth CSS Grid Accordion */}
        <div className={`rvi-tracage__params-accordion${paramsOpen ? ' is-open' : ''}`}>
          <div className="rvi-tracage__params-accordion-inner">
            <div className="rvi-tracage__params-grid">
              {/* Row 1: Dénivelé & Pentes max. */}
              <div className="rvi-tracage__params-row">
                <ParamDropdownItem
                  label={t('Dénivelé')}
                  value={roadTypes.elevationPreference ?? 'avoid'}
                  onChange={(val) => onChangeRoadType?.('elevationPreference', val)}
                />
                <SlopeParamItem
                  label={t('Pentes max.')}
                  value={roadTypes.maxSlopePercent ?? 12}
                  onChange={(val) => onChangeRoadType?.('maxSlopePercent', val)}
                />
              </div>

              {/* Row 2: Axes majeurs & Voies cyclables */}
              <div className="rvi-tracage__params-row">
                <ParamDropdownItem
                  label={t('Axes majeurs')}
                  value={roadTypes.majorRoads ?? 'prefer'}
                  onChange={(val) => onChangeRoadType?.('majorRoads', val)}
                />
                <ParamDropdownItem
                  label={t('Voies cyclables')}
                  value={roadTypes.bikeLanes ?? 'tolerate'}
                  onChange={(val) => onChangeRoadType?.('bikeLanes', val)}
                />
              </div>

              {/* Row 3: Bois (protection vent et soleil) & Intersections */}
              <div className="rvi-tracage__params-row">
                <ParamDropdownItem
                  label={t('Bois (protection vent et soleil)')}
                  value={roadTypes.woods ?? 'prefer'}
                  onChange={(val) => onChangeRoadType?.('woods', val)}
                />
                <ParamDropdownItem
                  label={t('Intersections')}
                  value={roadTypes.turns ?? 'tolerate'}
                  onChange={(val) => onChangeRoadType?.('turns', val)}
                />
              </div>

              {/* Row 4: Ferry & Villes */}
              <div className="rvi-tracage__params-row">
                <ParamDropdownItem
                  label={t('Ferry')}
                  value={roadTypes.ferry ?? 'forbid'}
                  onChange={(val) => onChangeRoadType?.('ferry', val)}
                />
                <ParamDropdownItem
                  label={t('Villes')}
                  value={roadTypes.cities ?? 'avoid'}
                  onChange={(val) => onChangeRoadType?.('cities', val)}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Checkbox: Appliquer à tout les itinéraires (Figma 5925:123599) ── */}
      <button
        type="button"
        className="rvi-tracage__checkbox-row"
        onClick={() =>
          onChangeRoadType?.('applyToAllItineraries', !roadTypes.applyToAllItineraries)
        }
        role="checkbox"
        aria-checked={Boolean(roadTypes.applyToAllItineraries)}
      >
        <span
          className={`rvi-tracage__checkbox${roadTypes.applyToAllItineraries ? ' is-checked' : ''}`}
        >
          {roadTypes.applyToAllItineraries && <IconFigmaCheck size={10} />}
        </span>
        <span className="rvi-tracage__checkbox-text">
          {t('Appliquer à tout les itinéraires')}
        </span>
      </button>

      {/* ── Main Button: Valider (Figma 5918:103549 & 5918:112719) ── */}
      <button
        type="button"
        className="rvi-tracage__submit-btn"
        onClick={applyLoading ? onCancelApply : onApply}
        disabled={applyLoading && !onCancelApply}
      >
        <span className="rvi-tracage__submit-icon">
          <IconFigmaCheck size={16} />
        </span>
        <span className="rvi-tracage__submit-text">
          {applyLoading ? t('Calcul du tracé en cours') : t('Valider')}
          {resultLabel && !applyLoading ? (
            <span className="rvi-tracage__submit-dist">{resultLabel}</span>
          ) : null}
        </span>
      </button>
    </div>
  );
}

/**
 * 88px Dropdown Item with red border & unclipped Portal positioning.
 */
function ParamDropdownItem({
  label,
  value,
  onChange,
}: {
  label: string;
  value: RoadPreference;
  onChange: (val: RoadPreference) => void;
}) {
  const { t } = useAppI18n();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const selectedOption = ROAD_PREF_OPTIONS.find((o) => o.value === value) ?? ROAD_PREF_OPTIONS[1];

  return (
    <div className="rvi-tracage__param-item">
      <span className="rvi-tracage__param-label" title={label}>
        {label}
      </span>
      <button
        ref={btnRef}
        type="button"
        className={`rvi-tracage__param-btn${open ? ' is-open' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-label={label}
      >
        <span className="rvi-tracage__param-btn-text">{t(selectedOption.label)}</span>
        <IconFigmaChevronDown size={12} />
      </button>

      <PortalDropdown
        open={open}
        anchorRef={btnRef}
        onClose={() => setOpen(false)}
        width={96}
        align="right"
        estimatedHeight={138}
      >
        {ROAD_PREF_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`rvi-tracage__mode-menu-item${opt.value === value ? ' is-selected' : ''}`}
            style={{
              height: 28,
              fontSize: 12,
              padding: '4px 8px',
            }}
            onClick={() => {
              onChange(opt.value);
              setOpen(false);
            }}
          >
            <span>{t(opt.label)}</span>
          </button>
        ))}
      </PortalDropdown>
    </div>
  );
}

/**
 * Slope (Pentes max.) Picker with red border & unclipped Portal positioning.
 */
function SlopeParamItem({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (val: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="rvi-tracage__param-item">
      <span className="rvi-tracage__param-label" title={label}>
        {label}
      </span>
      <button
        ref={btnRef}
        type="button"
        className={`rvi-tracage__param-btn${open ? ' is-open' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-label={label}
      >
        <span className="rvi-tracage__param-btn-text">{`${value}%`}</span>
        <IconFigmaChevronDown size={12} />
      </button>

      <PortalDropdown
        open={open}
        anchorRef={btnRef}
        onClose={() => setOpen(false)}
        width={88}
        align="right"
        estimatedHeight={180}
      >
        {SLOPE_OPTIONS.map((val) => (
          <button
            key={val}
            type="button"
            className={`rvi-tracage__mode-menu-item${val === value ? ' is-selected' : ''}`}
            style={{
              height: 28,
              fontSize: 12,
              padding: '4px 8px',
              justifyContent: 'center',
            }}
            onClick={() => {
              onChange(val);
              setOpen(false);
            }}
          >
            <span>{`${val}%`}</span>
          </button>
        ))}
      </PortalDropdown>
    </div>
  );
}
