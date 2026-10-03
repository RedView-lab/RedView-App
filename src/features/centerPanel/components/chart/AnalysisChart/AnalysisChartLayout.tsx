import {
  memo,
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { translateAppText, useAppI18n } from '@/shared/i18n';
import { IconMoon, IconSun } from '../../CenterPanelIcons';
import type { AxisMetricId, AxisMode, ChartSeries } from '../series';
import { formatAxisLabel, xAnchorTransformFor } from './format';
import { ChartZoomNavigator } from './ChartZoomNavigator';
import { PoiCanvasLayer, type PoiCanvasHandlers } from './PoiCanvasLayer';
import { EmptySeriesRow, HoverCardGroup, SeriesRow } from './rows';
import {
  type HoverCardRow,
  type PoiMarkerGroup,
  type VisiblePoiAnnotation,
} from './types';

type PauseBand = {
  id: string;
  startRatio: number;
  endRatio: number;
  label?: string;
  durationMin?: number;
};

const EMPTY_PAUSE_BANDS: PauseBand[] = [];

type AlertBand = { id: string; startRatio: number; endRatio: number; label: string };

const EMPTY_ALERT_BANDS: AlertBand[] = [];

interface AnalysisChartLayoutProps {
  style: CSSProperties;
  axis1Metric: AxisMetricId;
  axis2Metric: AxisMetricId | null;
  plotAreaRef: RefObject<HTMLDivElement | null>;
  onPlotPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPlotDoubleClick?: () => void;
  /** Pointeur sur un tronçon « Pente » cliquable (le clic le sélectionne). */
  plotPointerOverSegment?: boolean;
  onResetZoom?: () => void;
  isZoomed?: boolean;
  selectionBand?: {
    startRatio: number;
    endRatio: number;
    startX: number;
    endX: number;
    isDragging: boolean;
  } | null;
  dayNightBands: Array<{ id: string; startRatio: number; endRatio: number }>;
  pauseBands?: PauseBand[];
  alertBands?: AlertBand[];
  /** Clic sur l'icône d'une colonne « Alertes » (id de la fenêtre). */
  onAlertClick?: (alertId: string) => void;
  yPositions: Array<{ value: number; ratio: number }>;
  y2Positions: Array<{ value: number; ratio: number }>;
  xPositions: Array<{ value: number; ratio: number }>;
  nightFrames: Array<{ id: string; startRatio: number; endRatio: number }>;
  seriesCanvasRef: RefObject<HTMLCanvasElement | null>;
  plotWidth: number;
  plotHeight: number;
  poiMarkerGroups: PoiMarkerGroup[];
  visibleFraction: number;
  expandedPoiClusterId: string | null;
  onPoiClusterClick: (group: PoiMarkerGroup) => void;
  onPoiClick?: (annotation: VisiblePoiAnnotation) => void;
  activeHover: { x: number; ratioX: number } | null;
  hoverMarkers: Array<{ id: string; topRatio: number; color: string; backdrop: boolean }>;
  hoverXValue: number | null;
  xMode: AxisMode;
  hoverRows: HoverCardRow[];
  xAxisLabels: Array<{ value: number; ratio: number; label: string }>;
  normalizedDetailOffset: number;
  yVisibleFraction: number;
  normalizedYOffset: number;
  onHorizontalNavigatorChange: (next: { visibleFraction: number; offset: number }) => void;
  onVerticalNavigatorChange: (next: { visibleFraction: number; offset: number }) => void;
  showSeriesRows: boolean;
  visibleSeries: ChartSeries[];
}


/**
 * Couches statiques du graphe (fond, grille, POI, axes, navigateurs, lignes de séries).
 * Mémoïsées séparément du survol : un déplacement du curseur ne re-rend que la couche overlay.
 */
const ChartBackgroundLayer = memo(function ChartBackgroundLayer({
  dayNightBands,
  pauseBands,
  alertBands,
  yPositions,
  xPositions,
  nightFrames,
}: Pick<AnalysisChartLayoutProps, 'dayNightBands' | 'yPositions' | 'xPositions' | 'nightFrames'> & {
  pauseBands: PauseBand[];
  alertBands: AlertBand[];
}) {
  return (
    <div className="rvchart__layer rvchart__layer--bg" aria-hidden="true">
      {dayNightBands.map(({ id, startRatio, endRatio }) => (
        <div
          key={id}
          className="rvchart__day-night-band"
          style={{ left: `${startRatio * 100}%`, width: `${(endRatio - startRatio) * 100}%` }}
        />
      ))}
      {pauseBands.map(({ id, startRatio, endRatio, label, durationMin }) => {
        const clampedStart = Math.max(0, startRatio);
        const clampedEnd = Math.min(1, endRatio);
        const width = clampedEnd - clampedStart;
        if (width <= 0) return null;
        return (
          <div
            key={id}
            className="rvchart__pause-band"
            style={{
              left: `${clampedStart * 100}%`,
              width: `${width * 100}%`,
            }}
            title={label ? `${translateAppText(label)}${durationMin ? ` · ${durationMin} min` : ''}` : undefined}
          />
        );
      })}
      {alertBands.map(({ id, startRatio, endRatio }) => {
        const clampedStart = Math.max(0, startRatio);
        const clampedEnd = Math.min(1, endRatio);
        if (clampedEnd <= clampedStart) return null;
        return (
          <div
            key={id}
            className="rvchart__alert-band"
            style={{ left: `${clampedStart * 100}%`, width: `${(clampedEnd - clampedStart) * 100}%` }}
          />
        );
      })}
      {dayNightBands.map(({ id, startRatio, endRatio }) =>
        endRatio - startRatio > 0.02 ? (
          <div
            key={`${id}-sun`}
            className="rvchart__day-night-corner-icon rvchart__day-night-corner-icon--sun"
            style={{ left: `calc(${startRatio * 100}% + 6px)` }}
          >
            <IconSun size={16} />
          </div>
        ) : null,
      )}
      {yPositions.map(({ value, ratio }) => (
        <div
          key={`hl-${value}-${ratio.toFixed(4)}`}
          className="rvchart__hline"
          style={{ top: `${ratio * 100}%` }}
        />
      ))}
      {xPositions.map(({ value, ratio }) => (
        <div
          key={`vl-${value}-${ratio.toFixed(4)}`}
          className="rvchart__vline"
          style={{ left: `${ratio * 100}%` }}
        />
      ))}
      {nightFrames.map(({ id, startRatio }) => (
        <div
          key={id}
          className="rvchart__day-night-corner-icon rvchart__day-night-corner-icon--moon"
          style={{ left: `calc(${startRatio * 100}% + 6px)` }}
        >
          <IconMoon size={16} />
        </div>
      ))}
    </div>
  );
});

const ChartYAxisLabels = memo(function ChartYAxisLabels({
  positions,
  metric,
  side,
}: {
  positions: Array<{ value: number; ratio: number }>;
  metric: AxisMetricId;
  side: 'left' | 'right';
}) {
  return (
    <div className={`rvchart__yaxis-${side}`} aria-hidden="true">
      {positions
        .filter(({ ratio }) => ratio > 0.01 && ratio < 0.99)
        .map(({ value, ratio }, index) => (
          <span
            key={`y${side[0]}-${index}-${value}`}
            className="rvchart__yaxis-label"
            style={{ top: `${ratio * 100}%` }}
          >
            {formatAxisLabel(value, metric)}
          </span>
        ))}
    </div>
  );
});

const ChartXAxis = memo(function ChartXAxis({
  xAxisLabels,
}: Pick<AnalysisChartLayoutProps, 'xAxisLabels'>) {
  return (
    <div className="rvchart__xaxis">
      <div />
      <div className="rvchart__xaxis-cells">
        {xAxisLabels.map(({ value, ratio, label }) => (
          <div
            key={`xa-${value}-${ratio.toFixed(4)}`}
            className="rvchart__xaxis-cell"
            style={{ left: `${ratio * 100}%`, transform: xAnchorTransformFor(ratio) }}
          >
            {label}
          </div>
        ))}
      </div>
      <div />
      <div />
    </div>
  );
});

const ChartSeriesRows = memo(function ChartSeriesRows({
  visibleSeries,
  xPositions,
  axis1Metric,
  axis2Metric,
}: Pick<AnalysisChartLayoutProps, 'visibleSeries' | 'xPositions' | 'axis1Metric' | 'axis2Metric'>) {
  if (visibleSeries.length === 0) {
    return <EmptySeriesRow axis1={axis1Metric} axis2={axis2Metric} />;
  }
  return (
    <>
      {visibleSeries.map((entry) => (
        <SeriesRow key={entry.id} seriesEntry={entry} xPositions={xPositions} />
      ))}
    </>
  );
});

const MemoChartZoomNavigator = memo(ChartZoomNavigator);

/**
 * Icônes cliquables des colonnes « Alertes » : ouvrent la fiche du tronçon,
 * comme les icônes de la carte. Au-dessus des POI, hors de la couche de fond
 * (`aria-hidden`, sans pointeur).
 */
const ChartAlertIconLayer = memo(function ChartAlertIconLayer({
  alertBands,
  handlerRef,
}: {
  alertBands: AlertBand[];
  handlerRef: RefObject<((alertId: string) => void) | undefined>;
}) {
  if (alertBands.length === 0) return null;
  return (
    <div className="rvchart__layer rvchart__layer--alerts">
      {alertBands.map(({ id, startRatio, endRatio, label }) => {
        const clampedStart = Math.max(0, startRatio);
        const clampedEnd = Math.min(1, endRatio);
        if (clampedEnd <= clampedStart) return null;
        return (
          <button
            key={id}
            type="button"
            className="rvchart__alert-icon"
            style={{ left: `${((clampedStart + clampedEnd) / 2) * 100}%` }}
            title={label}
            aria-label={label}
            // Le clic ne doit pas lancer la sélection / le centrage du graphe.
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              handlerRef.current?.(id);
            }}
          >
            <img src="/svgv2/icone/search-filter-alertes.svg" alt="" draggable={false} />
          </button>
        );
      })}
    </div>
  );
});

