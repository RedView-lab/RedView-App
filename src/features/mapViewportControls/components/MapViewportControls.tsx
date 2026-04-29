import { useEffect, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { DEFAULT_VIEW } from '@/features/map3d/lib/mapbox.config';
import { IconArrowLeft } from '@/features/itineraryPanel/components/icons';
import {
  IconCompass,
  IconMaximize,
  IconZoomIn,
  IconZoomOut,
} from './MapViewportControlIcons';
import '../styles/index.css';

interface MapViewportControlsProps {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  immersiveMode: boolean;
  onToggleImmersiveMode: () => void;
  showRightPanelRestore?: boolean;
  onRestoreRightPanel?: () => void;
}

const CAMERA_DURATION_MS = 650;
const ZOOM_DURATION_MS = 220;
const THREE_D_PITCH_THRESHOLD = 8;

function clampZoom(map: MapboxMap, delta: number) {
  const target = map.getZoom() + delta;
  return Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), target));
}

export function MapViewportControls({
  map,
  isMapLoaded,
  immersiveMode,
  onToggleImmersiveMode,
  showRightPanelRestore = false,
  onRestoreRightPanel,
}: MapViewportControlsProps) {
  const [bearing, setBearing] = useState(0);
  const [is3DView, setIs3DView] = useState(DEFAULT_VIEW.pitch > THREE_D_PITCH_THRESHOLD);

  useEffect(() => {
    if (!map) {
      setBearing(0);
      setIs3DView(DEFAULT_VIEW.pitch > THREE_D_PITCH_THRESHOLD);
      return;
    }

    const syncCameraState = () => {
      setBearing(map.getBearing());
      setIs3DView(map.getPitch() > THREE_D_PITCH_THRESHOLD);
    };

    syncCameraState();
    map.on('move', syncCameraState);
    map.on('moveend', syncCameraState);

    return () => {
      map.off('move', syncCameraState);
      map.off('moveend', syncCameraState);
    };
  }, [map]);

  const disabled = !isMapLoaded || map == null;

  const handleZoomIn = () => {
    if (!map) return;
    map.easeTo({
      zoom: clampZoom(map, 1),
      duration: ZOOM_DURATION_MS,
      essential: true,
    });
  };

  const handleZoomOut = () => {
    if (!map) return;
    map.easeTo({
      zoom: clampZoom(map, -1),
      duration: ZOOM_DURATION_MS,
      essential: true,
    });
  };

  const handleResetNorth = () => {
    if (!map) return;
    map.easeTo({
      bearing: 0,
      duration: CAMERA_DURATION_MS,
      essential: true,
    });
  };

  const handleToggleDimension = () => {
    if (!map) return;

    if (map.getPitch() > THREE_D_PITCH_THRESHOLD) {
      map.easeTo({
        pitch: 0,
        bearing: 0,
        duration: CAMERA_DURATION_MS,
        essential: true,
      });
      return;
    }

    map.easeTo({
      pitch: DEFAULT_VIEW.pitch,
      bearing: DEFAULT_VIEW.bearing,
      duration: CAMERA_DURATION_MS,
      essential: true,
    });
  };

  return (
    <aside className="rvmvc-map-tools" aria-label="Contrôles de la vue carte" data-node-id="1765:66284">
      <button
        type="button"
        className={`rvmvc-map-tools__button${immersiveMode ? ' is-active' : ''}`}
        aria-label="Activer ou quitter le mode plein écran"
        aria-pressed={immersiveMode}
        title="Plein écran"
        onClick={onToggleImmersiveMode}
      >
        <IconMaximize size={18} />
      </button>

      <button
        type="button"
        className="rvmvc-map-tools__button"
        aria-label="Recentrer la boussole vers le nord"
        title="Nord"
        onClick={handleResetNorth}
        disabled={disabled}
      >
        <IconCompass size={20} rotation={-bearing} />
      </button>

      <button
        type="button"
        className="rvmvc-map-tools__button rvmvc-map-tools__button--compact"
        aria-label="Zoomer"
        title="Zoomer"
        onClick={handleZoomIn}
        disabled={disabled}
      >
        <IconZoomIn size={16} />
      </button>

      <button
        type="button"
        className="rvmvc-map-tools__button rvmvc-map-tools__button--compact"
        aria-label="Dézoomer"
        title="Dézoomer"
        onClick={handleZoomOut}
        disabled={disabled}
      >
        <IconZoomOut size={16} />
      </button>

      <button
        type="button"
        className={`rvmvc-map-tools__button rvmvc-map-tools__text-button${is3DView ? ' is-active' : ''}`}
        aria-label={is3DView ? 'Passer en vue 2D' : 'Passer en vue 3D'}
        aria-pressed={is3DView}
        title={is3DView ? 'Passer en 2D' : 'Passer en 3D'}
        onClick={handleToggleDimension}
        disabled={disabled}
      >
        <span>3D</span>
      </button>

      <div
        className={`rvmvc-map-tools__collapsed-rail${showRightPanelRestore ? ' is-visible' : ''}`}
        aria-hidden={!showRightPanelRestore}
      >
        <button
          type="button"
          className="rvmvc-map-tools__collapsed-rail-button"
          aria-label="Rouvrir le panneau de droite"
          title="Rouvrir le panneau"
          onClick={onRestoreRightPanel}
          tabIndex={showRightPanelRestore ? 0 : -1}
        >
          <IconArrowLeft size={18} />
        </button>
      </div>
    </aside>
  );
}