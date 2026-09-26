import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type {
  Itinerary,
  ItineraryPanelProps,
  PanelMode,
  RouteProfile,
} from '../../types';
import { buildPauseAwareSchedule } from '../../lib/schedule';
import { Collapse } from './Collapse';
import { ComingSoonSection } from '../../sections/ComingSoonSection';
import { PoiSection } from '../../sections/PoiSection';
import { RythmeSection } from '../../sections/RythmeSection';
import { TracageSection } from '../../sections/TracageSection';

type VisiblePanelMode = Exclude<PanelMode, 'nutrition'>;

const MIN_DOCK_HEIGHT_PX = 180;
const MIN_MODE_CONTENT_HEIGHT_PX = 168;

type ItineraryPanelModeContentProps = Pick<
  ItineraryPanelProps,
  | 'canRedo'
  | 'canUndo'
  | 'onCancelCalculate'
  | 'onCancelLoadPois'
  | 'onCancelRoute'
  | 'calculateDisabled'
  | 'calculateLabel'
  | 'onCalculate'
  | 'onChangePoiEntry'
  | 'onChangeProfile'
  | 'onChangePriority'
  | 'onChangeRhythm'
  | 'onChangeRoadType'
  | 'onBatchChangeRoadTypes'
  | 'onLoadPois'
  | 'onOpenPoiCategories'
  | 'onRefreshRoute'
  | 'onRedo'
  | 'onSaveProfile'
  | 'onDeleteProfile'
  | 'onUndo'
  | 'onUploadFit'
  | 'poiCount'
  | 'poiError'
  | 'poiLoadDisabled'
  | 'poiLoadDisabledReason'
  | 'poiLoading'
  | 'poiProgress'
  | 'routeLoading'
  | 'uploadFitLabel'
> & {
  active?: Itinerary;
  activeMode: VisiblePanelMode;
  collapsed?: boolean;
  contentId?: string;
  dockTimelinePanel: ReactNode;
  profiles: RouteProfile[];
};

