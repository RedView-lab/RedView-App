import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppI18nProvider } from '@/shared/i18n';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { SlopesSection } from '@/features/controlPanel/sections/SlopesSection';
import { AltitudeSection } from '@/features/controlPanel/sections/AltitudeSection';
import { SunlightSection } from '@/features/controlPanel/sections/SunlightSection';
import { RouteSection } from './RouteSection';
import type { ViewerRouteController } from '../route/viewerRouteController';
import type { ViewerRouteState } from '../route/types';
import {
  clampBreakpoints,
  formatSlopeDegreeLabel,
  generateDynamicCategories,
} from '@/features/slope/lib/slope-config';
import {
  altitudeBandCountFromSetting,
  buildAltitudeCategories,
  clampAltitudeBreakpoints,
} from '@/features/altitude/lib/altitude-config';
import {
  buildDefaultSunlightBands,
  normalizeSunlightScaleSetting,
  resampleSunlightBands,
} from '@/features/controlPanel/lib/sunlightConfig';
import { resolveSunTimesForLocalDay } from '@/features/sunlight/lib/sun-calc';
import { getTimeZoneForCoordinates } from '@/features/lidar/lib/coordConvert';
import type { AltitudeScaleSettingKey } from '@/features/altitude/types';
import type { ViewerSlopeState, ViewerAltitudeState } from './types';
import type {
  AltitudeBand,
  AltitudeColorization,
  AltitudeScaleSetting,
  SlopeBand,
  SlopeColorization,
  SlopeResolution,
  SlopeScale,
  SlopeScaleSetting,
  SunlightState,
} from '@/features/controlPanel/types';
import '@/features/controlPanel/styles/index.css';
import '@/features/itineraryPanel/styles/overlays/_calendar-popover.css';
import './styles.css';

const PANEL_STORAGE_WIDTH_KEY = 'rv-viewer-right-panel-width-v2';
const PANEL_STORAGE_COLLAPSED_KEY = 'rv-viewer-right-panel-collapsed-v2';
const PANEL_WIDTH_DEFAULT = 380;
const PANEL_WIDTH_MIN = 350;
const PANEL_WIDTH_MAX = 600;
const PANEL_COLLAPSE_DRAG_THRESHOLD = 48;

function bandCountFromSlopeSetting(setting: SlopeScaleSetting): number {
  const match = /^(\d+)/.exec(setting);
  return match ? Number(match[1]) : 10;
}

function buildSlopeBands(
  categories: ReturnType<typeof generateDynamicCategories>,
  visibilityById: Record<string, boolean>,
): SlopeBand[] {
  return categories.map((category) => ({
    id: category.id,
    percentRange: category.displayRange,
    degreeRange: `${formatSlopeDegreeLabel(category.minDeg)}° - ${formatSlopeDegreeLabel(category.maxDeg)}° (${category.label})`,
    label: `${category.displayRange} (${category.label})`,
    color: category.color,
    visible: visibilityById[category.id] ?? true,
    minDeg: category.minDeg,
    maxDeg: category.maxDeg,
  }));
}

function buildAltitudeBands(
  categories: ReturnType<typeof buildAltitudeCategories>,
  hiddenIds: Set<string>,
): AltitudeBand[] {
  return categories.map((category) => ({
    id: category.id,
    label: category.displayRange,
    color: category.color,
    visible: !hiddenIds.has(category.id),
    minMeters: category.minMeters,
    maxMeters: category.maxMeters,
  }));
}

export interface LidarViewerRightPanelProps {
  onSlopeChange?: (state: ViewerSlopeState) => void;
  onAltitudeChange?: (state: ViewerAltitudeState) => void;
  onSunlightChange?: (state: SunlightState) => void;
  routeController?: ViewerRouteController;
  centerLon?: number;
  centerLat?: number;
  timeZone?: string;
}

