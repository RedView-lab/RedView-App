/**
 * X axis labels under the profile chart. Figma 1528:18562.
 *
 * Stays separate from <ProfileChart> so the labels can extend below the SVG
 * without breaking its viewBox math.
 */
import { useMemo } from 'react';

import { makeTicks } from './scales';

interface ChartXAxisProps {
  /** Domain shown by the chart (km or seconds). */
  domain: [number, number];
  unit: 'km' | 's';
  /** Approx. number of ticks to render. */
  targetCount?: number;
  /** Pixel padding to align with the chart. */
  paddingLeft: number;
  paddingRight: number;
}

export function ChartXAxis({
  domain,
  unit,
  targetCount = 11,
  paddingLeft,
  paddingRight,
}: ChartXAxisProps) {
  const ticks = useMemo(() => makeTicks(domain, targetCount), [domain, targetCount]);
  const span = Math.max(1, domain[1] - domain[0]);

  return (
    <div className="rvc-chart-xaxis" aria-hidden>
      <div
        className="rvc-chart-xaxis__track"
        style={{ marginLeft: paddingLeft, marginRight: paddingRight }}
      >
        {ticks.map((t) => {
          const pct = ((t - domain[0]) / span) * 100;
          return (
            <div
              key={t}
              className="rvc-chart-xaxis__tick"
              style={{ left: `${pct}%` }}
            >
              {formatTick(t, unit)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatTick(v: number, unit: 'km' | 's'): string {
  if (unit === 'km') return Math.round(v).toString();
  // time → hh:mm
  const total = Math.max(0, Math.round(v));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}:${m.toString().padStart(2, '0')}`;
}
