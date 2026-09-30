import { useMemo } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { IconChevronDown } from '../../CenterPanelIcons';
import {
  formatAxisValue,
  metricIsAvailable,
  type AxisMetricId,
  type AxisMode,
  type ChartSeries,
} from '../series';
import { formatCellValue, formatXAxisValue, xAnchorTransformFor } from './format';
import { interpolateY } from './math';
import type { HoverCardRow } from './types';

interface SeriesRowProps {
  seriesEntry: ChartSeries;
  xPositions: { value: number; ratio: number }[];
}

export function SeriesRow({ seriesEntry, xPositions }: SeriesRowProps) {
  const cellValues = useMemo(
    () =>
      xPositions.map(({ value, ratio }) => ({
        value,
        ratio,
        y: interpolateY(seriesEntry.points, value),
      })),
    [seriesEntry.points, xPositions],
  );

  return (
    <div className="rvchart__series">
      <div className="rvchart__series-control">
        <button type="button" className="rvchart__series-button">
          <span className="rvchart__series-swatch" style={{ background: seriesEntry.color }} />
          <span className="rvchart__series-name">
            {seriesEntry.itineraryName} · {seriesEntry.metricId}
          </span>
          <IconChevronDown size={12} />
        </button>
      </div>
      <div className="rvchart__series-cells">
        {cellValues.map(({ value, ratio, y }) => (
          <div
            key={`${seriesEntry.id}-${value}`}
            className="rvchart__series-cell"
            style={{
              left: `${ratio * 100}%`,
              transform: xAnchorTransformFor(ratio),
            }}
          >
            {Number.isFinite(y) ? formatCellValue(y, seriesEntry.metricId) : '--'}
          </div>
        ))}
      </div>
      <div />
    </div>
  );
}

export function EmptySeriesRow({
  axis1,
  axis2,
}: {
  axis1: AxisMetricId;
  axis2: AxisMetricId | null;
}) {
  const { t } = useAppI18n();
  const message = (() => {
    const a1Ok = metricIsAvailable(axis1);
    const a2Ok = axis2 ? metricIsAvailable(axis2) : true;
    if (!a1Ok && !a2Ok && axis2) {
      return t('{{axis1}} et {{axis2}} ne sont pas encore disponibles.', {
        axis1: t(axis1),
        axis2: t(axis2),
      });
    }
    return t('Aucune prédiction calculée — lancez « Calculer ».');
  })();

  return (
    <div className="rvchart__series">
      <div className="rvchart__series-control">
        <button type="button" className="rvchart__series-button" disabled>
          <span
            className="rvchart__series-swatch"
            style={{ background: 'rgba(255,255,255,0.16)' }}
          />
          <span className="rvchart__series-name">{message}</span>
        </button>
      </div>
      <div />
      <div />
    </div>
  );
}

interface HoverCardGroupProps {
  hoverRatioX: number;
  xValue: number;
  xMode: AxisMode;
  rows: HoverCardRow[];
}

export function HoverCardGroup({
  hoverRatioX,
  xValue,
  xMode,
  rows,
}: HoverCardGroupProps) {
  if (rows.length === 0) return null;
  const transform = hoverRatioX > 0.52 ? 'translateX(-100%)' : 'translateX(0)';

  // Group rows by itineraryName
  const itineraryGroups = rows.reduce<
    Record<
      string,
      {
        color: string;
        distanceFormatted: string;
        gainM?: number;
        lossM?: number;
        durationFormatted?: string;
        timeFormatted?: string;
        alertLabel?: string;
        extraMetrics: HoverCardRow[];
      }
    >
  >((acc, row) => {
    const key = row.itineraryName || 'Itinéraire';
    if (!acc[key]) {
      acc[key] = {
        color: row.color,
        distanceFormatted: row.distanceFormatted || formatXAxisValue(xValue, xMode),
        gainM: row.gainM,
        lossM: row.lossM,
        durationFormatted: row.durationFormatted,
        timeFormatted: row.timeFormatted,
        extraMetrics: [],
      };
    }
    if (row.gainM != null) acc[key].gainM = row.gainM;
    if (row.lossM != null) acc[key].lossM = row.lossM;
    if (row.distanceFormatted) acc[key].distanceFormatted = row.distanceFormatted;
    if (row.durationFormatted) acc[key].durationFormatted = row.durationFormatted;
    if (row.timeFormatted) acc[key].timeFormatted = row.timeFormatted;
    if (row.alertLabel) acc[key].alertLabel = row.alertLabel;
    if (!row.alertLabel && row.metric !== 'Altitude' && row.value != null && Number.isFinite(row.value)) {
      if (!acc[key].extraMetrics.some((m) => m.id === row.id)) {
        acc[key].extraMetrics.push(row);
      }
    }
    return acc;
  }, {});

  return (
    <div
      className="rvchart__cards"
      style={{ left: `${(hoverRatioX * 100).toFixed(4)}%`, transform }}
    >
      {Object.entries(itineraryGroups).map(([itineraryName, group]) => {
        return (
          <div key={itineraryName} className="rvchart__card">
            <div
              className="rvchart__card-dot"
              style={{ background: group.color }}
            />
            <div className="rvchart__card-copy">
              <div className="rvchart__card-distance">
                {group.distanceFormatted}
              </div>
              <div className="rvchart__card-metric">
                +{group.gainM ?? 0} m
              </div>
              <div className="rvchart__card-metric">
                -{group.lossM != null ? Math.abs(group.lossM) : 0} m
              </div>
              {group.durationFormatted ? (
                <div className="rvchart__card-metric">
                  {group.durationFormatted}
                </div>
              ) : null}
              {group.timeFormatted ? (
                <div className="rvchart__card-metric">
                  {group.timeFormatted}
                </div>
              ) : null}
              {group.extraMetrics.map((row) => (
                <div key={row.id} className="rvchart__card-metric">
                  {row.metric}: {formatAxisValue(row.metric, row.value)}
                </div>
              ))}
              {group.alertLabel ? (
                <div className="rvchart__card-metric rvchart__card-metric--alert">
                  <img src="/svgv2/icone/search-filter-alertes.svg" alt="" width={12} height={12} />
                  {group.alertLabel}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}