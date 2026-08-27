import { useEffect, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { ROUTE_SLOPE_LEGEND_BANDS } from '@/features/controlPanel/lib';
import { useAnalysisZone } from '@/features/analysisZone';
import { useProjectStoreOptional } from '@/features/itineraryPanel';
import { useAppI18n } from '@/shared/i18n';
import { DEFAULT_VIEW } from '@/features/map3d/lib/mapbox.config';
import {
  IconCompass,
  IconInfo,
  IconMaximize,
  IconPolygonZone,
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
  routeColor?: string | null;
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
  routeColor = null,
}: MapViewportControlsProps) {
  const { t } = useAppI18n();
  const [bearing, setBearing] = useState(0);
  const [is3DView, setIs3DView] = useState(DEFAULT_VIEW.pitch > THREE_D_PITCH_THRESHOLD);
  const [isLegendOpen, setIsLegendOpen] = useState(false);
  const [activeLegendTab, setActiveLegendTab] = useState<'surfaces' | 'slopes'>('surfaces');
  const [isZonePopoverOpen, setIsZonePopoverOpen] = useState(false);

  const projectStore = useProjectStoreOptional();
  const activeItinerary = projectStore?.project.itineraries.find(
    (itinerary) => itinerary.id === projectStore.project.activeItineraryId && itinerary.visible !== false,
  ) ?? projectStore?.project.itineraries.find((itinerary) => itinerary.visible !== false) ?? null;

  const traceColor = routeColor ?? activeItinerary?.color ?? '#ff3b30';

  const analysisZone = useAnalysisZone();
  const hasAnalysisZone = Boolean(analysisZone?.zone);
  const isZoneDrawing = Boolean(analysisZone?.isDrawing);
  const zonePopoverRef = useRef<HTMLDivElement | null>(null);
  const legendPopoverRef = useRef<HTMLDivElement | null>(null);

  const hasRouteSlope = routeSlopeLegendTitle != null;
  const slopeLegendPanelTitle = routeSlopeLegendTitle ?? t('Légende de pente du tracé');

  useEffect(() => {
    if (hasRouteSlope) {
      setActiveLegendTab('slopes');
    }
  }, [hasRouteSlope]);

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

  // Close the analysis-zone popover when clicking anywhere outside of it.
  useEffect(() => {
    if (!isZonePopoverOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (zonePopoverRef.current?.contains(event.target as Node)) return;
      setIsZonePopoverOpen(false);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isZonePopoverOpen]);

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

  // Keep the popover consistent with the zone lifecycle.
  useEffect(() => {
    if (!hasAnalysisZone) setIsZonePopoverOpen(false);
  }, [hasAnalysisZone]);
  useEffect(() => {
    if (isZoneDrawing) setIsZonePopoverOpen(false);
  }, [isZoneDrawing]);

  const handleZoneButtonClick = () => {
    if (!analysisZone) return;
    setIsLegendOpen(false);
    if (analysisZone.isDrawing) {
      analysisZone.cancelDrawing();
      return;
    }
    if (analysisZone.zone) {
      setIsZonePopoverOpen((value) => !value);
      return;
    }
    analysisZone.startDrawing();
  };

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

      <button
        type="button"
        className={`rvmvc-map-tools__button rvmvc-map-tools__button--label${is3DView ? ' is-active' : ''}`}
        aria-label={is3DView ? t('Passer en vue 2D') : t('Passer en vue 3D')}
        aria-pressed={is3DView}
        title={is3DView ? t('Passer en 2D') : t('Passer en 3D')}
        onClick={handleToggleDimension}
        disabled={disabled}
      >
        <span>{is3DView ? '3D' : '2D'}</span>
      </button>

      {analysisZone ? (
        <div className="rvmvc-map-tools__zone-row" ref={zonePopoverRef}>
          {isZonePopoverOpen && hasAnalysisZone ? (
            <section className="rvmvc-analysis-zone-popover" aria-label={t('Zone d’analyse')}>
              <div className="rvmvc-analysis-zone-popover__title">{t('Zone d’analyse')}</div>
              {analysisZone.zoneHint ? (
                <div className="rvmvc-analysis-zone-popover__hint">{analysisZone.zoneHint}</div>
              ) : null}
              <div className="rvmvc-analysis-zone-popover__actions">
                <button
                  type="button"
                  className="rvmvc-analysis-zone-popover__action"
                  onClick={() => {
                    setIsZonePopoverOpen(false);
                    analysisZone.startDrawing();
                  }}
                >
                  {t('Redessiner la zone')}
                </button>
                <button
                  type="button"
                  className="rvmvc-analysis-zone-popover__action"
                  onClick={() => analysisZone.fitZone()}
                >
                  {t('Zoomer sur la zone')}
                </button>
                <button
                  type="button"
                  className="rvmvc-analysis-zone-popover__action rvmvc-analysis-zone-popover__action--danger"
                  onClick={() => {
                    setIsZonePopoverOpen(false);
                    analysisZone.clearZone();
                  }}
                >
                  {t('Supprimer la zone')}
                </button>
              </div>
            </section>
          ) : null}

          {isZoneDrawing ? (
            <div className="rvmvc-analysis-zone-hint" role="status">
              <div className="rvmvc-analysis-zone-hint__text">
                {analysisZone.draftPointsCount === 0 &&
                  t('Cliquez pour placer les sommets, double-cliquez pour terminer, Échap pour annuler')}
                {analysisZone.draftPointsCount === 1 &&
                  t('1 sommet placé — cliquez pour le 2e')}
                {analysisZone.draftPointsCount === 2 &&
                  t('2 sommets placés — cliquez pour le 3e')}
                {analysisZone.draftPointsCount >= 3 &&
                  t('Double-cliquez ou cliquez sur le 1er point pour valider')}
              </div>
              <div className="rvmvc-analysis-zone-hint__actions">
                {analysisZone.draftPointsCount >= 3 ? (
                  <button
                    type="button"
                    className="rvmvc-analysis-zone-hint__action rvmvc-analysis-zone-hint__action--primary"
                    onClick={() => analysisZone.commitCurrentDraft()}
                  >
                    {t('Valider')}
                  </button>
                ) : null}
                {analysisZone.draftPointsCount > 0 ? (
                  <button
                    type="button"
                    className="rvmvc-analysis-zone-hint__action"
                    onClick={() => analysisZone.undoDraftPoint()}
                  >
                    {t('Annuler point')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="rvmvc-analysis-zone-hint__action"
                  onClick={() => analysisZone.cancelDrawing()}
                >
                  {t('Annuler')}
                </button>
              </div>
            </div>
          ) : null}

          <button
            type="button"
            className={`rvmvc-map-tools__button${isZoneDrawing || hasAnalysisZone ? ' is-active' : ''}`}
            aria-label={t('Zone d’analyse terrain (pentes, altitude, ensoleillement)')}
            aria-pressed={isZoneDrawing || hasAnalysisZone}
            title={hasAnalysisZone ? t('Zone d’analyse') : t('Tracer une zone d’analyse')}
            onClick={handleZoneButtonClick}
            disabled={disabled}
          >
            <IconPolygonZone size={20} />
          </button>
        </div>
      ) : null}

      <div className="rvmvc-map-tools__legend-row" ref={legendPopoverRef}>
        {isLegendOpen ? (
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
            ) : (
              <div className="rvmvc-route-legend-popover__list">
                {ROUTE_SLOPE_LEGEND_BANDS.map((band) => (
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
            )}
          </section>
        ) : null}

        <button
          type="button"
          className={`rvmvc-map-tools__button${isLegendOpen ? ' is-active' : ''}`}
          aria-label={isLegendOpen ? t('Masquer la légende du tracé') : t('Afficher la légende du tracé')}
          aria-pressed={isLegendOpen}
          title={t('Légende')}
          onClick={() => {
            setIsZonePopoverOpen(false);
            setIsLegendOpen((value) => !value);
          }}
        >
          <IconInfo size={16} />
        </button>
      </div>
    </aside>
  );
}