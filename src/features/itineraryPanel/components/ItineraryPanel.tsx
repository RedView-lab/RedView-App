import { useEffect, useId, useState, type CSSProperties, type WheelEvent as ReactWheelEvent } from 'react';
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
  const modeContentId = useId();
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
    onDuplicateItinerary,
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
  const [collapsedMode, setCollapsedMode] = useState<Exclude<PanelMode, 'nutrition'> | null>(null);
  const modeCollapsed = collapsedMode === activeMode;
  const isTimelineFullscreenOpen = timelineFullscreen && Boolean(active);

  const style: CSSProperties | undefined =
    width !== undefined ? { width: `${width}px` } : undefined;

  const handleWheelCapture = (event: ReactWheelEvent<HTMLDivElement>) => {
    const root = scrollRef.current;
    if (!root || event.defaultPrevented || event.ctrlKey) return;
    if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;

    const scrollNodes = collectScrollableAncestors(event.target, root);
    for (const node of scrollNodes) {
      const maxScrollTop = node.scrollHeight - node.clientHeight;
      if (maxScrollTop <= 0) continue;

      const nextScrollTop = clampScroll(node.scrollTop + event.deltaY, 0, maxScrollTop);
      if (Math.abs(nextScrollTop - node.scrollTop) < 0.5) continue;

      node.scrollTop = nextScrollTop;
      event.preventDefault();
      return;
    }
  };

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

  const handleModeChange = (mode: Exclude<PanelMode, 'nutrition'>) => {
    if (mode === activeMode) {
      setCollapsedMode((current) => (current === mode ? null : mode));
      return;
    }

    setCollapsedMode(null);
    onChangeMode?.(mode);
  };

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
        onDuplicate={onDuplicateItinerary}
        onRemove={onRemoveItinerary}
        onRename={onRenameItinerary}
      />

      <div className="rvi-divider" />

      <ModeTabs
        active={activeMode}
        collapsed={modeCollapsed}
        controlsId={modeContentId}
        onChange={handleModeChange}
      />

      <div className="rvi-divider" />

      <div
        ref={scrollRef}
        className={`rvi-panel__scroll${isAutoscrolling ? ' is-middle-autoscrolling' : ''}`}
        onWheelCapture={handleWheelCapture}
      >
        <RouteStatusBanners routeError={routeError} routeWarnings={routeWarnings} />
        <ItineraryPanelModeContent
          active={active ?? undefined}
          activeMode={activeMode}
          canRedo={canRedo}
          canUndo={canUndo}
          collapsed={modeCollapsed}
          contentId={modeContentId}
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

function collectScrollableAncestors(
  target: EventTarget | null,
  root: HTMLElement,
): HTMLElement[] {
  const result: HTMLElement[] = [];
  let current = target instanceof HTMLElement ? target : root;

  while (current) {
    if (isVerticallyScrollable(current)) {
      result.push(current);
    }
    if (current === root) break;
    current = current.parentElement ?? root;
  }

  if (!result.includes(root) && isVerticallyScrollable(root)) {
    result.push(root);
  }

  return result;
}

function isVerticallyScrollable(node: HTMLElement): boolean {
  const style = window.getComputedStyle(node);
  return /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
}

function clampScroll(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
