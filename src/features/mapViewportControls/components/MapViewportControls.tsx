import { memo, useEffect, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { ROUTE_SLOPE_LEGEND_BANDS } from '@/features/controlPanel/lib';
import { useProjectStoreOptional } from '@/features/itineraryPanel';
import type { Itinerary } from '@/features/itineraryPanel';
import { useAppI18n } from '@/shared/i18n';
import { DEFAULT_VIEW } from '@/features/map3d/lib/mapbox.config';
import { isThreeDPitch } from '@/features/map3d/lib/viewDimension';
import {
  IconCompass,
  IconInfo,
  IconMaximize,
  IconPanelLayers,
  IconZoomIn,
  IconZoomOut,
} from './MapViewportControlIcons';
import '../styles/index.css';

interface MapViewportControlsProps {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  immersiveMode: boolean;
  onToggleImmersiveMode: () => void;
  /**
   * Visibility of the right settings panel (only panel this control drives).
   * The dedicated toggle button is rendered only when `onToggleRightPanel` is
   * provided.
   */
  isRightPanelVisible?: boolean;
  onToggleRightPanel?: () => void;
  routeColor?: string | null;
  /** Short canvas: 2-column grid of 32 px buttons (pages/Dashboard/lib/layout.ts reserves its size). */
  compact?: boolean;
}

type SurfaceType = 'asphalt' | 'paved' | 'gravel' | 'dirt' | 'sand';

interface SurfaceLegendItem {
  id: SurfaceType;
  label: string;
}

const SURFACE_LEGEND_ITEMS: readonly SurfaceLegendItem[] = [
  { id: 'asphalt', label: 'Bitume / Asphalte' },
  { id: 'paved', label: 'Pavé / Béton' },
  { id: 'gravel', label: 'Gravier / Piste' },
  { id: 'dirt', label: 'Terre / Sentier' },
  { id: 'sand', label: 'Sable / Meuble' },
];

function SurfacePatternPreview({ type, color = '#ff3b30' }: { type: SurfaceType; color?: string }) {
  return (
    <svg
      width="60"
      height="16"
      viewBox="0 0 60 16"
      className="rvmvc-route-legend-popover__sample"
      aria-hidden="true"
    >
      {/* Casing halo for high contrast */}
      <line
        x1="5"
        y1="8"
        x2="55"
        y2="8"
        stroke="#ffffff"
        strokeWidth="6"
        strokeLinecap="round"
        strokeOpacity="0.9"
      />
      {/* Route main colored line */}
      <line
        x1="5"
        y1="8"
        x2="55"
        y2="8"
        stroke={color}
        strokeWidth="4"
        strokeLinecap="round"
      />
      {/* Overlay patterns matching Mapbox layer styles */}
      {type === 'paved' && (
        <line
          x1="5"
          y1="8"
          x2="55"
          y2="8"
          stroke="#1b1b1b"
          strokeWidth="2.4"
          strokeDasharray="14 5"
          strokeLinecap="butt"
        />
      )}
      {type === 'gravel' && (
        <line
          x1="5"
          y1="8"
          x2="55"
          y2="8"
          stroke="#1b1b1b"
          strokeWidth="2.4"
          strokeDasharray="6 4.5"
          strokeLinecap="butt"
        />
      )}
      {type === 'dirt' && (
        <line
          x1="5"
          y1="8"
          x2="55"
          y2="8"
          stroke="#1b1b1b"
          strokeWidth="2.4"
          strokeDasharray="2.5 3.5"
          strokeLinecap="butt"
        />
      )}
      {type === 'sand' && (
        <line
          x1="5"
          y1="8"
          x2="55"
          y2="8"
          stroke="#1b1b1b"
          strokeWidth="2.6"
          strokeDasharray="0.1 5.5"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

const CAMERA_DURATION_MS = 650;
const ZOOM_DURATION_MS = 220;

function clampZoom(map: MapboxMap, delta: number) {
  const target = map.getZoom() + delta;
  return Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), target));
}

// memo: the dashboard shell re-renders on every panel-resize frame.
export const MapViewportControls = memo(function MapViewportControls({
  map,
  isMapLoaded,
  immersiveMode,
  onToggleImmersiveMode,
  isRightPanelVisible = true,
  onToggleRightPanel,
  routeColor = null,
  compact = false,
}: MapViewportControlsProps) {
  const { t } = useAppI18n();
  const [bearing, setBearing] = useState(0);
  const [is3DView, setIs3DView] = useState(isThreeDPitch(DEFAULT_VIEW.pitch));
  const [isLegendOpen, setIsLegendOpen] = useState(false);
  const [activeLegendTab, setActiveLegendTab] = useState<'surfaces' | 'slopes'>('surfaces');

  const projectStore = useProjectStoreOptional();
  const activeItinerary = projectStore?.project.itineraries.find(
    (itinerary) => itinerary.id === projectStore.project.activeItineraryId && itinerary.visible !== false,
  ) ?? projectStore?.project.itineraries.find((itinerary) => itinerary.visible !== false) ?? null;

  const traceColor = routeColor ?? activeItinerary?.color ?? '#ff3b30';

  const legendPopoverRef = useRef<HTMLDivElement | null>(null);
  const compassNeedleRef = useRef<HTMLSpanElement | null>(null);

  // Itinéraire tracé en pente sur la carte : l'actif quand le chip « Pente »
  // du graphe central est coché, sinon un itinéraire en mode de rendu pente.
  const project = projectStore?.project ?? null;
  const isSlopeDrawn = (itinerary: Itinerary) =>
    itinerary.visible !== false
    && (itinerary.renderMode === 'slope'
      || (Boolean(project?.analysis?.filters?.slopeColors) && itinerary.id === project?.activeItineraryId));
  const slopeItinerary = project
    ? project.itineraries.find((itinerary) => itinerary.id === project.activeItineraryId && isSlopeDrawn(itinerary))
      ?? project.itineraries.find(isSlopeDrawn)
      ?? null
    : null;
  const hasRouteSlope = slopeItinerary != null;
  const slopeLegendPanelTitle = slopeItinerary
    ? `${slopeItinerary.name} (${t('Pente').toLocaleLowerCase()})`
    : t('Légende de pente du tracé');

  // Le passage en pente ouvre la légende des pentes ; elle se referme avec lui
  // si c'est lui qui l'avait ouverte (état ajusté au rendu, pas dans un effet).
  const [prevHasRouteSlope, setPrevHasRouteSlope] = useState(false);
  const [legendOpenedBySlope, setLegendOpenedBySlope] = useState(false);
  if (prevHasRouteSlope !== hasRouteSlope) {
    setPrevHasRouteSlope(hasRouteSlope);
    if (hasRouteSlope) {
      setActiveLegendTab('slopes');
      if (!isLegendOpen) {
        setIsLegendOpen(true);
        setLegendOpenedBySlope(true);
      }
    } else if (legendOpenedBySlope) {
      setLegendOpenedBySlope(false);
      setIsLegendOpen(false);
    }
  }

  // Montée la plus raide en haut, descente la plus raide en bas.
  const slopeLegendList = (
    <div className="rvmvc-route-legend-popover__list rvmvc-route-legend-popover__list--slope">
      {[...ROUTE_SLOPE_LEGEND_BANDS].reverse().map((band) => (
        <div key={band.id} className="rvmvc-route-legend-popover__slope-item">
          <span
            className="rvmvc-route-legend-popover__slope-swatch"
            style={{ backgroundColor: band.color }}
            aria-hidden="true"
          />
          <span className="rvmvc-route-legend-popover__slope-label">{band.label}</span>
        </div>
      ))}
    </div>
  );

  // Sans carte : boussole et bouton 2D/3D reviennent à la vue par défaut.
  const defaultIs3DView = isThreeDPitch(DEFAULT_VIEW.pitch);
  if (!map && (bearing !== 0 || is3DView !== defaultIs3DView)) {
    setBearing(0);
    setIs3DView(defaultIs3DView);
  }

  useEffect(() => {
    if (!map) return;

    const updateCompassDirect = () => {
      const b = map.getBearing();
      if (compassNeedleRef.current) {
        compassNeedleRef.current.style.transform = `rotate(${-b}deg)`;
      }
      const next3D = isThreeDPitch(map.getPitch());
      setIs3DView((prev) => (prev !== next3D ? next3D : prev));
    };

    const syncCameraState = () => {
      const b = map.getBearing();
      setBearing(b);
      const next3D = isThreeDPitch(map.getPitch());
      setIs3DView((prev) => (prev !== next3D ? next3D : prev));
      if (compassNeedleRef.current) {
        compassNeedleRef.current.style.transform = `rotate(${-b}deg)`;
      }
    };

    syncCameraState();
    map.on('move', updateCompassDirect);
    map.on('moveend', syncCameraState);

    return () => {
      map.off('move', updateCompassDirect);
      map.off('moveend', syncCameraState);
    };
  }, [map]);

  const disabled = !isMapLoaded || map == null;

  // Drives the right settings panel ONLY — never the left drawer.
  const showRightPanelToggle = onToggleRightPanel != null;
  const rightPanelToggleLabel = isRightPanelVisible
    ? t('Masquer le panneau droit')
    : t('Afficher le panneau droit');

  // Close the legend popover when clicking anywhere outside of it.
  useEffect(() => {
    if (!isLegendOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (legendPopoverRef.current?.contains(event.target as Node)) return;
      setIsLegendOpen(false);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isLegendOpen]);

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

    if (isThreeDPitch(map.getPitch())) {
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

  // 32 px buttons of the compact grid: icons shrink with them (40 → 32 px).
  const iconSize = (regular: number) => (compact ? Math.round(regular * 0.8) : regular);

  return (
    <aside
      className={`rvmvc-map-tools${compact ? ' rvmvc-map-tools--compact' : ''}`}
      aria-label={t('Contrôles de la vue carte')} data-node-id="1765:66284">
      <button
        type="button"
        className={`rvmvc-map-tools__button rvmvc-map-tools__slot-fullscreen${immersiveMode ? ' is-active' : ' is-inactive'}`}
        aria-label={t('Activer ou quitter le mode plein écran')}
        aria-pressed={immersiveMode}
        title={t('Plein écran')}
        onClick={onToggleImmersiveMode}
      >
        <IconMaximize size={iconSize(18)} />
      </button>

      {showRightPanelToggle ? (
        <button
          type="button"
          className={`rvmvc-map-tools__button rvmvc-map-tools__button--panel${
            isRightPanelVisible ? ' is-panel-shown' : ' is-panel-hidden'
          }`}
          aria-label={rightPanelToggleLabel}
          aria-pressed={isRightPanelVisible}
          title={rightPanelToggleLabel}
          onClick={onToggleRightPanel}
        >
          <IconPanelLayers size={iconSize(18)} />
        </button>
      ) : null}

      <button
        type="button"
        className="rvmvc-map-tools__button rvmvc-map-tools__slot-compass"
        aria-label={t('Recentrer la boussole vers le nord')}
        title={t('Nord')}
        onClick={handleResetNorth}
        disabled={disabled}
      >
        <span
          ref={compassNeedleRef}
          style={{ display: 'inline-flex', transform: `rotate(${-bearing}deg)`, transformOrigin: 'center', transition: 'none' }}
        >
          <IconCompass size={iconSize(20)} />
        </span>
      </button>

      <button
        type="button"
        className="rvmvc-map-tools__button rvmvc-map-tools__button--compact rvmvc-map-tools__slot-zoom-in"
        aria-label={t('Zoomer')}
        title={t('Zoomer')}
        onClick={handleZoomIn}
        disabled={disabled}
      >
        <IconZoomIn size={iconSize(16)} />
      </button>

      <button
        type="button"
        className="rvmvc-map-tools__button rvmvc-map-tools__button--compact rvmvc-map-tools__slot-zoom-out"
        aria-label={t('Dézoomer')}
        title={t('Dézoomer')}
        onClick={handleZoomOut}
        disabled={disabled}
      >
        <IconZoomOut size={iconSize(16)} />
      </button>

      <button
        type="button"
        className={`rvmvc-map-tools__button rvmvc-map-tools__button--label rvmvc-map-tools__slot-dimension${is3DView ? ' is-active' : ' is-inactive'}`}
        aria-label={is3DView ? t('Passer en vue 2D') : t('Passer en vue 3D')}
        aria-pressed={is3DView}
        title={is3DView ? t('Passer en 2D') : t('Passer en 3D')}
        onClick={handleToggleDimension}
        disabled={disabled}
      >
        <span>{is3DView ? '3D' : '2D'}</span>
      </button>

      <div className="rvmvc-map-tools__legend-row" ref={legendPopoverRef}>
        {isLegendOpen && hasRouteSlope ? (
          // Tracé en pente : la légende se résume à ses classes, sans onglets
          // (les revêtements ne sont pas dessinés dans ce mode).
          <section
            className="rvmvc-route-legend-popover rvmvc-route-legend-popover--slope"
            aria-label={slopeLegendPanelTitle}
          >
            <span className="rvmvc-route-legend-popover__title" title={slopeLegendPanelTitle}>
              {slopeLegendPanelTitle}
            </span>
            {slopeLegendList}
          </section>
        ) : isLegendOpen ? (
          <section className="rvmvc-route-legend-popover" aria-label={t('Légende du tracé')}>
            <div className="rvmvc-route-legend-popover__header">
              <span className="rvmvc-route-legend-popover__title">
                {activeLegendTab === 'slopes' ? slopeLegendPanelTitle : t('Légende du tracé')}
              </span>
            </div>

            <div className="rvmvc-route-legend-popover__tabs">
              <button
                type="button"
                className={`rvmvc-route-legend-popover__tab${activeLegendTab === 'surfaces' ? ' is-active' : ''}`}
                onClick={() => setActiveLegendTab('surfaces')}
              >
                {t('Revêtements')}
              </button>
              <button
                type="button"
                className={`rvmvc-route-legend-popover__tab${activeLegendTab === 'slopes' ? ' is-active' : ''}`}
                onClick={() => setActiveLegendTab('slopes')}
              >
                {t('Pentes')}
              </button>
            </div>

            {activeLegendTab === 'surfaces' ? (
              <div className="rvmvc-route-legend-popover__list">
                {SURFACE_LEGEND_ITEMS.map((item) => (
                  <div key={item.id} className="rvmvc-route-legend-popover__surface-item">
                    <SurfacePatternPreview type={item.id} color={traceColor} />
                    <span className="rvmvc-route-legend-popover__item-label">{t(item.label)}</span>
                  </div>
                ))}
              </div>
            ) : slopeLegendList}
          </section>
        ) : null}

        <button
          type="button"
          className={`rvmvc-map-tools__button${isLegendOpen ? ' is-active' : ''}`}
          aria-label={isLegendOpen ? t('Masquer la légende du tracé') : t('Afficher la légende du tracé')}
          aria-pressed={isLegendOpen}
          title={t('Légende')}
          onClick={() => {
            setLegendOpenedBySlope(false);
            setIsLegendOpen((value) => !value);
          }}
        >
          <IconInfo size={iconSize(16)} />
        </button>
      </div>
    </aside>
  );
});