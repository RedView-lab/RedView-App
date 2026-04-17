import { BasemapsSection } from './sections/BasemapsSection';
import { LidarTilesSection } from './sections/LidarTilesSection';
import { LabelsSection } from './sections/LabelsSection';
import { RoutesSection } from './sections/RoutesSection';
import { SlopesSection } from './sections/SlopesSection';
import { WeatherSection } from './sections/WeatherSection';
import { SimpleToggleSection } from './sections/SimpleToggleSection';
import type { ControlPanelProps } from './types';
import './ControlPanel.css';

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
  onSlopeOpacityChange,
  onSlopeBandColorChange,
  onSlopeBandVisibilityToggle,
  onWeatherEnabledChange,
  onWeatherTabChange,
  onWeatherRangeChange,
  onWeatherLayerToggle,
  onWeatherLayerModeChange,
  onWeatherLayerOpacityChange,
  onWeatherAddAlert,
  onWindEnabledChange,
  onSnowEnabledChange,
  onSunlightEnabledChange,
}: ControlPanelProps) {
  return (
    <aside className={`rvc-panel${className ? ` ${className}` : ''}`}>
      <BasemapsSection
        basemaps={state.basemaps}
        onBasemapToggle={onBasemapToggle}
        onBasemapAdd={onBasemapAdd}
      />

      <LidarTilesSection
        tiles={state.lidarTiles}
        onTileToggle={onLidarTileToggle}
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
          opacity: state.slopes.opacity,
          bands: state.slopes.bands,
        }}
        onEnabledChange={onSlopesEnabledChange}
        onResolutionChange={onSlopeResolutionChange}
        onColorizationChange={onSlopeColorizationChange}
        onOpacityChange={onSlopeOpacityChange}
        onBandColorChange={onSlopeBandColorChange}
        onBandVisibilityToggle={onSlopeBandVisibilityToggle}
      />

      <WeatherSection
        state={state.weather}
        onEnabledChange={onWeatherEnabledChange}
        onTabChange={onWeatherTabChange}
        onRangeChange={onWeatherRangeChange}
        onLayerToggle={onWeatherLayerToggle}
        onLayerModeChange={onWeatherLayerModeChange}
        onLayerOpacityChange={onWeatherLayerOpacityChange}
        onAddAlert={onWeatherAddAlert}
      />

      <SimpleToggleSection
        title="Vent"
        enabled={state.wind.enabled}
        onEnabledChange={onWindEnabledChange}
      />
      <SimpleToggleSection
        title="Neige"
        enabled={state.snow.enabled}
        onEnabledChange={onSnowEnabledChange}
      />
      <SimpleToggleSection
        title="Ensoleillement"
        enabled={state.sunlight.enabled}
        onEnabledChange={onSunlightEnabledChange}
      />
    </aside>
  );
}
