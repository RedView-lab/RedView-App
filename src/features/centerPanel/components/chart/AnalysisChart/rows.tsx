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
  axis2: AxisMetricId;
}) {
  const { t } = useAppI18n();
  const message = (() => {
    const a1Ok = metricIsAvailable(axis1);
    const a2Ok = metricIsAvailable(axis2);
    if (!a1Ok && !a2Ok) {
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
        gainM?: number;
        lossM?: number;
        rows: HoverCardRow[];
      }
    >
  >((acc, row) => {
    const key = row.itineraryName || 'Itinéraire';
    if (!acc[key]) {
      acc[key] = {
        color: row.color,
        gainM: row.gainM,
        lossM: row.lossM,
        rows: [],
      };
    }
    if (row.gainM != null) acc[key].gainM = row.gainM;
    if (row.lossM != null) acc[key].lossM = row.lossM;
    acc[key].rows.push(row);
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
                {formatXAxisValue(xValue, xMode)}
              </div>
              {group.gainM != null ? (
                <div className="rvchart__card-metric">+{group.gainM} m</div>
              ) : null}
              {group.lossM != null ? (
                <div className="rvchart__card-metric">-{group.lossM} m</div>
              ) : null}
              {group.rows.map((row) => {
                const isAltitude = row.metric === 'Altitude';
                const formatted = Number.isFinite(row.value)
                  ? formatAxisValue(row.metric, row.value)
                  : '--';
                return (
                  <div key={row.id} className="rvchart__card-metric">
                    {isAltitude ? formatted : `${row.metric}: ${formatted}`}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}