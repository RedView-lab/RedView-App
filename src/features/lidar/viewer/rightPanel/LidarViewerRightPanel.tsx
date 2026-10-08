import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppI18nProvider } from '@/shared/i18n';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { SlopesSection } from '@/features/controlPanel/sections/SlopesSection';
import { AltitudeSection } from '@/features/controlPanel/sections/AltitudeSection';
import { SunlightSection } from '@/features/controlPanel/sections/SunlightSection';
import { RouteSection } from './RouteSection';
import { PhotoModeSection } from '../photoMode/PhotoModeSection';
import type { PhotoCaptureStatus, PhotoModeState } from '../photoMode/types';
import {
  PointFilterSection,
  getDefaultPointFilterCategories,
  type PointFilterCategoryId,
  type PointFilterCategoryVisibility,
  type ViewerPointFilterState,
} from '../pointFilter';
import type { ViewerRouteController } from '../route/viewerRouteController';
import type { ViewerRouteState } from '../route/types';
import { resolveSunTimesForLocalDay } from '@/features/sunlight/lib/sun-calc';
import type { ViewerSlopeState, ViewerAltitudeState } from './types';
import type { SunlightState } from '@/features/controlPanel/types';
import { useRightPanelLayout } from './useRightPanelLayout';
import { useSlopeLayer } from './useSlopeLayer';
import { useAltitudeLayer } from './useAltitudeLayer';
import { useSunlightLayer } from './useSunlightLayer';
import '@/features/controlPanel/styles/index.css';
import '@/features/itineraryPanel/styles/overlays/_calendar-popover.css';
import './styles.css';

/** Photo mode section (see photoMode/): state lives in the panel, the viewer applies it. */
export interface ViewerPhotoModeProps {
  /** False on the WebGL 2 backend: the section shows why it is unavailable. */
  available: boolean;
  initialState: PhotoModeState;
  /** Automatic cloud base (m) and the bounds of its offset for this scene. */
  cloudBase: { autoAltitudeM: number; minOffsetM: number; maxOffsetM: number };
  onChange: (state: PhotoModeState) => void;
  onCapture: () => void;
  captureStore: { subscribe: (listener: () => void) => () => void; getSnapshot: () => PhotoCaptureStatus };
}

const IDLE_CAPTURE: PhotoCaptureStatus = { busy: false, done: 0, total: 0, error: null };
const noSubscription = () => () => undefined;

export interface LidarViewerRightPanelProps {
  onPointFilterChange?: (state: ViewerPointFilterState) => void;
  onSlopeChange?: (state: ViewerSlopeState) => void;
  onAltitudeChange?: (state: ViewerAltitudeState) => void;
  onSunlightChange?: (state: SunlightState) => void;
  routeController?: ViewerRouteController;
  centerLon?: number;
  centerLat?: number;
  timeZone?: string;
  photo?: ViewerPhotoModeProps;
}

