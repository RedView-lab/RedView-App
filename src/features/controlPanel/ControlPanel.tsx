import type { CSSProperties } from 'react';
import { useMiddleClickAutoscroll } from '../../lib/useMiddleClickAutoscroll';
import { BasemapsSection } from './sections/BasemapsSection';
import { LidarTilesSection } from './sections/LidarTilesSection';
import { LabelsSection } from './sections/LabelsSection';
import { RoutesSection } from './sections/RoutesSection';
import { SlopesSection } from './sections/SlopesSection';
import { AltitudeSection } from './sections/AltitudeSection';
import { WeatherSection } from './sections/WeatherSection';
import { WindSection } from './sections/WindSection';
import { SunlightSection } from './sections/SunlightSection';
import type { ControlPanelProps } from './types';
import './styles/index.css';

/**
 * Unified left-dock control panel for RedView (Figma frame 1407:17211).
 *
 * Width 300px, dark glassmorphic background. All sections are auto-layout,
 * collapsible, and plug into the existing backend features through handlers.
 */
export function ControlPanel({
  state,
  lidarDownloadProgress,
  lidarDownloadError,
  lidarDownloadModeActive,
  className,
  sectionsOpen,
  onSectionOpenChange,
  onBasemapToggle,
  onBasemapAdd,
  onLidarTileToggle,
  onLidarTileDelete,
  onLidarTileDownload,
  onLidarTileOpen,
  onLabelsEnabledChange,
  onLabelToggle,
  onRoutesEnabledChange,
  onRouteColorChange,
  onRouteModeChange,
  onRouteOpacityChange,
  onRouteVisibilityToggle,
  onSlopesEnabledChange,
  onSlopeResolutionChange,
  onSlopeColorizationChange,
  onSlopeScaleChange,
  onSlopeScaleSettingChange,
  onSlopeOpacityChange,
  onSlopeBandColorChange,
  onSlopeBandVisibilityToggle,
  onSlopeBandBreakpointChange,
  onWeatherEnabledChange,
  onWeatherTabChange,
  onWeatherDateChange,
  onWeatherLayerToggle,
  onWeatherLayerModeChange,
  onWeatherAddAlert,
  onWindEnabledChange,
  onAltitudeEnabledChange,
  onAltitudeResolutionChange,
  onAltitudeColorizationChange,
  onAltitudeScaleSettingChange,
  onAltitudeOpacityChange,
  onAltitudeBandColorChange,
  onAltitudeBandVisibilityToggle,
  onAltitudeBandBreakpointChange,
  onSunlightEnabledChange,
  onSunlightStateChange,
  sunlightMapExpanded,
  onSunlightMapExpandedChange,
  width,
  onResizeStart,
  isResizing,
}: ControlPanelProps) {
  const { scrollRef, isAutoscrolling } = useMiddleClickAutoscroll<HTMLDivElement>();
  const panelClass = `rvc-panel${className ? ` ${className}` : ''}${
    isResizing ? ' is-resizing' : ''
  }`;
  const style: CSSProperties | undefined = width ? { width } : undefined;
  return (
    <aside className={panelClass} style={style}>
      {onResizeStart && (
        <div
          className={`rvc-panel__resize-handle${isResizing ? ' is-dragging' : ''}`}
          onMouseDown={onResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionner le panneau"
        />
      )}
      <div
        ref={scrollRef}
        className={`rvc-panel__content${isAutoscrolling ? ' is-middle-autoscrolling' : ''}`}
      >
      <BasemapsSection
        basemaps={state.basemaps}
        open={sectionsOpen?.basemaps}
        onOpenChange={(open) => onSectionOpenChange?.('basemaps', open)}
        onBasemapToggle={onBasemapToggle}
        onBasemapAdd={onBasemapAdd}
      />

      <LidarTilesSection
        tiles={state.lidarTiles}
        progress={lidarDownloadProgress}
        error={lidarDownloadError}
        downloadModeActive={lidarDownloadModeActive}
        open={sectionsOpen?.lidarTiles}
        onOpenChange={(open) => onSectionOpenChange?.('lidarTiles', open)}
        onTileToggle={onLidarTileToggle}
        onTileOpen={onLidarTileOpen}
        onTileDelete={onLidarTileDelete}
        onDownload={onLidarTileDownload}
      />

      <LabelsSection
        enabled={state.labels.enabled}
        state={state.labels.state}
        open={sectionsOpen?.labels}
        onOpenChange={(open) => onSectionOpenChange?.('labels', open)}
        onEnabledChange={onLabelsEnabledChange}
        onLabelToggle={onLabelToggle}
      />

      <RoutesSection
        enabled={state.routes.enabled}
        items={state.routes.items}
        open={sectionsOpen?.routes}
        onOpenChange={(open) => onSectionOpenChange?.('routes', open)}
        onEnabledChange={onRoutesEnabledChange}
        onColorChange={onRouteColorChange}
        onModeChange={onRouteModeChange}
        onOpacityChange={onRouteOpacityChange}
        onVisibilityToggle={onRouteVisibilityToggle}
      />

      <SlopesSection
        enabled={state.slopes.enabled}
        open={sectionsOpen?.slopes}
        onOpenChange={(open) => onSectionOpenChange?.('slopes', open)}
        state={{
          resolution: state.slopes.resolution,
          colorization: state.slopes.colorization,
          scale: state.slopes.scale,
          scaleSetting: state.slopes.scaleSetting,
          opacity: state.slopes.opacity,
          bands: state.slopes.bands,
        }}
        onEnabledChange={onSlopesEnabledChange}
        onResolutionChange={onSlopeResolutionChange}
        onColorizationChange={onSlopeColorizationChange}
        onScaleChange={onSlopeScaleChange}
        onScaleSettingChange={onSlopeScaleSettingChange}
        onOpacityChange={onSlopeOpacityChange}
        onBandColorChange={onSlopeBandColorChange}
        onBandVisibilityToggle={onSlopeBandVisibilityToggle}
        onBandBreakpointChange={onSlopeBandBreakpointChange}
      />

      <AltitudeSection
        enabled={state.altitude.enabled}
        open={sectionsOpen?.altitude}
        state={{
          resolution: state.altitude.resolution,
          colorization: state.altitude.colorization,
          scaleSetting: state.altitude.scaleSetting,
          opacity: state.altitude.opacity,
          bands: state.altitude.bands,
        }}
        onEnabledChange={onAltitudeEnabledChange}
        onOpenChange={(open) => onSectionOpenChange?.('altitude', open)}
        onResolutionChange={onAltitudeResolutionChange}
        onColorizationChange={onAltitudeColorizationChange}
        onScaleSettingChange={onAltitudeScaleSettingChange}
        onOpacityChange={onAltitudeOpacityChange}
        onBandColorChange={onAltitudeBandColorChange}
        onBandVisibilityToggle={onAltitudeBandVisibilityToggle}
        onBandBreakpointChange={onAltitudeBandBreakpointChange}
      />

      <WeatherSection
        state={state.weather}
        open={sectionsOpen?.weather}
        onOpenChange={(open) => onSectionOpenChange?.('weather', open)}
        onEnabledChange={onWeatherEnabledChange}
        onTabChange={onWeatherTabChange}
        onDateChange={onWeatherDateChange}
        onLayerToggle={onWeatherLayerToggle}
        onLayerModeChange={onWeatherLayerModeChange}
        onAddAlert={onWeatherAddAlert}
      />

      <WindSection
        enabled={state.wind.enabled}
        open={sectionsOpen?.wind}
        onOpenChange={(open) => onSectionOpenChange?.('wind', open)}
        onEnabledChange={onWindEnabledChange}
      />
      <SunlightSection
        state={state.sunlight}
        open={sectionsOpen?.sunlight}
        onOpenChange={(open) => onSectionOpenChange?.('sunlight', open)}
        mapExpanded={sunlightMapExpanded ?? true}
        onMapExpandedChange={onSunlightMapExpandedChange}
        onEnabledChange={onSunlightEnabledChange}
        onChange={onSunlightStateChange}
      />
      </div>
    </aside>
  );
}
