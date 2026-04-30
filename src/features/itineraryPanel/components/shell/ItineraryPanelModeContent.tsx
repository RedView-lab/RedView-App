import type { ReactNode } from 'react';
import type {
  Itinerary,
  ItineraryPanelProps,
  PanelMode,
  RouteProfile,
} from '../../types';
import { ComingSoonSection } from '../../sections/ComingSoonSection';
import { PoiSection } from '../../sections/PoiSection';
import { RythmeSection } from '../../sections/RythmeSection';
import { TracageSection } from '../../sections/TracageSection';
import { ProfileBar } from './ProfileBar';

type VisiblePanelMode = Exclude<PanelMode, 'nutrition'>;

type ItineraryPanelModeContentProps = Pick<
  ItineraryPanelProps,
  | 'canRedo'
  | 'canUndo'
  | 'calculateDisabled'
  | 'calculateLabel'
  | 'onCalculate'
  | 'onChangePoiEntry'
  | 'onChangePoiRefine'
  | 'onChangeProfile'
  | 'onChangePriority'
  | 'onChangeRhythm'
  | 'onChangeRoadType'
  | 'onLoadPois'
  | 'onOpenPoiCategories'
  | 'onRedo'
  | 'onSaveProfile'
  | 'onUndo'
  | 'onUploadFit'
  | 'poiCount'
  | 'poiError'
  | 'poiLoadDisabled'
  | 'poiLoadDisabledReason'
  | 'poiLoading'
  | 'poiProgress'
  | 'uploadFitLabel'
> & {
  active?: Itinerary;
  activeMode: VisiblePanelMode;
  dockTimelinePanel: ReactNode;
  profiles: RouteProfile[];
};

export function ItineraryPanelModeContent({
  active,
  activeMode,
  canRedo,
  canUndo,
  calculateDisabled,
  calculateLabel,
  dockTimelinePanel,
  onCalculate,
  onChangePoiEntry,
  onChangePoiRefine,
  onChangeProfile,
  onChangePriority,
  onChangeRhythm,
  onChangeRoadType,
  onLoadPois,
  onOpenPoiCategories,
  onRedo,
  onSaveProfile,
  onUndo,
  onUploadFit,
  poiCount,
  poiError,
  poiLoadDisabled,
  poiLoadDisabledReason,
  poiLoading,
  poiProgress,
  profiles,
  uploadFitLabel,
}: ItineraryPanelModeContentProps) {
  let modeContent: ReactNode = null;

  switch (activeMode) {
    case 'tracage':
      modeContent = active ? (
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
          calculateLabel={calculateLabel}
          calculateDisabled={calculateDisabled}
        />
      ) : null;
      break;
    case 'poi':
      modeContent = active ? (
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
      );
      break;
  }

  return (
    <>
      {modeContent}
      {dockTimelinePanel}
    </>
  );
}