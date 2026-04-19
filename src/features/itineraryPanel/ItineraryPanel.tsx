import type { CSSProperties } from 'react';
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
  const {
    project,
    profiles,
    canUndo,
    canRedo,
    width,
    isResizing,
    onResizeStart,
    onClose,
    onSaveProject,
    onDownloadProject,
    onShareProject,
    onRenameProject,
    onSelectItinerary,
    onAddItinerary,
    onOpenAddItinerary,
    onRemoveItinerary,
    onChangeMode,
    onChangeProfile,
    onUndo,
    onRedo,
    onSaveProfile,
    onOpenExpertEditor,
    expertEnabled,
    onChangePriority,
    onChangeRoadType,
    onChangeRhythm,
    onUploadFit,
    onCalculate,
    onChangePoiEntry,
    onChangePoiRefine,
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
    onSearchTimeline,
    onOpenTimelineSettings,
    onSelectTimelinePlace,
    routeError,
    routeWarnings,
  } = props;

  const active = project.itineraries.find((i) => i.id === project.activeItineraryId);

  const style: CSSProperties | undefined =
    width !== undefined ? { width: `${width}px` } : undefined;

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
        onClose={onClose}
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
        onRemove={onRemoveItinerary}
      />

      <div className="rvi-divider" />

      <ModeTabs active={project.activeMode} onChange={onChangeMode} />

      <div className="rvi-divider" />

      <div className="rvi-panel__scroll">
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
            onCalculate={onCalculate}
          />
        ) : null}
        {project.activeMode === 'poi' ? (
          active ? (
            <PoiSection
              poi={active.poi}
              onChangeEntry={onChangePoiEntry}
              onChangeRefine={onChangePoiRefine}
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

        {active ? (
          <TimelinePanel
            items={active.timeline}
            view={project.timelineView}
            onChangeView={onChangeTimelineView}
            onSearch={onSearchTimeline}
            onOpenSettings={onOpenTimelineSettings}
            onAdd={onAddTimelineItem}
            onToggleItem={onToggleTimelineItem}
            onFavoriteItem={onFavoriteTimelineItem}
            onRemoveItem={onRemoveTimelineItem}
            onSelectPlace={onSelectTimelinePlace}
          />
        ) : null}
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
