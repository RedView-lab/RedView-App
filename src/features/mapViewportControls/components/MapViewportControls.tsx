import { useEffect, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { ROUTE_SLOPE_LEGEND_BANDS } from '@/features/controlPanel/lib';
import { useAppI18n } from '@/shared/i18n';
import { DEFAULT_VIEW } from '@/features/map3d/lib/mapbox.config';
import {
  IconCompass,
  IconInfo,
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
  routeSlopeLegendTitle?: string | null;
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
  routeSlopeLegendTitle = null,
}: MapViewportControlsProps) {
  const { t } = useAppI18n();
  const [bearing, setBearing] = useState(0);
  const [is3DView, setIs3DView] = useState(DEFAULT_VIEW.pitch > THREE_D_PITCH_THRESHOLD);
  const [isRouteSlopeLegendOpen, setIsRouteSlopeLegendOpen] = useState(Boolean(routeSlopeLegendTitle));

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

  useEffect(() => {
    setIsRouteSlopeLegendOpen(Boolean(routeSlopeLegendTitle));
  }, [routeSlopeLegendTitle]);

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
    <aside className="rvmvc-map-tools" aria-label={t('Contrôles de la vue carte')} data-node-id="1765:66284">
      <button
        type="button"
        className={`rvmvc-map-tools__button${immersiveMode ? ' is-active' : ''}`}
        aria-label={t('Activer ou quitter le mode plein écran')}
        aria-pressed={immersiveMode}
        title={t('Plein écran')}
        onClick={onToggleImmersiveMode}
      >
        <IconMaximize size={18} />
      </button>

      <button
        type="button"
        className="rvmvc-map-tools__button"
        aria-label={t('Recentrer la boussole vers le nord')}
        title={t('Nord')}
        onClick={handleResetNorth}
        disabled={disabled}
      >
        <IconCompass size={20} rotation={-bearing} />
      </button>

      <button
        type="button"
        className="rvmvc-map-tools__button rvmvc-map-tools__button--compact"
        aria-label={t('Zoomer')}
        title={t('Zoomer')}
        onClick={handleZoomIn}
        disabled={disabled}
      >
        <IconZoomIn size={16} />
      </button>

      <button
        type="button"
        className="rvmvc-map-tools__button rvmvc-map-tools__button--compact"
        aria-label={t('Dézoomer')}
        title={t('Dézoomer')}
        onClick={handleZoomOut}
        disabled={disabled}
      >
        <IconZoomOut size={16} />
      </button>

      <div className="rvmvc-map-tools__dimension-row">
        {routeSlopeLegendTitle && isRouteSlopeLegendOpen ? (
          <section className="rvmvc-route-slope-legend" aria-label={t('Légende de pente du tracé')}>
            <div className="rvmvc-route-slope-legend__title">{routeSlopeLegendTitle}</div>
            <div className="rvmvc-route-slope-legend__list">
              {ROUTE_SLOPE_LEGEND_BANDS.map((band) => (
                <div key={band.id} className="rvmvc-route-slope-legend__item">
                  <span
                    className="rvmvc-route-slope-legend__swatch"
                    style={{ backgroundColor: band.color }}
                    aria-hidden="true"
                  />
                  <span className="rvmvc-route-slope-legend__label">{band.label}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <div className="rvmvc-map-tools__button-stack">
          <button
            type="button"
            className={`rvmvc-map-tools__button rvmvc-map-tools__button--label${is3DView ? ' is-active' : ''}`}
            aria-label={is3DView ? t('Passer en vue 2D') : t('Passer en vue 3D')}
            aria-pressed={is3DView}
            title={is3DView ? t('Passer en 2D') : t('Passer en 3D')}
            onClick={handleToggleDimension}
            disabled={disabled}
          >
            <span>3D</span>
          </button>

          {routeSlopeLegendTitle ? (
            <button
              type="button"
              className={`rvmvc-map-tools__button${isRouteSlopeLegendOpen ? ' is-active' : ''}`}
              aria-label={isRouteSlopeLegendOpen ? t('Masquer la légende de pente du tracé') : t('Afficher la légende de pente du tracé')}
              aria-pressed={isRouteSlopeLegendOpen}
              title={t('Légende')}
              onClick={() => {
                setIsRouteSlopeLegendOpen((value) => !value);
              }}
            >
              <IconInfo size={16} />
            </button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}