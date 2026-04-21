import type { CSSProperties } from 'react';
import { BasemapsSection } from './sections/BasemapsSection';
import { LidarTilesSection } from './sections/LidarTilesSection';
import { LabelsSection } from './sections/LabelsSection';
import { RoutesSection } from './sections/RoutesSection';
import { SlopesSection } from './sections/SlopesSection';
import { AltitudeSection } from './sections/AltitudeSection';
import { WeatherSection } from './sections/WeatherSection';
import { WindSection } from './sections/WindSection';
import { SimpleToggleSection } from './sections/SimpleToggleSection';
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
  className,
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
  onSnowEnabledChange,
  onSunlightEnabledChange,
  onSunlightStateChange,
  width,
  onResizeStart,
  isResizing,
}: ControlPanelProps) {
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
      <div className="rvc-panel__content">
      <BasemapsSection
        basemaps={state.basemaps}
        onBasemapToggle={onBasemapToggle}
        onBasemapAdd={onBasemapAdd}
      />

      <LidarTilesSection
        tiles={state.lidarTiles}
        onTileToggle={onLidarTileToggle}
        onTileOpen={onLidarTileOpen}
        onTileDelete={onLidarTileDelete}
        onDownload={onLidarTileDownload}
      />

      <LabelsSection
        enabled={state.labels.enabled}
        state={state.labels.state}
        onEnabledChange={onLabelsEnabledChange}
        onLabelToggle={onLabelToggle}
      />

      <RoutesSection
        enabled={state.routes.enabled}
        items={state.routes.items}
        onEnabledChange={onRoutesEnabledChange}
        onColorChange={onRouteColorChange}
        onModeChange={onRouteModeChange}
        onOpacityChange={onRouteOpacityChange}
        onVisibilityToggle={onRouteVisibilityToggle}
      />

      <SlopesSection
        enabled={state.slopes.enabled}
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

      <AltitudeSection />

      <WeatherSection
        state={state.weather}
        onEnabledChange={onWeatherEnabledChange}
        onTabChange={onWeatherTabChange}
        onDateChange={onWeatherDateChange}
        onLayerToggle={onWeatherLayerToggle}
        onLayerModeChange={onWeatherLayerModeChange}
        onAddAlert={onWeatherAddAlert}
      />

      <WindSection
        enabled={state.wind.enabled}
        onEnabledChange={onWindEnabledChange}
      />
      <SimpleToggleSection
        title="Neige"
        enabled={state.snow.enabled}
        onEnabledChange={onSnowEnabledChange}
      />
      <SunlightSection
        state={state.sunlight}
        onEnabledChange={onSunlightEnabledChange}
        onChange={onSunlightStateChange}
      />
      </div>
    </aside>
  );
}
