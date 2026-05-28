import { useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import { useAppI18n } from '@/shared/i18n';
import { useMiddleClickAutoscroll } from '@/shared/hooks/useMiddleClickAutoscroll';
import {
  ItineraryPanelModeContent,
  ItineraryTabs,
  ModeTabs,
  PanelHeader,
  RouteStatusBanners,
} from './shell';
import { TimelinePanel } from '../sections/timeline';
import {
  DEFAULT_TIMELINE_TABLE_SETTINGS,
  type TimelineTableSettingsState,
} from '../sections/timeline/TimelineTableSettings';
import type { ItineraryPanelProps, PanelMode, PoiCategory } from '../types';
import '../styles/index.css';

function resolveVisiblePanelMode(mode: PanelMode): Exclude<PanelMode, 'nutrition'> {
  return mode === 'nutrition' ? 'tracage' : mode;
}

export function ItineraryPanel(props: ItineraryPanelProps) {
  const { t } = useAppI18n();
  const { scrollRef, isAutoscrolling } = useMiddleClickAutoscroll<HTMLDivElement>();
  const [timelineFullscreen, setTimelineFullscreen] = useState(false);
  const [timelineTableSettings, setTimelineTableSettings] = useState<TimelineTableSettingsState>(
    DEFAULT_TIMELINE_TABLE_SETTINGS,
  );
  const {
    project,
    profiles,
    canUndo,
    canRedo,
    width,
    isResizing,
    isReturningToBrowser,
    onResizeStart,
    onBackToHome,
    onSaveProject,
    onDownloadProject,
    onShareProject,
    onRenameProject,
    onSelectItinerary,
    onAddItinerary,
    onOpenAddItinerary,
    onRemoveItinerary,
    onRenameItinerary,
    onChangeMode,
    onChangeProfile,
    onUndo,
    onRedo,
    onSaveProfile,
    onChangePriority,
    onChangeRoadType,
    onRefreshRoute,
    onCancelRoute,
    onChangeRhythm,
    onUploadFit,
    uploadFitLabel,
    onCalculate,
    onCancelCalculate,
    calculateLabel,
    calculateDisabled,
    onChangePoiEntry,
    onChangePoiRefine,
    onOpenPoiCategories,
    onLoadPois,
    onCancelLoadPois,
    poiLoading,
    poiProgress,
    poiCount,
    poiError,
    poiLoadDisabled,
    poiLoadDisabledReason,
    routeLoading,
    onChangeTimelineView,
    onAddTimelineItem,
    onToggleTimelineItem,
    onMoveTimelinePause,
    onChangeTimelinePauseDuration,
    onRemoveTimelineItem,
    onFavoriteTimelineItem,
    onOpenTimelineSettings,
    onSelectTimelinePlace,
    routeError,
    routeWarnings,
  } = props;

  const active = project.itineraries.find((i) => i.id === project.activeItineraryId);
  const activeMode = resolveVisiblePanelMode(project.activeMode);
  const isTimelineFullscreenOpen = timelineFullscreen && Boolean(active);

  const style: CSSProperties | undefined =
    width !== undefined ? { width: `${width}px` } : undefined;

  useEffect(() => {
    if (project.activeMode === 'nutrition') {
      onChangeMode?.('tracage');
    }
  }, [onChangeMode, project.activeMode]);

  useEffect(() => {
    if (!isTimelineFullscreenOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTimelineFullscreen(false);
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isTimelineFullscreenOpen]);

  const timelinePanelProps = active
    ? {
        items: active.timeline,
        rhythm: active.rhythm,
        prediction: active.prediction ?? null,
        view: project.timelineView,
        onChangeView: onChangeTimelineView,
        onOpenSettings: onOpenTimelineSettings,
        onAdd: onAddTimelineItem,
        onToggleItem: onToggleTimelineItem,
        onMovePause: onMoveTimelinePause,
        onChangePauseDuration: onChangeTimelinePauseDuration,
        onChangeIntervalPauseDuration: (pauseIntervalId: string, durationMin: number) => {
          if (!active || !onChangeRhythm) return;
          onChangeRhythm(
            'pauseIntervals',
            active.rhythm.pauseIntervals.map((row) => (
              row.id === pauseIntervalId
                ? { ...row, durationMin: Math.max(0, Math.round(durationMin)) }
                : row
            )),
          );
        },
        onChangeFavoritePoiPauseDuration: (category: PoiCategory, durationMin: number) => {
          if (!active || !onChangeRhythm) return;
          onChangeRhythm('poiPauseDurations', {
            ...active.rhythm.poiPauseDurations,
            [category]: Math.max(0, Math.round(durationMin)),
          });
        },
        onFavoriteItem: onFavoriteTimelineItem,
        onRemoveItem: onRemoveTimelineItem,
        onSelectPlace: onSelectTimelinePlace,
      }
    : null;

  const dockTimelinePanel = timelinePanelProps ? (
    <TimelinePanel
      {...timelinePanelProps}
      tableSettings={timelineTableSettings}
      onChangeTableSettings={setTimelineTableSettings}
      onToggleFullscreen={() => setTimelineFullscreen(true)}
    />
  ) : null;

  const fullscreenTimelinePanel = timelinePanelProps ? (
    <TimelinePanel
      {...timelinePanelProps}
      isFullscreen
      tableSettings={timelineTableSettings}
      onChangeTableSettings={setTimelineTableSettings}
      onToggleFullscreen={() => setTimelineFullscreen(false)}
    />
  ) : null;

  if (isTimelineFullscreenOpen && fullscreenTimelinePanel && typeof document !== 'undefined') {
    return createPortal(
      <div className="rvi-panel-fullscreen-root">
        <aside
          className="rvi-panel rvi-panel--timeline-fullscreen"
          role="dialog"
          aria-modal
          aria-label={t('Timeline en plein écran')}
        >
          <MapCanvasGlassBackdrop
            blur={38}
            saturate={1.9}
            tint="rgba(5, 8, 8, 0.58)"
          />
          <div className="rvi-panel__fullscreen-body">{fullscreenTimelinePanel}</div>
        </aside>
      </div>,
      document.body,
    );
  }

  return (
    <aside
      className={`rvi-panel${isResizing ? ' is-resizing' : ''}`}
      style={style}
      aria-label={t('Panneau d’itinéraire')}
    >
      <PanelHeader
        title={project.name}
        savedAt={project.savedAt}
        sizeBytes={project.sizeBytes}
        privacy={project.privacy}
        backDisabled={isReturningToBrowser}
        onBack={onBackToHome}
        onRename={onRenameProject}
        onSettings={onSaveProject}
        onDownload={onDownloadProject}
        onShare={onShareProject}
      />

      <div className="rvi-divider" />

      <ItineraryTabs
        itineraries={project.itineraries}
        profiles={profiles}
        activeId={project.activeItineraryId}
        onSelect={onSelectItinerary}
        onAdd={onOpenAddItinerary ?? onAddItinerary}
        onAddButtonRef={props.onAddButtonRef}
        onRemove={onRemoveItinerary}
        onRename={onRenameItinerary}
      />

      <div className="rvi-divider" />

      <ModeTabs active={activeMode} onChange={onChangeMode} />

      <div className="rvi-divider" />

      <div
        ref={scrollRef}
        className={`rvi-panel__scroll${isAutoscrolling ? ' is-middle-autoscrolling' : ''}`}
      >
        <RouteStatusBanners routeError={routeError} routeWarnings={routeWarnings} />
        <ItineraryPanelModeContent
          active={active ?? undefined}
          activeMode={activeMode}
          canRedo={canRedo}
          canUndo={canUndo}
          onCancelCalculate={onCancelCalculate}
          onCancelLoadPois={onCancelLoadPois}
          onCancelRoute={onCancelRoute}
          calculateDisabled={calculateDisabled}
          calculateLabel={calculateLabel}
          dockTimelinePanel={dockTimelinePanel}
          onCalculate={onCalculate}
          onChangePoiEntry={onChangePoiEntry}
          onChangePoiRefine={onChangePoiRefine}
          onChangeProfile={onChangeProfile}
          onChangePriority={onChangePriority}
          onChangeRhythm={onChangeRhythm}
          onChangeRoadType={onChangeRoadType}
          onLoadPois={onLoadPois}
          onOpenPoiCategories={onOpenPoiCategories}
          onRefreshRoute={onRefreshRoute}
          onRedo={onRedo}
          onSaveProfile={onSaveProfile}
          onUndo={onUndo}
          onUploadFit={onUploadFit}
          poiCount={poiCount}
          poiError={poiError}
          poiLoadDisabled={poiLoadDisabled}
          poiLoadDisabledReason={poiLoadDisabledReason}
          poiLoading={poiLoading}
          poiProgress={poiProgress}
          profiles={profiles}
          routeLoading={routeLoading}
          uploadFitLabel={uploadFitLabel}
        />
      </div>

      {onResizeStart ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('Redimensionner le panneau')}
          className={`rvi-panel__resize-handle${isResizing ? ' is-dragging' : ''}`}
          onMouseDown={onResizeStart}
        />
      ) : null}
    </aside>
  );
}
