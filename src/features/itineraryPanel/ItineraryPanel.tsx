import { useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { MapCanvasGlassBackdrop } from '@/components/MapCanvasGlassBackdrop';
import { useMiddleClickAutoscroll } from '../../lib/useMiddleClickAutoscroll';
import { PanelHeader } from './components/PanelHeader';
import { ItineraryTabs } from './components/ItineraryTabs';
import { ModeTabs } from './components/ModeTabs';
import { ProfileBar } from './components/ProfileBar';
import { TracageSection } from './sections/TracageSection';
import { RythmeSection } from './sections/RythmeSection';
import { PoiSection } from './sections/PoiSection';
import { ComingSoonSection } from './sections/ComingSoonSection';
import { TimelinePanel } from './sections/timeline';
import type { ItineraryPanelProps } from './types';
import './styles/index.css';

export function ItineraryPanel(props: ItineraryPanelProps) {
  const { scrollRef, isAutoscrolling } = useMiddleClickAutoscroll<HTMLDivElement>();
  const [timelineFullscreen, setTimelineFullscreen] = useState(false);
  const {
    project,
    profiles,
    canUndo,
    canRedo,
    width,
    isResizing,
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
    onOpenExpertEditor: _onOpenExpertEditor,
    expertEnabled: _expertEnabled,
    onChangePriority,
    onChangeRoadType,
    onChangeRhythm,
    onUploadFit,
    uploadFitLabel,
    onCalculate,
    calculateLabel,
    calculateDisabled,
    onChangePoiEntry,
    onChangePoiRefine,
    onChangePoiRefineLimit,
    onOpenPoiCategories,
    onLoadPois,
    poiLoading,
    poiProgress,
    poiCount,
    poiError,
    poiLoadDisabled,
    poiLoadDisabledReason,
    onChangeTimelineView,
    onAddTimelineItem,
    onToggleTimelineItem,
    onRemoveTimelineItem,
    onFavoriteTimelineItem,
    onOpenTimelineSettings,
    onSelectTimelinePlace,
    routeError,
    routeWarnings,
  } = props;

  const active = project.itineraries.find((i) => i.id === project.activeItineraryId);

  const style: CSSProperties | undefined =
    width !== undefined ? { width: `${width}px` } : undefined;

  useEffect(() => {
    if (!timelineFullscreen) return;

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
  }, [timelineFullscreen]);

  useEffect(() => {
    if (!active && timelineFullscreen) {
      setTimelineFullscreen(false);
    }
  }, [active, timelineFullscreen]);

  const dockTimelinePanel = active ? (
    <TimelinePanel
      items={active.timeline}
      rhythm={active.rhythm}
      prediction={active.prediction ?? null}
      view={project.timelineView}
      onChangeView={onChangeTimelineView}
      onOpenSettings={onOpenTimelineSettings}
      onToggleFullscreen={() => setTimelineFullscreen(true)}
      onAdd={onAddTimelineItem}
      onToggleItem={onToggleTimelineItem}
      onFavoriteItem={onFavoriteTimelineItem}
      onRemoveItem={onRemoveTimelineItem}
      onSelectPlace={onSelectTimelinePlace}
    />
  ) : null;

  const fullscreenTimelinePanel = active ? (
    <TimelinePanel
      items={active.timeline}
      rhythm={active.rhythm}
      prediction={active.prediction ?? null}
      view={project.timelineView}
      isFullscreen
      onChangeView={onChangeTimelineView}
      onOpenSettings={onOpenTimelineSettings}
      onToggleFullscreen={() => setTimelineFullscreen(false)}
      onAdd={onAddTimelineItem}
      onToggleItem={onToggleTimelineItem}
      onFavoriteItem={onFavoriteTimelineItem}
      onRemoveItem={onRemoveTimelineItem}
      onSelectPlace={onSelectTimelinePlace}
    />
  ) : null;

  if (timelineFullscreen && fullscreenTimelinePanel && typeof document !== 'undefined') {
    return createPortal(
      <div className="rvi-panel-fullscreen-root">
        <aside
          className="rvi-panel rvi-panel--timeline-fullscreen"
          role="dialog"
          aria-modal
          aria-label="Timeline en plein écran"
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
      aria-label="Panneau d'itinéraire"
    >
      <PanelHeader
        title={project.name}
        savedAt={project.savedAt}
        sizeBytes={project.sizeBytes}
        privacy={project.privacy}
        onBack={onBackToHome}
        onRename={onRenameProject}
        onSettings={onSaveProject}
        onDownload={onDownloadProject}
        onShare={onShareProject}
      />

      <div className="rvi-divider" />

      <ItineraryTabs
        itineraries={project.itineraries}
        activeId={project.activeItineraryId}
        onSelect={onSelectItinerary}
        onAdd={onOpenAddItinerary ?? onAddItinerary}
        onAddButtonRef={props.onAddButtonRef}
        onRemove={onRemoveItinerary}
        onRename={onRenameItinerary}
      />

      <div className="rvi-divider" />

      <ModeTabs active={project.activeMode} onChange={onChangeMode} />

      <div className="rvi-divider" />

      <div
        ref={scrollRef}
        className={`rvi-panel__scroll${isAutoscrolling ? ' is-middle-autoscrolling' : ''}`}
      >
        {routeError ? (
          <div className="rvi-route-banner rvi-route-banner--error" role="alert">
            {routeError}
          </div>
        ) : null}
        {routeWarnings && routeWarnings.length > 0 ? (
          <div className="rvi-route-banner rvi-route-banner--warn" role="status">
            {routeWarnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        ) : null}
        {active && project.activeMode === 'tracage' ? (
          <>
            <ProfileBar
              profiles={profiles}
              activeProfileId={active.profileId}
              onChange={onChangeProfile}
              onUndo={onUndo}
              onRedo={onRedo}
              canUndo={canUndo}
              canRedo={canRedo}
              onSave={onSaveProfile}
            />
            <TracageSection
              priorities={active.priorities}
              roadTypes={active.roadTypes}
              onChangePriority={onChangePriority}
              onChangeRoadType={onChangeRoadType}
            />
          </>
        ) : null}
        {active && project.activeMode === 'rythme' ? (
          <RythmeSection
            rhythm={active.rhythm}
            onChange={onChangeRhythm}
            onUploadFit={onUploadFit}
            uploadFitLabel={uploadFitLabel}
            onCalculate={onCalculate}
            calculateLabel={calculateLabel}
            calculateDisabled={calculateDisabled}
          />
        ) : null}
        {project.activeMode === 'poi' ? (
          active ? (
            <PoiSection
              poi={active.poi}
              onChangeEntry={onChangePoiEntry}
              onChangeRefine={onChangePoiRefine}
              onChangeRefineLimit={onChangePoiRefineLimit}
              onOpenCategories={onOpenPoiCategories}
              onLoad={onLoadPois}
              loading={poiLoading}
              progress={poiProgress}
              poiCount={poiCount}
              error={poiError}
              disabled={poiLoadDisabled}
              disabledReason={poiLoadDisabledReason}
            />
          ) : (
            <ComingSoonSection title="Points d'intérêt" />
          )
        ) : null}
        {project.activeMode === 'nutrition' ? (
          <ComingSoonSection title="Nutrition" />
        ) : null}

        {dockTimelinePanel}
      </div>

      {onResizeStart ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionner le panneau"
          className={`rvi-panel__resize-handle${isResizing ? ' is-dragging' : ''}`}
          onMouseDown={onResizeStart}
        />
      ) : null}
    </aside>
  );
}
