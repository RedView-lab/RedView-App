import { Fragment, useMemo } from 'react';
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
  hoverX: number;
  hoverRatioX: number;
  xValue: number;
  xMode: AxisMode;
  rows: HoverCardRow[];
}

export function HoverCardGroup({
  hoverX,
  hoverRatioX,
  xValue,
  xMode,
  rows,
}: HoverCardGroupProps) {
  if (rows.length === 0) return null;
  const transform = hoverRatioX > 0.56 ? 'translateX(calc(-100% - 4px))' : 'translateX(4px)';

  return (
    <div className="rvchart__cards" style={{ left: `${hoverX}px`, transform }}>
      {rows.map((row) => (
        <Fragment key={row.id}>
          <section className="rvchart__card">
            <span className="rvchart__card-dot" style={{ background: row.color }} />
            <div className="rvchart__card-copy">
              <div className="rvchart__card-distance">
                {row.itineraryName} · {row.axisLabel}
              </div>
              <div className="rvchart__card-metrics">
                <div>
                  {row.metric}:{' '}
                  {Number.isFinite(row.value) ? formatAxisValue(row.metric, row.value) : '--'}
                </div>
                <div>{formatXAxisValue(xValue, xMode)}</div>
              </div>
            </div>
          </section>
        </Fragment>
      ))}
    </div>
  );
}