export function ItineraryPanelModeContent({
  active,
  activeMode,
  canRedo,
  canUndo,
  onCancelCalculate,
  onCancelLoadPois,
  onCancelRoute,
  calculateDisabled,
  calculateLabel,
  dockTimelinePanel,
  onCalculate,
  onChangePoiEntry,
  onChangeProfile,
  onChangePriority,
  onChangeRhythm,
  onChangeRoadType,
  onBatchChangeRoadTypes,
  onLoadPois,
  onRefreshRoute,
  onRedo,
  onSaveProfile,
  onDeleteProfile,
  onUndo,
  onUploadFit,
  collapsed = false,
  contentId,
  poiCount,
  poiError,
  poiLoadDisabled,
  poiLoadDisabledReason,
  poiLoading,
  poiProgress,
  profiles,
  routeLoading,
  uploadFitLabel,
}: ItineraryPanelModeContentProps) {
  const splitRef = useRef<HTMLDivElement | null>(null);
  const dockSlotRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    startY: number;
    startHeight: number;
    naturalHeight: number;
  } | null>(null);
  const [splitHeight, setSplitHeight] = useState(0);
  const [customDockHeight, setCustomDockHeight] = useState<number | null>(null);
  const [isDockResizing, setIsDockResizing] = useState(false);
  const routeResultLabel = active ? buildRouteResultLabel(active) : null;
  const rhythmResultLabel = active ? buildRhythmResultLabel(active) : null;
  let modeContent: ReactNode = null;

  switch (activeMode) {
    case 'tracage':
      modeContent = active ? (
        <TracageSection
          priorities={active.priorities}
          roadTypes={active.roadTypes}
          profiles={profiles}
          activeProfileId={active.profileId}
          onChangeProfile={onChangeProfile}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={onUndo}
          onRedo={onRedo}
          onSaveProfile={onSaveProfile}
          onDeleteProfile={onDeleteProfile}
          onChangePriority={onChangePriority}
          onChangeRoadType={onChangeRoadType}
          onBatchChangeRoadTypes={onBatchChangeRoadTypes}
          onApply={onRefreshRoute}
          onCancelApply={onCancelRoute}
          applyLoading={routeLoading}
          resultLabel={routeResultLabel}
        />
      ) : null;
      break;
    case 'rythme':
      modeContent = active ? (
        <RythmeSection
          rhythm={active.rhythm}
          onChange={onChangeRhythm}
          onUploadFit={onUploadFit}
          uploadFitLabel={uploadFitLabel}
          onCalculate={onCalculate}
          onCancelCalculate={onCancelCalculate}
          calculateLabel={calculateLabel}
          calculateDisabled={calculateDisabled}
          resultLabel={rhythmResultLabel}
        />
      ) : null;
      break;
    case 'poi':
      modeContent = active ? (
        <PoiSection
          poi={active.poi}
          onChangeEntry={onChangePoiEntry}
          onLoad={onLoadPois}
          onCancelLoad={onCancelLoadPois}
          loading={poiLoading}
          progress={poiProgress}
          poiCount={poiCount}
          error={poiError}
          disabled={poiLoadDisabled}
          disabledReason={poiLoadDisabledReason}
        />
      ) : (
        <ComingSoonSection title="Points d'intérêt" />
      );
      break;
  }

  // When switching active mode (e.g. Rythme -> Tracage), reset custom dock height
  // so the dock immediately hugs the active mode's natural height and fills the rest of the panel.
  useEffect(() => {
    setCustomDockHeight(null);
  }, [activeMode]);

  useEffect(() => {
    setCustomDockHeight(null);
  }, [collapsed]);

  useEffect(() => {
    const node = splitRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const nextHeight = entries[0]?.contentRect.height ?? 0;
      setSplitHeight(nextHeight);
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const effectiveDockMin = customDockHeight !== null ? customDockHeight : MIN_DOCK_HEIGHT_PX;
  const maxModeHeight = useMemo(() => {
    if (splitHeight <= 0) return undefined;
    return Math.max(MIN_MODE_CONTENT_HEIGHT_PX, splitHeight - effectiveDockMin - 12);
  }, [effectiveDockMin, splitHeight]);

  useEffect(() => {
    if (!isDockResizing) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState) return;
      const deltaY = dragState.startY - event.clientY;
      const nextHeight = Math.round(dragState.startHeight + deltaY);
      const maxAllowedDockHeight = Math.max(
        MIN_DOCK_HEIGHT_PX,
        splitHeight - MIN_MODE_CONTENT_HEIGHT_PX - 12,
      );

      if (nextHeight <= dragState.naturalHeight) {
        setCustomDockHeight(null);
      } else {
        setCustomDockHeight(Math.min(nextHeight, maxAllowedDockHeight));
      }
    };

    const stopResize = () => {
      dragStateRef.current = null;
      setIsDockResizing(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };
  }, [isDockResizing, splitHeight]);

  const handleDockResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const currentDockHeight = Math.round(
      dockSlotRef.current?.getBoundingClientRect().height ?? MIN_DOCK_HEIGHT_PX,
    );
    dragStateRef.current = {
      startY: event.clientY,
      startHeight: customDockHeight ?? currentDockHeight,
      naturalHeight: currentDockHeight,
    };
    setIsDockResizing(true);
  };

  const modeLayoutStyle = {
    '--rvi-min-dock-height': `${MIN_DOCK_HEIGHT_PX}px`,
    ...(maxModeHeight !== undefined ? { '--rvi-mode-max-height': `${maxModeHeight}px` } : {}),
    ...(customDockHeight !== null ? { '--rvi-dock-custom-height': `${customDockHeight}px` } : {}),
  } as CSSProperties;

  return (
    <div
      ref={splitRef}
      id={contentId}
      className={`rvi-panel__mode-layout${isDockResizing ? ' is-dock-resizing' : ''}${collapsed ? ' is-collapsed' : ''}`}
      style={modeLayoutStyle}
    >
      <div className="rvi-panel__mode-main">
        <Collapse open={!collapsed} className="rvi-panel__mode-main-collapse">
          <div className="rvi-panel__mode-main-inner">{modeContent}</div>
        </Collapse>
      </div>

      <div ref={dockSlotRef} className="rvi-panel__dock-slot">
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Redimensionner la feuille de route"
          className={`rvi-panel__dock-resize-hitbox${isDockResizing ? ' is-dragging' : ''}`}
          onPointerDown={handleDockResizeStart}
          onDoubleClick={() => setCustomDockHeight(null)}
        >
          <span className="rvi-panel__dock-resize-grip" aria-hidden />
        </div>

        <div className="rvi-panel__dock-content">{dockTimelinePanel}</div>
      </div>
    </div>
  );
}


function buildRouteResultLabel(active: Itinerary): string | null {
  const distanceKm = active.metrics?.distanceKm
    ?? active.timeline.find((item) => item.kind === 'end')?.distanceKm
    ?? null;
  if (distanceKm == null || !Number.isFinite(distanceKm) || distanceKm <= 0) {
    return null;
  }
  return `(${distanceKm.toFixed(2)} km)`;
}

function buildRhythmResultLabel(active: Itinerary): string | null {
  const schedule = active.prediction ? buildPauseAwareSchedule(active, active.prediction) : null;
  const durationSeconds = schedule?.totalDurationSeconds ?? active.metrics?.durationSec ?? null;
  if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null;
  }

  const pauseSeconds = schedule
    ? schedule.pauseSpans.reduce((total, span) => total + span.durationSeconds, 0)
    : 0;

  if (pauseSeconds > 0) {
    return `(${formatCompactDuration(durationSeconds)} et ${formatCompactDuration(pauseSeconds)} de pause)`;
  }

  return `(${formatCompactDuration(durationSeconds)})`;
}

function formatCompactDuration(totalSeconds: number): string {
  const roundedMinutes = Math.max(0, Math.round(totalSeconds / 60));
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h${String(minutes).padStart(2, '0')}m`;
}