export function LidarViewerRightPanelContent({
  onSlopeChange,
  onAltitudeChange,
  onSunlightChange,
  routeController,
  centerLon,
  centerLat,
  timeZone,
}: LidarViewerRightPanelProps) {
  const [routeState, setRouteState] = useState<ViewerRouteState | null>(() => routeController?.getState() ?? null);

  useEffect(() => {
    if (!routeController) return;
    return routeController.onStateChange(setRouteState);
  }, [routeController]);

  const [panelWidth, setPanelWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(PANEL_STORAGE_WIDTH_KEY);
      if (stored) {
        const parsed = parseFloat(stored);
        if (!Number.isNaN(parsed) && parsed >= PANEL_WIDTH_MIN && parsed <= PANEL_WIDTH_MAX) {
          return parsed;
        }
      }
    } catch {
      // ignore
    }
    return PANEL_WIDTH_DEFAULT;
  });

  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PANEL_STORAGE_COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const [isResizing, setIsResizing] = useState(false);
  const lastExpandedWidthRef = useRef<number>(panelWidth);

  useEffect(() => {
    if (!isCollapsed) {
      lastExpandedWidthRef.current = panelWidth;
    }
  }, [isCollapsed, panelWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(PANEL_STORAGE_WIDTH_KEY, String(panelWidth));
    } catch {
      // ignore
    }
  }, [panelWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(PANEL_STORAGE_COLLAPSED_KEY, String(isCollapsed));
    } catch {
      // ignore
    }
  }, [isCollapsed]);

  const handleResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsResizing(true);
      const startX = event.clientX;
      const startWidth = panelWidth;

      const onMove = (nextEvent: MouseEvent) => {
        const delta = startX - nextEvent.clientX;
        const raw = startWidth + delta;
        const maxAllowed = Math.min(PANEL_WIDTH_MAX, window.innerWidth - 32);
        const minAllowed = Math.min(PANEL_WIDTH_MIN, maxAllowed);

        if (raw <= minAllowed - PANEL_COLLAPSE_DRAG_THRESHOLD) {
          setIsCollapsed(true);
          return;
        }

        setIsCollapsed(false);
        const clamped = Math.max(minAllowed, Math.min(maxAllowed, raw));
        lastExpandedWidthRef.current = clamped;
        setPanelWidth(clamped);
      };

      const onUp = () => {
        setIsResizing(false);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [panelWidth],
  );

  const handleRestore = useCallback(() => {
    const nextWidth = Math.max(
      PANEL_WIDTH_MIN,
      Math.min(PANEL_WIDTH_MAX, lastExpandedWidthRef.current || PANEL_WIDTH_DEFAULT),
    );
    setPanelWidth(nextWidth);
    setIsCollapsed(false);
  }, []);

  const [sectionsOpen, setSectionsOpen] = useState<{
    route: boolean;
    slopes: boolean;
    altitude: boolean;
    sunlight: boolean;
  }>({
    route: true,
    slopes: false,
    altitude: false,
    sunlight: true,
  });

  // ── Slopes State ──────────────────────────────────────────────────────────
  const [slopesEnabled, setSlopesEnabled] = useState(false);
  const [slopeResolution, setSlopeResolution] = useState<SlopeResolution>('1m (LIDAR TERRAIN)');
  const [slopeColorization, setSlopeColorization] = useState<SlopeColorization>('gradient');
  const [slopeScale, setSlopeScale] = useState<SlopeScale>('degree');
  const [slopeScaleSetting, setSlopeScaleSetting] = useState<SlopeScaleSetting>('6 couleurs');
  const [slopeOpacity, setSlopeOpacity] = useState(20);
  const [slopeCustomColors, setSlopeCustomColors] = useState<Record<string, string>>({});
  const [slopeBandVisibility, setSlopeBandVisibility] = useState<Record<string, boolean>>({});
  const [slopeBreakpointsByCount, setSlopeBreakpointsByCount] = useState<Record<number, number[]>>({});

  const slopeBandCount = useMemo(() => bandCountFromSlopeSetting(slopeScaleSetting), [slopeScaleSetting]);
  const currentSlopeBreakpoints = useMemo(
    () => slopeBreakpointsByCount[slopeBandCount],
    [slopeBandCount, slopeBreakpointsByCount],
  );
  const dynamicSlopeCategories = useMemo(
    () => generateDynamicCategories(slopeBandCount, currentSlopeBreakpoints),
    [slopeBandCount, currentSlopeBreakpoints],
  );
  const coloredSlopeCategories = useMemo(
    () =>
      dynamicSlopeCategories.map((category) => ({
        ...category,
        color: slopeCustomColors[category.id] ?? category.color,
      })),
    [dynamicSlopeCategories, slopeCustomColors],
  );
  const slopeBands = useMemo(
    () => buildSlopeBands(coloredSlopeCategories, slopeBandVisibility),
    [coloredSlopeCategories, slopeBandVisibility],
  );

  useEffect(() => {
    onSlopeChange?.({
      enabled: slopesEnabled,
      opacity: slopeOpacity,
      colorization: slopeColorization,
      scale: slopeScale,
      scaleSetting: slopeScaleSetting,
      bands: slopeBands,
    });
  }, [
    onSlopeChange,
    slopesEnabled,
    slopeOpacity,
    slopeColorization,
    slopeScale,
    slopeScaleSetting,
    slopeBands,
  ]);

  const handleSlopeBandBreakpointChange = useCallback(
    (bandIndex: number, field: 'min' | 'max', valueDeg: number) => {
      const count = dynamicSlopeCategories.length;
      const breakpoints = dynamicSlopeCategories.slice(1).map((cat) => cat.minDeg);

      let breakpointIndex: number;
      if (field === 'min') {
        if (bandIndex === 0) return;
        breakpointIndex = bandIndex - 1;
      } else {
        if (bandIndex === count - 1) return;
        breakpointIndex = bandIndex;
      }

      if (breakpointIndex < 0 || breakpointIndex >= breakpoints.length) return;
      breakpoints[breakpointIndex] = valueDeg;
      const clamped = clampBreakpoints(breakpoints, count);
      setSlopeBreakpointsByCount((prev) => ({ ...prev, [count]: clamped }));
    },
    [dynamicSlopeCategories],
  );

  // ── Altitude State ────────────────────────────────────────────────────────
  const [altitudeEnabled, setAltitudeEnabled] = useState(false);
  const [altitudeColorization, setAltitudeColorization] = useState<AltitudeColorization>('gradient');
  const [altitudeScaleSetting, setAltitudeScaleSetting] = useState<AltitudeScaleSetting>('4 couleurs');
  const [altitudeOpacity, setAltitudeOpacity] = useState(20);
  const [altitudeCustomColors, setAltitudeCustomColors] = useState<Record<string, string>>({});
  const [altitudeHiddenBandIds, setAltitudeHiddenBandIds] = useState<string[]>([]);
  const [altitudeBreakpointsByCount, setAltitudeBreakpointsByCount] = useState<Record<number, number[]>>({});

  const altitudeBandCount = useMemo(
    () => altitudeBandCountFromSetting(altitudeScaleSetting),
    [altitudeScaleSetting],
  );
  const currentAltitudeBreakpoints = useMemo(
    () => altitudeBreakpointsByCount[altitudeBandCount],
    [altitudeBandCount, altitudeBreakpointsByCount],
  );
  const altitudeCategories = useMemo(
    () => buildAltitudeCategories(altitudeScaleSetting as AltitudeScaleSettingKey, altitudeCustomColors, currentAltitudeBreakpoints),
    [altitudeCustomColors, altitudeScaleSetting, currentAltitudeBreakpoints],
  );
  const altitudeHiddenIds = useMemo(() => new Set(altitudeHiddenBandIds), [altitudeHiddenBandIds]);
  const altitudeBands = useMemo(
    () => buildAltitudeBands(altitudeCategories, altitudeHiddenIds),
    [altitudeCategories, altitudeHiddenIds],
  );

  useEffect(() => {
    onAltitudeChange?.({
      enabled: altitudeEnabled,
      opacity: altitudeOpacity,
      colorization: altitudeColorization,
      scaleSetting: altitudeScaleSetting,
      bands: altitudeBands,
    });
  }, [
    onAltitudeChange,
    altitudeEnabled,
    altitudeOpacity,
    altitudeColorization,
    altitudeScaleSetting,
    altitudeBands,
  ]);

  const handleAltitudeBandBreakpointChange = useCallback(
    (bandIndex: number, field: 'min' | 'max', valueMeters: number) => {
      const count = altitudeCategories.length;
      const breakpoints = altitudeCategories.slice(1).map((cat) => cat.minMeters);

      let breakpointIndex: number;
      if (field === 'min') {
        if (bandIndex === 0) return;
        breakpointIndex = bandIndex - 1;
      } else {
        if (bandIndex === count - 1) return;
        breakpointIndex = bandIndex;
      }

      if (breakpointIndex < 0 || breakpointIndex >= breakpoints.length) return;
      breakpoints[breakpointIndex] = valueMeters;
      const clamped = clampAltitudeBreakpoints(breakpoints, count);
      setAltitudeBreakpointsByCount((prev) => ({ ...prev, [count]: clamped }));
    },
    [altitudeCategories],
  );

  // ── Sunlight State ────────────────────────────────────────────────────────
  const localTimeZone = useMemo(() => {
    if (timeZone) return timeZone;
    if (centerLon != null && centerLat != null) {
      return getTimeZoneForCoordinates(centerLon, centerLat);
    }
    return 'Europe/Paris';
  }, [timeZone, centerLon, centerLat]);

  const [sunlightState, setSunlightState] = useState<SunlightState>(() => {
    const today = new Date().toISOString().slice(0, 10);
    const initialTz =
      timeZone ?? (centerLon != null && centerLat != null ? getTimeZoneForCoordinates(centerLon, centerLat) : 'Europe/Paris');
    const times =
      centerLat != null && centerLon != null
        ? resolveSunTimesForLocalDay(today, centerLat, centerLon, initialTz)
        : { sunriseTime: '06:45', sunsetTime: '20:30' };
    return {
      enabled: false,
      customDateEnabled: true,
      date: today,
      time: '12:00',
      timeScrubbing: false,
      sunriseTime: times.sunriseTime,
      sunsetTime: times.sunsetTime,
      shadowEnabled: true,
      sunlightMapEnabled: true,
      shadowOpacity: 50,
      sunlightMapOpacity: 50,
      scaleSetting: '4 couleurs',
      bands: buildDefaultSunlightBands('4 couleurs'),
      trajectoryEnabled: true,
    };
  });
  const [sunlightMapExpanded, setSunlightMapExpanded] = useState(true);

  useEffect(() => {
    if (centerLat == null || centerLon == null) return;
    const times = resolveSunTimesForLocalDay(sunlightState.date, centerLat, centerLon, localTimeZone);
    if (times.sunriseTime !== sunlightState.sunriseTime || times.sunsetTime !== sunlightState.sunsetTime) {
      setSunlightState((prev) => ({
        ...prev,
        sunriseTime: times.sunriseTime,
        sunsetTime: times.sunsetTime,
      }));
    }
  }, [sunlightState.date, centerLat, centerLon, localTimeZone, sunlightState.sunriseTime, sunlightState.sunsetTime]);

  useEffect(() => {
    onSunlightChange?.(sunlightState);
  }, [onSunlightChange, sunlightState]);

  const handleSunlightStateChange = useCallback((changes: Partial<SunlightState>) => {
    setSunlightState((prev) => {
      let nextBands = prev.bands;
      let nextScaleSetting = prev.scaleSetting;

      if (changes.scaleSetting && changes.scaleSetting !== prev.scaleSetting) {
        nextScaleSetting = normalizeSunlightScaleSetting(changes.scaleSetting);
        nextBands = resampleSunlightBands(prev.bands, nextScaleSetting);
      } else if (changes.bands) {
        nextBands = changes.bands;
      }

      let sunriseTime = prev.sunriseTime;
      let sunsetTime = prev.sunsetTime;
      if (changes.date && changes.date !== prev.date && centerLat != null && centerLon != null) {
        const times = resolveSunTimesForLocalDay(changes.date, centerLat, centerLon, localTimeZone);
        sunriseTime = times.sunriseTime;
        sunsetTime = times.sunsetTime;
      }

      return {
        ...prev,
        ...changes,
        sunriseTime,
        sunsetTime,
        scaleSetting: nextScaleSetting,
        bands: nextBands,
      };
    });
  }, [centerLat, centerLon]);


  return (
    <>
      <aside
        className={`rvc-panel lidar-viewer-right-panel${isResizing ? ' is-resizing' : ''}${isCollapsed ? ' is-collapsed' : ''}`}
        style={{ width: `min(${panelWidth}px, calc(100vw - 32px))` }}
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
            />
          )}

          <SlopesSection
            enabled={slopesEnabled}
            zoneActive={true}
            noTopBorder={!routeState}
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
            zoneActive={true}
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
