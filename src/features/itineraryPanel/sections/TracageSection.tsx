import { useState, useEffect, useMemo } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { isFootDiscipline, type SportDiscipline } from '@/shared/lib/discipline';
import type { PrioritiesState, RoadTypesState, RouteProfile } from '../types';
import {
  IconRepeatFigma,
  IconSaveFigma,
  IconSlidersFigma,
} from '../components/iconsFigma';
import {
  syncTracageOnActivityChange,
  syncTracageOnTracingModeChange,
  syncTracageOnSurfaceRangeChange,
  type ActivityType,
  type TracingModeType,
  type SurfaceType,
} from '../lib/project/syncTracageParams';
import {
  ROUTE_PROFILE_PRESETS,
  isActivityPresetId,
  isFootActivity,
  isRoadTypesCustomized,
} from '../lib/project/profilePresets';
import {
  getSavedCustomProfiles,
  saveCustomProfileToStorage,
  deleteCustomProfileFromStorage,
  getNextCustomProfileName,
  mergeAvailableCustomProfiles,
  CUSTOM_PROFILES_CHANGED_EVENT,
  type SavedCustomProfile,
} from '../lib/project/customProfiles';
import { useProjectStoreOptional } from '../context/ProjectStore/hooks';
import {
  ACTIVITY_LABELS,
  SURFACES,
  disciplineForActivity,
  resolveActivityKey,
} from './tracage/activity';
import { ActivityIcon } from './tracage/ActivityIcon';
import { ActivitySelector } from './tracage/ActivitySelector';
import { AdditionalParams } from './tracage/AdditionalParams';
import { buildCustomProfileToSave } from './tracage/customProfileDraft';
import { SurfaceRangeSlider } from './tracage/SurfaceRangeSlider';
import { ToleranceSelect } from './tracage/ToleranceSelect';
import { TracingModeSelector } from './tracage/TracingModeSelector';

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
  onSaveProfile?: (profile?: SavedCustomProfile) => void;
  onDeleteProfile?: (id: string) => void;
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
  /** Recalculate entire trace through BRouter using current profile, segment by segment between waypoints. */
  onRecalculateTrace?: () => void;
  /** True while the recalculation is running. */
  recalculateLoading?: boolean;
  /** Progress 0–1 of segment recalculation. */
  recalculateProgress?: number | null;
  /** Whether the recalculate button should be shown (GPX import with waypoints). */
  showRecalculateTrace?: boolean;
  /** Sport of the itinerary: Trail / Running route on the pedestrian network. */
  discipline?: SportDiscipline;
  onChangeDiscipline?: (discipline: SportDiscipline) => void;
}

/**
 * TracageSection — Pixel perfect implementation of Figma nodes 5918:103512 & 5918:112682.
 */
