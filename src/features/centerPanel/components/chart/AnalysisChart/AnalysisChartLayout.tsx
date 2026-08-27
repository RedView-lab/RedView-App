import { Fragment, type CSSProperties, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { PoiBadge } from '@/features/itineraryPanel/sections/timeline/KindBadge';
import { IconMoon, IconSun } from '../../CenterPanelIcons';
import type { AxisMetricId, AxisMode, ChartSeries } from '../series';
import { formatAxisLabel, xAnchorTransformFor } from './format';
import { buildPoiSpreadOffsetPx, shouldExpandPoiCluster, shouldRenderPoiCluster } from './poi';
import { EmptySeriesRow, HoverCardGroup, SeriesRow } from './rows';
import {
  MULTI_POI_MARKER_HEIGHT_PX,
  MULTI_POI_MARKER_WIDTH_PX,
  POI_MARKER_SIZE_PX,
  type HoverCardRow,
  type PoiMarkerGroup,
} from './types';

interface AnalysisChartLayoutProps {
  style: CSSProperties;
  axis1Metric: AxisMetricId;
  axis2Metric: AxisMetricId;
  plotAreaRef: RefObject<HTMLDivElement | null>;
  handlePlotClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  dayNightBands: Array<{ id: string; startRatio: number; endRatio: number }>;
  yPositions: Array<{ value: number; ratio: number }>;
  y2Positions: Array<{ value: number; ratio: number }>;
  xPositions: Array<{ value: number; ratio: number }>;
  nightFrames: Array<{ id: string; startRatio: number; endRatio: number }>;
  seriesCanvasRef: RefObject<HTMLCanvasElement | null>;
  visibleAlertAnnotations: Array<{
    id: string;
    itineraryName: string;
    label: string;
    detail: string;
    xRatio: number;
    yRatio: number;
  }>;
  poiMarkerGroups: PoiMarkerGroup[];
  visibleFraction: number;
  expandedPoiClusterId: string | null;
  onPoiClusterClick: (group: PoiMarkerGroup) => void;
  activeHover: { x: number; ratioX: number } | null;
  hoverMarkers: Array<{ id: string; topRatio: number; color: string; backdrop: boolean }>;
  hoverXValue: number | null;
  xMode: AxisMode;
  hoverRows: HoverCardRow[];
  xAxisLabels: Array<{ value: number; ratio: number; label: string }>;
  normalizedDetailOffset: number;
  onDetailOffsetChange?: (value: number) => void;
  showSeriesRows: boolean;
  visibleSeries: ChartSeries[];
}

export function AnalysisChartLayout({
  style,
  axis1Metric,
  axis2Metric,
  plotAreaRef,
  handlePlotClick,
  dayNightBands,
  yPositions,
  y2Positions,
  xPositions,
  nightFrames,
  seriesCanvasRef,
  visibleAlertAnnotations,
  poiMarkerGroups,
  visibleFraction,
  expandedPoiClusterId,
  onPoiClusterClick,
  activeHover,
  hoverMarkers,
  hoverXValue,
  xMode,
  hoverRows,
  xAxisLabels,
  normalizedDetailOffset,
  onDetailOffsetChange,
  showSeriesRows,
  visibleSeries,
}: AnalysisChartLayoutProps) {
  const { t } = useAppI18n();
  return (
    <div className="rvchart" style={style}>
      <div className="rvchart__plot">
        <div className="rvchart__yaxis-left" aria-hidden="true">
          {yPositions
            .filter(({ ratio }) => ratio > 0.01 && ratio < 0.99)
            .map(({ value, ratio }, index) => (
              <span
                key={`yl-${index}-${value}`}
                className="rvchart__yaxis-label"
                style={{ top: `${ratio * 100}%` }}
              >
                {formatAxisLabel(value, axis1Metric)}
              </span>
            ))}
        </div>

        <div ref={plotAreaRef} className="rvchart__plotarea" onClick={handlePlotClick}>
          <div className="rvchart__layer rvchart__layer--bg" aria-hidden="true">
            {dayNightBands.map(({ id, startRatio, endRatio }) => (
              <div
                key={id}
                className="rvchart__day-night-band"
                style={{ left: `${startRatio * 100}%`, width: `${(endRatio - startRatio) * 100}%` }}
              />
            ))}
            {dayNightBands.map(({ id, startRatio, endRatio }) =>
              endRatio - startRatio > 0.06 ? (
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

          <canvas ref={seriesCanvasRef} className="rvchart__layer rvchart__layer--series" aria-hidden="true" />

          <div className="rvchart__layer rvchart__layer--markers">
            {visibleAlertAnnotations.map((annotation) => (
              <div
                key={annotation.id}
                className="rvchart__alert-marker"
                style={{
                  left: `${annotation.xRatio * 100}%`,
                  top: `${annotation.yRatio * 100}%`,
                }}
                title={`${annotation.itineraryName} · ${annotation.label} · ${annotation.detail}`}
                aria-hidden="true"
              >
                <span className="rvchart__alert-marker-cross">X</span>
              </div>
            ))}

            {poiMarkerGroups.map((group) => {
              if (group.kind === 'single') {
                const annotation = group.members[0];
                return (
                  <div
                    key={group.id}
                    className="rvchart__poi-marker"
                    style={{
                      left: `${group.xRatio * 100}%`,
                      top: `${group.yRatio * 100}%`,
                    }}
                    title={`${annotation.itineraryName} · ${annotation.categoryLabel} · ${annotation.label}`}
                    aria-hidden="true"
                  >
                    {annotation.kind === 'pause' ? (
                      <img
                        src="/svgv2/icone/checkpoint-pause.svg"
                        alt="Pause"
                        style={{
                          width: POI_MARKER_SIZE_PX,
                          height: POI_MARKER_SIZE_PX,
                          display: 'block',
                          objectFit: 'contain',
                          filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.4))',
                        }}
                      />
                    ) : annotation.kind === 'waypoint' ? (
                      <img
                        src="/svgv2/icone/checkpoint-waypoint.svg"
                        alt="Waypoint"
                        style={{
                          width: POI_MARKER_SIZE_PX,
                          height: POI_MARKER_SIZE_PX,
                          display: 'block',
                          objectFit: 'contain',
                          filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.4))',
                        }}
                      />
                    ) : annotation.poiCategory ? (
                      <PoiBadge category={annotation.poiCategory} size={POI_MARKER_SIZE_PX} />
                    ) : (
                      <span className="rvchart__poi-marker-fallback">POI</span>
                    )}
                  </div>
                );
              }

              if (shouldRenderPoiCluster(group, visibleFraction, expandedPoiClusterId)) {
                return (
                  <button
                    key={group.id}
                    type="button"
                    className="rvchart__poi-cluster"
                    style={{
                      left: `${group.xRatio * 100}%`,
                      top: `${group.yRatio * 100}%`,
                    }}
                    title={t('{{count}} POI regroupés. Cliquer pour zoomer sur cette zone.', { count: group.count })}
                    aria-label={t('{{count}} POI regroupés. Cliquer pour zoomer sur cette zone.', { count: group.count })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onPoiClusterClick(group);
                    }}
                  >
                    <img
                      src="/multiPOI.svg"
                      alt=""
                      className="rvchart__poi-cluster-icon"
                      width={MULTI_POI_MARKER_WIDTH_PX}
                      height={MULTI_POI_MARKER_HEIGHT_PX}
                    />
                  </button>
                );
              }

              return (
                <Fragment key={group.id}>
                  {group.members.map((annotation, index) => {
                    const offsetPx = shouldExpandPoiCluster(
                      group,
                      visibleFraction,
                      expandedPoiClusterId,
                    )
                      ? buildPoiSpreadOffsetPx(index, group.count)
                      : 0;
                    return (
                      <div
                        key={annotation.id}
                        className="rvchart__poi-marker"
                        style={{
                          left: `calc(${annotation.xRatio * 100}% + ${offsetPx}px)`,
                          top: `${annotation.yRatio * 100}%`,
                        }}
                        title={`${annotation.itineraryName} · ${annotation.categoryLabel} · ${annotation.label}`}
                        aria-hidden="true"
                      >
                        {annotation.kind === 'pause' ? (
                          <img
                            src="/svgv2/icone/checkpoint-pause.svg"
                            alt="Pause"
                            style={{
                              width: POI_MARKER_SIZE_PX,
                              height: POI_MARKER_SIZE_PX,
                              display: 'block',
                              objectFit: 'contain',
                              filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.4))',
                            }}
                          />
                        ) : annotation.kind === 'waypoint' ? (
                          <img
                            src="/svgv2/icone/checkpoint-waypoint.svg"
                            alt="Waypoint"
                            style={{
                              width: POI_MARKER_SIZE_PX,
                              height: POI_MARKER_SIZE_PX,
                              display: 'block',
                              objectFit: 'contain',
                              filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.4))',
                            }}
                          />
                        ) : annotation.poiCategory ? (
                          <PoiBadge category={annotation.poiCategory} size={POI_MARKER_SIZE_PX} />
                        ) : (
                          <span className="rvchart__poi-marker-fallback">POI</span>
                        )}
                      </div>
                    );
                  })}
                </Fragment>
              );
            })}
          </div>

          <div className="rvchart__layer rvchart__layer--overlay" aria-hidden="true">
            {activeHover && hoverXValue != null ? (
              <>
                <HoverCardGroup
                  hoverRatioX={activeHover.ratioX}
                  xValue={hoverXValue}
                  xMode={xMode}
                  rows={hoverRows}
                />
                <div
                  className="rvchart__cursor"
                  style={{ left: `${(activeHover.ratioX * 100).toFixed(4)}%` }}
                />
                {hoverMarkers.map((marker) => (
                  <div
                    key={marker.id}
                    className={
                      marker.backdrop
                        ? 'rvchart__hover-point rvchart__hover-point--backdrop'
                        : 'rvchart__hover-point'
                    }
                    style={{
                      left: `${(activeHover.ratioX * 100).toFixed(4)}%`,
                      top: `${(marker.topRatio * 100).toFixed(4)}%`,
                      ['--rvchart-hover-point-color' as string]: marker.color,
                    }}
                  />
                ))}
              </>
            ) : null}
          </div>
        </div>

        <div className="rvchart__yaxis-right" aria-hidden="true">
          {y2Positions
            .filter(({ ratio }) => ratio > 0.01 && ratio < 0.99)
            .map(({ value, ratio }, index) => (
              <span
                key={`yr-${index}-${value}`}
                className="rvchart__yaxis-label"
                style={{ top: `${ratio * 100}%` }}
              >
                {formatAxisLabel(value, axis2Metric)}
              </span>
            ))}
        </div>
      </div>

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
      </div>

      <div className="rvchart__viewport" aria-label={t('Déplacement horizontal du graphique')}>
        <div />
        <div className="rvchart__viewport-track">
          <div
            className="rvchart__viewport-window"
            style={{
              width: `${visibleFraction * 100}%`,
              left: `${normalizedDetailOffset * (1 - visibleFraction) * 100}%`,
            }}
          />
          <input
            className="rvchart__viewport-input"
            type="range"
            min="0"
            max="1000"
            step="1"
            value={Math.round(normalizedDetailOffset * 1000)}
            onChange={(event) => onDetailOffsetChange?.(Number(event.target.value) / 1000)}
            disabled={visibleFraction >= 0.999}
            aria-label={t('Déplacer la zone visible du graphique')}
          />
        </div>
        <div />
      </div>

      {showSeriesRows
        ? visibleSeries.length === 0
          ? <EmptySeriesRow axis1={axis1Metric} axis2={axis2Metric} />
          : visibleSeries.map((entry) => (
              <SeriesRow key={entry.id} seriesEntry={entry} xPositions={xPositions} />
            ))
        : null}
    </div>
  );
}