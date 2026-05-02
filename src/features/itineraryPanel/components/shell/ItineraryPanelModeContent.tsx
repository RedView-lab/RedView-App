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
import { ComingSoonSection } from '../../sections/ComingSoonSection';
import { PoiSection } from '../../sections/PoiSection';
import { RythmeSection } from '../../sections/RythmeSection';
import { TracageSection } from '../../sections/TracageSection';
import { ProfileBar } from './ProfileBar';

type VisiblePanelMode = Exclude<PanelMode, 'nutrition'>;

const DEFAULT_DOCK_HEIGHT_PX = 320;
const MIN_DOCK_HEIGHT_PX = 260;
const MIN_MODE_CONTENT_HEIGHT_PX = 168;

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
  const splitRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [splitHeight, setSplitHeight] = useState(0);
  const [dockHeights, setDockHeights] = useState<Partial<Record<VisiblePanelMode, number>>>({});
  const [isDockResizing, setIsDockResizing] = useState(false);
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

  const minDockHeight = useMemo(() => {
    if (splitHeight <= 0) return MIN_DOCK_HEIGHT_PX;
    return Math.max(180, Math.min(MIN_DOCK_HEIGHT_PX, Math.round(splitHeight * 0.34)));
  }, [splitHeight]);

  const maxDockHeight = useMemo(() => {
    if (splitHeight <= 0) return DEFAULT_DOCK_HEIGHT_PX;
    return Math.max(minDockHeight, splitHeight - MIN_MODE_CONTENT_HEIGHT_PX);
  }, [minDockHeight, splitHeight]);

  const defaultDockHeight = useMemo(() => {
    if (splitHeight <= 0) return DEFAULT_DOCK_HEIGHT_PX;
    const proportionalHeight = Math.round(splitHeight * 0.42);
    return clamp(proportionalHeight, minDockHeight, maxDockHeight);
  }, [maxDockHeight, minDockHeight, splitHeight]);

  const resolvedDockHeight = useMemo(() => {
    const storedHeight = dockHeights[activeMode];
    return clamp(storedHeight ?? defaultDockHeight, minDockHeight, maxDockHeight);
  }, [activeMode, defaultDockHeight, dockHeights, maxDockHeight, minDockHeight]);

  const dockExpandProgress = useMemo(() => {
    if (maxDockHeight <= defaultDockHeight) return 0;
    return clamp(
      (resolvedDockHeight - defaultDockHeight) / (maxDockHeight - defaultDockHeight),
      0,
      1,
    );
  }, [defaultDockHeight, maxDockHeight, resolvedDockHeight]);

  useEffect(() => {
    if (!isDockResizing) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState) return;
      const nextHeight = clamp(
        dragState.startHeight - (event.clientY - dragState.startY),
        minDockHeight,
        maxDockHeight,
      );
      setDockHeights((current) => {
        if (current[activeMode] === nextHeight) return current;
        return { ...current, [activeMode]: nextHeight };
      });
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
  }, [activeMode, isDockResizing, maxDockHeight, minDockHeight]);

  const handleDockResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragStateRef.current = {
      startY: event.clientY,
      startHeight: resolvedDockHeight,
    };
    setIsDockResizing(true);
  };

  const modeMainStyle = {
    '--rvi-main-dispawn': dockExpandProgress.toFixed(3),
  } as CSSProperties;

  const dockSlotStyle = {
    flexBasis: `${resolvedDockHeight}px`,
  } satisfies CSSProperties;

  return (
    <div
      ref={splitRef}
      className={`rvi-panel__mode-layout${isDockResizing ? ' is-dock-resizing' : ''}`}
    >
      <div className="rvi-panel__mode-main" style={modeMainStyle}>
        <div className="rvi-panel__mode-main-inner">{modeContent}</div>
      </div>

      <div className="rvi-panel__dock-slot" style={dockSlotStyle}>
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Redimensionner la feuille de route"
          className={`rvi-panel__dock-resize-hitbox${isDockResizing ? ' is-dragging' : ''}`}
          onPointerDown={handleDockResizeStart}
        >
          <span className="rvi-panel__dock-resize-grip" aria-hidden />
        </div>

        <div className="rvi-panel__dock-content">{dockTimelinePanel}</div>
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}