function LidarViewerRightPanelContent({
  onPointFilterChange,
  onSlopeChange,
  onAltitudeChange,
  onSunlightChange,
  routeController,
  centerLon,
  centerLat,
  timeZone,
  photo,
}: LidarViewerRightPanelProps) {
  const [routeState, setRouteState] = useState<ViewerRouteState | null>(() => routeController?.getState() ?? null);

  useEffect(() => {
    if (!routeController) return;
    return routeController.onStateChange(setRouteState);
  }, [routeController]);

  const { panelWidth, isCollapsed, isResizing, handleResizeStart, handleRestore } = useRightPanelLayout();

  const [sectionsOpen, setSectionsOpen] = useState<{
    photo: boolean;
    route: boolean;
    pointFilter: boolean;
    slopes: boolean;
    altitude: boolean;
    sunlight: boolean;
  }>(() => ({
    photo: photo?.initialState.enabled ?? false,
    route: true,
    pointFilter: false,
    slopes: false,
    altitude: false,
    sunlight: true,
  }));

  // ── Photo mode ───────────────────────────────────────────────────────────
  const [photoState, setPhotoState] = useState<PhotoModeState | null>(() => photo?.initialState ?? null);
  const onPhotoChange = photo?.onChange;
  useEffect(() => {
    if (photoState) onPhotoChange?.(photoState);
  }, [onPhotoChange, photoState]);
  const captureStatus = useSyncExternalStore(
    photo?.captureStore.subscribe ?? noSubscription,
    photo?.captureStore.getSnapshot ?? (() => IDLE_CAPTURE),
  );

  // ── Point Filter State ───────────────────────────────────────────────────
  const [pointFilterEnabled, setPointFilterEnabled] = useState(false);
  const [pointFilterCategories, setPointFilterCategories] = useState<PointFilterCategoryVisibility>(getDefaultPointFilterCategories);

  const pointFilterState = useMemo<ViewerPointFilterState>(
    () => ({
      enabled: pointFilterEnabled,
      categories: pointFilterCategories,
    }),
    [pointFilterEnabled, pointFilterCategories],
  );

  useEffect(() => {
    onPointFilterChange?.(pointFilterState);
  }, [onPointFilterChange, pointFilterState]);

  const handlePointFilterCategoryToggle = useCallback((id: PointFilterCategoryId, visible: boolean) => {
    setPointFilterCategories((prev) => ({ ...prev, [id]: visible }));
  }, []);

  // ── Slopes, altitude, sunlight ────────────────────────────────────────────
  const {
    slopesEnabled,
    setSlopesEnabled,
    slopeResolution,
    setSlopeResolution,
    slopeColorization,
    setSlopeColorization,
    slopeScale,
    setSlopeScale,
    slopeScaleSetting,
    setSlopeScaleSetting,
    slopeOpacity,
    setSlopeOpacity,
    setSlopeCustomColors,
    setSlopeBandVisibility,
    slopeBands,
    handleSlopeBandBreakpointChange,
  } = useSlopeLayer(onSlopeChange);

  const {
    altitudeEnabled,
    setAltitudeEnabled,
    altitudeColorization,
    setAltitudeColorization,
    altitudeScaleSetting,
    setAltitudeScaleSetting,
    altitudeOpacity,
    setAltitudeOpacity,
    setAltitudeCustomColors,
    setAltitudeHiddenBandIds,
    altitudeBands,
    handleAltitudeBandBreakpointChange,
  } = useAltitudeLayer(onAltitudeChange);

  const {
    localTimeZone,
    sunlightState,
    setSunlightState,
    sunlightMapExpanded,
    setSunlightMapExpanded,
    handleSunlightStateChange,
  } = useSunlightLayer(onSunlightChange, centerLon, centerLat, timeZone);

  const photoSunTimes = useMemo(() => {
    if (!photoState || centerLat == null || centerLon == null) return { sunriseTime: '--:--', sunsetTime: '--:--' };
    const times = resolveSunTimesForLocalDay(photoState.date, centerLat, centerLon, localTimeZone);
    return { sunriseTime: times.sunriseTime, sunsetTime: times.sunsetTime };
  }, [photoState, centerLat, centerLon, localTimeZone]);

  return (
    <>
      <aside
        className={`rvc-panel lidar-viewer-right-panel${isResizing ? ' is-resizing' : ''}${isCollapsed ? ' is-collapsed' : ''}`}
        style={{ width: `min(${panelWidth}px, calc(100vw / var(--app-scale, 1) - 32px))` }}
        aria-label="Panneau des couches d'analyse"
      >
        <div
          className={`rvc-panel__resize-handle${isResizing ? ' is-dragging' : ''}`}
          onMouseDown={handleResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionner le panneau"
        />
        <div className="rvc-panel__content">
          {photo && photoState ? (
            <PhotoModeSection
              available={photo.available}
              state={photoState}
              open={sectionsOpen.photo}
              onOpenChange={(open) => setSectionsOpen((prev) => ({ ...prev, photo: open }))}
              onEnabledChange={(enabled) => {
                setPhotoState((prev) => (prev ? { ...prev, enabled } : prev));
                if (enabled) setSectionsOpen((prev) => ({ ...prev, photo: true }));
              }}
              onChange={(changes) => setPhotoState((prev) => (prev ? { ...prev, ...changes } : prev))}
              {...photoSunTimes}
              cloudBase={photo.cloudBase}
              capture={captureStatus}
              onCapture={photo.onCapture}
            />
          ) : null}
          {routeState && (
            <RouteSection
              state={routeState}
              open={sectionsOpen.route}
              onOpenChange={(open) => setSectionsOpen((prev) => ({ ...prev, route: open }))}
              onEnabledChange={(enabled) => routeController?.setEnabled(enabled)}
              onRibbonWidthChange={(width) => routeController?.setRibbonWidth(width)}
              onSelectRouteId={(id) => routeController?.setSelectedRouteId(id)}
              onCreateRoute={() => routeController?.createRoute()}
              onColorChange={(id, color) => routeController?.setRouteColor(id, color)}
              onRouteOpacityChange={(id, opacity) => routeController?.setRouteOpacity(id, opacity)}
              onVisibilityToggle={(id) => routeController?.toggleRouteVisibility(id)}
              onToggleEditMode={(id) => {
                if (routeController?.getActiveRoute()?.id !== id) {
                  routeController?.setSelectedRouteId(id);
                  routeController?.setEditMode(true);
                  routeController?.setActiveTool('append');
                } else {
                  const nextEdit = !routeState.editMode;
                  routeController?.setEditMode(nextEdit);
                  if (nextEdit) routeController?.setActiveTool('append');
                }
              }}
              onRenameRoute={(id, name) => routeController?.renameRoute(id, name)}
              onDuplicateRoute={(id) => routeController?.duplicateRoute(id)}
              onExportRouteGpx={(id) => routeController?.exportRouteGpx(id)}
              onDeleteRoute={(id) => routeController?.deleteRoute(id)}
            />
          )}

          <PointFilterSection
            state={pointFilterState}
            open={sectionsOpen.pointFilter}
            onOpenChange={(open) => setSectionsOpen((prev) => ({ ...prev, pointFilter: open }))}
            onEnabledChange={(enabled) => {
              setPointFilterEnabled(enabled);
              if (enabled) setSectionsOpen((prev) => ({ ...prev, pointFilter: true }));
            }}
            onCategoryToggle={handlePointFilterCategoryToggle}
          />

          <SlopesSection
            enabled={slopesEnabled}
            noTopBorder={false}
            showResolution={false}
            open={sectionsOpen.slopes}
            onOpenChange={(open) => setSectionsOpen((prev) => ({ ...prev, slopes: open }))}
            state={{
              resolution: slopeResolution,
              colorization: slopeColorization,
              scale: slopeScale,
              scaleSetting: slopeScaleSetting,
              opacity: slopeOpacity,
              bands: slopeBands,
            }}
            onEnabledChange={(enabled) => {
              setSlopesEnabled(enabled);
              if (enabled) setSectionsOpen((prev) => ({ ...prev, slopes: true }));
            }}
            onResolutionChange={setSlopeResolution}
            onColorizationChange={setSlopeColorization}
            onScaleChange={setSlopeScale}
            onScaleSettingChange={setSlopeScaleSetting}
            onOpacityChange={setSlopeOpacity}
            onBandColorChange={(id, color) => setSlopeCustomColors((prev) => ({ ...prev, [id]: color }))}
            onBandVisibilityToggle={(id) =>
              setSlopeBandVisibility((prev) => ({ ...prev, [id]: prev[id] === false ? true : false }))
            }
            onBandBreakpointChange={handleSlopeBandBreakpointChange}
          />

          <AltitudeSection
            enabled={altitudeEnabled}
            open={sectionsOpen.altitude}
            onOpenChange={(open) => setSectionsOpen((prev) => ({ ...prev, altitude: open }))}
            state={{
              colorization: altitudeColorization,
              scaleSetting: altitudeScaleSetting,
              opacity: altitudeOpacity,
              bands: altitudeBands,
            }}
            onEnabledChange={(enabled) => {
              setAltitudeEnabled(enabled);
              if (enabled) setSectionsOpen((prev) => ({ ...prev, altitude: true }));
            }}
            onColorizationChange={setAltitudeColorization}
            onScaleSettingChange={setAltitudeScaleSetting}
            onOpacityChange={setAltitudeOpacity}
            onBandColorChange={(id, color) => setAltitudeCustomColors((prev) => ({ ...prev, [id]: color }))}
            onBandVisibilityToggle={(id) =>
              setAltitudeHiddenBandIds((prev) =>
                prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
              )
            }
            onBandBreakpointChange={handleAltitudeBandBreakpointChange}
          />

          <SunlightSection
            state={sunlightState}
            open={sectionsOpen.sunlight}
            onOpenChange={(open) => setSectionsOpen((prev) => ({ ...prev, sunlight: open }))}
            mapExpanded={sunlightMapExpanded}
            onMapExpandedChange={setSunlightMapExpanded}
            onEnabledChange={(enabled) => {
              setSunlightState((prev) => ({ ...prev, enabled }));
              if (enabled) setSectionsOpen((prev) => ({ ...prev, sunlight: true }));
            }}
            onChange={handleSunlightStateChange}
          />

        </div>
      </aside>

      <div className={`lidar-viewer-right-collapsed-rail${isCollapsed ? ' is-visible' : ''}`}>
        <button
          type="button"
          className="lidar-viewer-collapsed-rail-btn"
          aria-label="Rouvrir le panneau des couches d'analyse"
          onClick={handleRestore}
        >
          <SvgV2Icon name="arrow-left.svg" size={18} />
        </button>
      </div>
    </>
  );
}

export function LidarViewerRightPanel(props: LidarViewerRightPanelProps) {
  return (
    <AppI18nProvider>
      <LidarViewerRightPanelContent {...props} />
    </AppI18nProvider>
  );
}