export function AnalysisChartLayout({
  style,
  axis1Metric,
  axis2Metric,
  plotAreaRef,
  onPlotPointerDown,
  onPlotDoubleClick,
  plotPointerOverSegment = false,
  onResetZoom,
  isZoomed,
  selectionBand,
  dayNightBands,
  pauseBands = EMPTY_PAUSE_BANDS,
  alertBands = EMPTY_ALERT_BANDS,
  onAlertClick,
  yPositions,
  y2Positions,
  xPositions,
  nightFrames,
  seriesCanvasRef,
  plotWidth,
  plotHeight,
  poiMarkerGroups,
  visibleFraction,
  expandedPoiClusterId,
  onPoiClusterClick,
  onPoiClick,
  activeHover,
  hoverMarkers,
  hoverXValue,
  xMode,
  hoverRows,
  xAxisLabels,
  normalizedDetailOffset,
  yVisibleFraction,
  normalizedYOffset,
  onHorizontalNavigatorChange,
  onVerticalNavigatorChange,
  showSeriesRows,
  visibleSeries,
}: AnalysisChartLayoutProps) {
  const { t } = useAppI18n();

  // Handlers POI lus au clic : la couche marqueurs reste mémoïsée même si le parent
  // recrée ses callbacks à chaque rendu (survol).
  const poiHandlersRef = useRef<PoiCanvasHandlers>({ onPoiClusterClick, onPoiClick });
  const alertHandlerRef = useRef(onAlertClick);
  useEffect(() => {
    poiHandlersRef.current = { onPoiClusterClick, onPoiClick };
    alertHandlerRef.current = onAlertClick;
  });

  const hoverLeft = activeHover ? `${(activeHover.ratioX * 100).toFixed(4)}%` : '0%';
  const hoverOverlay =
    activeHover && hoverXValue != null ? (
      <>
        <HoverCardGroup
          hoverRatioX={activeHover.ratioX}
          xValue={hoverXValue}
          xMode={xMode}
          rows={hoverRows}
        />
        <div className="rvchart__cursor" style={{ left: hoverLeft }} />
        {hoverMarkers.map((marker) => (
          <div
            key={marker.id}
            className={
              marker.backdrop
                ? 'rvchart__hover-point rvchart__hover-point--backdrop'
                : 'rvchart__hover-point'
            }
            style={{
              left: hoverLeft,
              top: `${(marker.topRatio * 100).toFixed(4)}%`,
              ['--rvchart-hover-point-color' as string]: marker.color,
            }}
          />
        ))}
      </>
    ) : null;

  return (
    <div className="rvchart" style={style}>
      <div className="rvchart__plot">
        <ChartYAxisLabels positions={yPositions} metric={axis1Metric} side="left" />

        <div
          ref={plotAreaRef}
          className={`rvchart__plotarea${plotPointerOverSegment ? ' rvchart__plotarea--segment' : ''}`}
          onPointerDown={onPlotPointerDown}
          onDoubleClick={onPlotDoubleClick}
        >
          <ChartBackgroundLayer
            dayNightBands={dayNightBands}
            pauseBands={pauseBands}
            alertBands={alertBands}
            yPositions={yPositions}
            xPositions={xPositions}
            nightFrames={nightFrames}
          />

          <canvas ref={seriesCanvasRef} className="rvchart__layer rvchart__layer--series" aria-hidden="true" />

          <div className="rvchart__layer rvchart__layer--markers">
            <PoiCanvasLayer
              poiMarkerGroups={poiMarkerGroups}
              visibleFraction={visibleFraction}
              expandedPoiClusterId={expandedPoiClusterId}
              handlersRef={poiHandlersRef}
              plotAreaRef={plotAreaRef}
              width={plotWidth}
              height={plotHeight}
            />
          </div>

          <ChartAlertIconLayer alertBands={alertBands} handlerRef={alertHandlerRef} />

          <div className="rvchart__layer rvchart__layer--overlay" aria-hidden="true">
            {hoverOverlay}
          </div>

          {selectionBand && (
            <div
              className="rvchart__selection-band"
              style={{
                left: `${Math.max(0, selectionBand.startRatio) * 100}%`,
                width: `${Math.max(
                  0,
                  Math.min(1, selectionBand.endRatio) - Math.max(0, selectionBand.startRatio),
                ) * 100}%`,
              }}
              aria-hidden="true"
            />
          )}

          {isZoomed && onResetZoom && (
            <button
              type="button"
              className="rvchart__zoom-reset-btn"
              onClick={(e) => {
                e.stopPropagation();
                onResetZoom();
              }}
              title={t('Afficher tout le parcours (ou double-clic / Échap)')}
              aria-label={t('Afficher tout le parcours')}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              <span>{t('Vue complète')}</span>
            </button>
          )}
        </div>

        {axis2Metric ? (
          <ChartYAxisLabels positions={y2Positions} metric={axis2Metric} side="right" />
        ) : (
          <div className="rvchart__yaxis-right rvchart__yaxis-right--empty" aria-hidden="true" />
        )}

        <MemoChartZoomNavigator
          orientation="vertical"
          visibleFraction={yVisibleFraction}
          offset={normalizedYOffset}
          onChange={onVerticalNavigatorChange}
          className="rvchart__zoom-vertical"
        />
      </div>

      <ChartXAxis xAxisLabels={xAxisLabels} />

      <div className="rvchart__viewport" aria-label={t('Déplacement horizontal du graphique')}>
        <div />
        <MemoChartZoomNavigator
          orientation="horizontal"
          visibleFraction={visibleFraction}
          offset={normalizedDetailOffset}
          onChange={onHorizontalNavigatorChange}
          className="rvchart__zoom-horizontal"
        />
        <div />
        <div />
      </div>

      {showSeriesRows ? (
        <ChartSeriesRows
          visibleSeries={visibleSeries}
          xPositions={xPositions}
          axis1Metric={axis1Metric}
          axis2Metric={axis2Metric}
        />
      ) : null}
    </div>
  );
}