export function TracageSection({
  priorities,
  roadTypes,
  activeProfileId,
  onChangeProfile,
  onSaveProfile,
  onDeleteProfile,
  onChangeRoadType,
  onBatchChangeRoadTypes,
  onRecalculateTrace,
  recalculateLoading,
  recalculateProgress,
  showRecalculateTrace,
  discipline = 'bike',
  onChangeDiscipline,
}: TracageSectionProps) {
  const { t } = useAppI18n();
  const footDiscipline = isFootDiscipline(discipline) ? discipline : null;

  // Bibliothèque du compte (copie locale synchronisée) + profils embarqués
  // dans le projet sans être dans la bibliothèque (autre appareil, collaborateur).
  const [libraryProfiles, setSavedProfiles] = useState<SavedCustomProfile[]>(() =>
    getSavedCustomProfiles(),
  );
  const projectProfiles = useProjectStoreOptional()?.project.routingProfiles;
  const savedProfiles = useMemo(
    () => mergeAvailableCustomProfiles(libraryProfiles, projectProfiles),
    [libraryProfiles, projectProfiles],
  );
  const deletableProfileIds = useMemo(
    () => new Set(libraryProfiles.map((profile) => profile.id)),
    [libraryProfiles],
  );

  useEffect(() => {
    const handleUpdate = () => {
      setSavedProfiles(getSavedCustomProfiles());
    };
    window.addEventListener(CUSTOM_PROFILES_CHANGED_EVENT, handleUpdate);
    return () => window.removeEventListener(CUSTOM_PROFILES_CHANGED_EVENT, handleUpdate);
  }, []);

  // Base profile id currently active, derived synchronously to avoid 1-frame stale state
  const effectiveBaseId = useMemo(() => {
    const known = (id: string | undefined): id is string =>
      !!id && (!!ROUTE_PROFILE_PRESETS[id] || savedProfiles.some((p) => p.id === id));
    const candidate = known(activeProfileId)
      ? activeProfileId
      : known(roadTypes.activityType)
        ? roadTypes.activityType
        : 'road';
    // The discipline decides the routing network: a built-in preset of the
    // other family (older projects) falls back to the discipline's preset.
    if (isActivityPresetId(candidate) && isFootActivity(candidate) !== !!footDiscipline) {
      return footDiscipline ?? 'road';
    }
    return candidate;
  }, [activeProfileId, footDiscipline, roadTypes.activityType, savedProfiles]);

  // Built-in preset behind the active profile
  const activeBaseSaved = savedProfiles.find((p) => p.id === effectiveBaseId);
  const basePresetKey = resolveActivityKey(effectiveBaseId, activeBaseSaved, footDiscipline);

  // Active surface preference range [min, max]
  const currentSurfaceMin: SurfaceType =
    roadTypes.surfaceMin ??
    (effectiveBaseId === 'mtb' || effectiveBaseId === 'trail'
      ? 'paved'
      : 'tarmac');

  const currentSurfaceMax: SurfaceType =
    roadTypes.surfaceMax ??
    roadTypes.surfacePreference ??
    (effectiveBaseId === 'mtb' || effectiveBaseId === 'trail'
      ? 'other'
      : effectiveBaseId === 'road'
        ? 'tarmac'
        : 'gravel');

  const minSurfaceIndex = SURFACES.findIndex((s) => s.id === currentSurfaceMin);
  const maxSurfaceIndex = SURFACES.findIndex((s) => s.id === currentSurfaceMax);
  const safeMinIdx = minSurfaceIndex >= 0 ? minSurfaceIndex : 0;
  const safeMaxIdx = maxSurfaceIndex >= 0 ? Math.max(safeMinIdx, maxSurfaceIndex) : safeMinIdx;

  // Active tolerance percent
  const currentTolerance = roadTypes.surfaceTolerance ?? 10;

  // Active tracing mode
  const currentTracingMode: TracingModeType = roadTypes.tracingMode ?? 'vitesse';

  // Compare roadTypes against base profile
  const expectedRoadTypes = useMemo(() => {
    if (activeBaseSaved) {
      return activeBaseSaved.roadTypes;
    }
    return syncTracageOnActivityChange(basePresetKey, currentTracingMode, 10).roadTypes;
  }, [activeBaseSaved, basePresetKey, currentTracingMode]);

  const isCustomized = isRoadTypesCustomized(roadTypes, expectedRoadTypes);

  // Resolved active activity name displayed in the top selector
  const nextProfileName = useMemo(() => {
    const raw = getNextCustomProfileName(savedProfiles);
    return t(raw);
  }, [savedProfiles, t]);

  const currentActivityName = activeBaseSaved
    ? activeBaseSaved.name
    : isCustomized
      ? nextProfileName
      : t(ACTIVITY_LABELS[basePresetKey]);

  const currentActivityIcon = activeBaseSaved || isCustomized ? (
    <IconSlidersFigma size={16} />
  ) : (
    <ActivityIcon activity={basePresetKey} size={16} />
  );

  // Built-in preset highlighted in the dropdown (none while a custom profile is active).
  const selectedPresetId = !activeBaseSaved && !isCustomized ? basePresetKey : null;

  const applyRoadUpdates = (updates: Partial<RoadTypesState>) => {
    (Object.keys(updates) as (keyof RoadTypesState)[]).forEach((key) => {
      const val = updates[key];
      if (val !== undefined) {
        onChangeRoadType?.(key, val);
      }
    });
  };

  const handleActivitySelect = (activityId: ActivityType) => {
    const syncResult = syncTracageOnActivityChange(
      activityId,
      currentTracingMode,
      10,
    );

    if (onBatchChangeRoadTypes) {
      onBatchChangeRoadTypes(syncResult.roadTypes, syncResult.priorities);
    } else {
      applyRoadUpdates(syncResult.roadTypes);
    }
    onChangeProfile?.(activityId);
    const nextDiscipline = disciplineForActivity(activityId);
    if (nextDiscipline !== discipline) onChangeDiscipline?.(nextDiscipline);
  };

  const handleCustomProfileSelect = (profile: SavedCustomProfile) => {
    if (onBatchChangeRoadTypes) {
      onBatchChangeRoadTypes(profile.roadTypes, profile.priorities);
    } else {
      applyRoadUpdates(profile.roadTypes);
    }
    onChangeProfile?.(profile.id);
    const nextDiscipline = disciplineForActivity(resolveActivityKey(profile.id, profile, null));
    if (nextDiscipline !== discipline) onChangeDiscipline?.(nextDiscipline);
  };

  const handleTracingModeSelect = (mode: TracingModeType) => {
    const currentActivity = basePresetKey;
    const syncResult = syncTracageOnTracingModeChange(
      mode,
      currentActivity,
    );

    if (onBatchChangeRoadTypes) {
      onBatchChangeRoadTypes(syncResult.roadTypes, syncResult.priorities);
    } else {
      applyRoadUpdates(syncResult.roadTypes);
    }
    if (!activeBaseSaved) {
      onChangeProfile?.(currentActivity);
    }
  };

  const handleSurfaceRangeSelect = (surfaceMin: SurfaceType, surfaceMax: SurfaceType) => {
    const syncResult = syncTracageOnSurfaceRangeChange(surfaceMin, surfaceMax, basePresetKey);

    if (onBatchChangeRoadTypes) {
      onBatchChangeRoadTypes(syncResult.roadTypes);
    } else {
      applyRoadUpdates(syncResult.roadTypes);
    }
  };

  const handleReset = () => {
    if (activeBaseSaved) {
      if (onBatchChangeRoadTypes) {
        onBatchChangeRoadTypes(activeBaseSaved.roadTypes, activeBaseSaved.priorities);
      } else {
        applyRoadUpdates(activeBaseSaved.roadTypes);
      }
      onChangeProfile?.(activeBaseSaved.id);
      return;
    }

    const presetKey = basePresetKey;
    const syncResult = syncTracageOnActivityChange(
      presetKey,
      currentTracingMode,
      10,
    );
    if (onBatchChangeRoadTypes) {
      onBatchChangeRoadTypes(syncResult.roadTypes, syncResult.priorities);
    } else {
      applyRoadUpdates(syncResult.roadTypes);
    }
    onChangeProfile?.(presetKey);
  };

  const handleSave = () => {
    const profileToSave = buildCustomProfileToSave({
      activeSaved: activeBaseSaved,
      roadTypes,
      priorities,
      newProfileName: nextProfileName,
      basePresetId: effectiveBaseId,
    });

    saveCustomProfileToStorage(profileToSave);
    const updated = getSavedCustomProfiles();
    setSavedProfiles(updated);
    onSaveProfile?.(profileToSave);
    onChangeProfile?.(profileToSave.id);
  };

  const handleDeleteProfile = (id: string) => {
    deleteCustomProfileFromStorage(id);
    const updated = getSavedCustomProfiles();
    setSavedProfiles(updated);
    onDeleteProfile?.(id);
    if (effectiveBaseId === id) {
      handleActivitySelect(footDiscipline ?? 'road');
    }
  };

  return (
    <div className="rvi-tracage">
      {/* ── Top Row: Type d'activité & Mode de traçage (Figma 5918:103513) ── */}
      <div className="rvi-tracage__mode-row">
        <ActivitySelector
          currentActivityName={currentActivityName}
          currentActivityIcon={currentActivityIcon}
          selectedPresetId={selectedPresetId}
          effectiveBaseId={effectiveBaseId}
          savedProfiles={savedProfiles}
          deletableProfileIds={deletableProfileIds}
          draftProfileName={isCustomized && !activeBaseSaved ? nextProfileName : null}
          onSelectActivity={handleActivitySelect}
          onSelectCustomProfile={handleCustomProfileSelect}
          onDeleteProfile={handleDeleteProfile}
        />
        <TracingModeSelector
          currentTracingMode={currentTracingMode}
          onSelect={handleTracingModeSelect}
        />
      </div>

      {/* ── Surfaces (Figma 5918:103521 & 5918:112691) ── */}
      <div className="rvi-tracage__surfaces">
        <span className="rvi-tracage__label">{t('Surfaces')}</span>
        <div className="rvi-tracage__surfaces-row">
          <SurfaceRangeSlider
            safeMinIdx={safeMinIdx}
            safeMaxIdx={safeMaxIdx}
            onSelectRange={handleSurfaceRangeSelect}
          />
          <ToleranceSelect
            currentTolerance={currentTolerance}
            onSelect={(val) => onChangeRoadType?.('surfaceTolerance', val)}
          />
        </div>
      </div>

      <AdditionalParams
        roadTypes={roadTypes}
        isFoot={footDiscipline != null}
        onChangeRoadType={onChangeRoadType}
      />

      {/* ── Recalculer la trace (GPX import with waypoints) ── */}
      {showRecalculateTrace ? (
        <button
          type="button"
          className={`rvi-tracage__recalculate-btn${
            recalculateLoading ? ' is-loading' : ''
          }`}
          onClick={onRecalculateTrace}
          disabled={recalculateLoading}
          aria-label={t('Recalculer la trace')}
        >
          {recalculateLoading ? (
            <>
              <span className="rvi-tracage__recalculate-spinner" />
              <span>
                {t('Recalcul en cours')}
                {recalculateProgress != null
                  ? ` ${Math.round(recalculateProgress * 100)}%`
                  : '…'}
              </span>
            </>
          ) : (
            <>
              <span className="rvi-tracage__action-icon">
                <IconRepeatFigma size={14} />
              </span>
              <span>{t('Recalculer la trace')}</span>
            </>
          )}
        </button>
      ) : null}

      {/* ── Custom Actions: Réinitialiser & Enregistrer ── */}
      {isCustomized ? (
        <div className="rvi-tracage__actions-row">
          <button
            type="button"
            className="rvi-tracage__reset-btn"
            onClick={handleReset}
            aria-label={t('Réinitialiser')}
          >
            <span className="rvi-tracage__action-icon">
              <IconRepeatFigma size={14} />
            </span>
            <span>{t('Réinitialiser')}</span>
          </button>

          <button
            type="button"
            className="rvi-tracage__save-btn"
            onClick={handleSave}
            aria-label={t('Enregistrer')}
          >
            <span className="rvi-tracage__action-icon">
              <IconSaveFigma size={14} />
            </span>
            <span>{t('Enregistrer')}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
