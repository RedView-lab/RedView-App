/**
 * ChartCard — integrated chart + Y/X axis grid + temperature rows.
 *
 * Source of truth: Figma 1688:22814 ("RedView - Central panel — chart card").
 *
 * Visual structure (one rounded dark card, 24px row grid):
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │ row 0   ──── empty ────────────────────────────────────────────  ─── │
 *   │ row 1   3000  · day-band ·                       · day-band · 30°    │  ←
 *   │ row 2   ──── gridline ────────────────────────────────────────       │   │
 *   │ row 3   2000                                                  20°    │   │  Y
 *   │ row 4   ──── gridline ────────────────────────────────────────       │   │
 *   │ row 5   1000                                                  10°    │   │  axis
 *   │ row 6   ──── gridline ────────────────────────────────────────       │   │
 *   │ row 7    0                                                    0°     │  ↓
 *   │ X axis    0   10   20   30   40   50   60   70   80   90      ⌫     │
 *   │ Tempé. ▼ 17° 17° 17° 17° 17° 17° 17° 17° 17° 17° 17°          ⌫     │
 *   │ Tempé. ▼ 17° 17° 17° 17° 17° 17° 17° 17° 17° 17° 17°          ⌫     │
 *   │ Tempé. ▼ 17° 17° 17° 17° 17° 17° 17° 17° 17° 17° 17°          ⌫     │
 *   │ ⊕ Ajouter ▼                                                          │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * The SVG curves, day bands and droplet markers are absolutely positioned
 * over rows 0..7 (the "plot area"). Floating tooltip cards sit at the top
 * inside the plot area. Below the card, a sun/moon glyph hints day/night.
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

import {
  IconChevronDown,
  IconDots,
  IconMoon,
  IconPlusCircle,
  IconSun,
  IconTrash,
  IconWaterDrop,
} from '../../components/icons';
import { Select } from '../../components/primitives';
import {
  formatDistanceKm,
  formatDurationSpaced,
  formatGain,
  formatLoss,
  formatTemperature,
} from '../../components/format';
import {
  PRIMARY_METRIC_OPTIONS,
  SECONDARY_METRIC_OPTIONS,
} from '../../defaultState';
import {
  makeLinearScale,
  samplesToPath,
  seriesExtent,
  visibleSeries,
  xExtent,
} from '../ProfileChart/scales';
import type {
  CentralPanelItinerary,
  CentralPanelUiState,
  ChartMarker,
  DayNightBand,
} from '../../types';

const HEAD_W = 95; // px — left header column (Y label / temp dropdown / "Ajouter")
const ROW_H = 24; // px — every grid row in the card
const Y_ROWS = 8; // 8 rows compose the chart plot area
const Y_TICKS = 4; // labels appear on rows 1, 3, 5, 7 (every other)
const X_BINS = 11; // 11 X-axis ticks / 11 cells per row

const TEMP_MODE_OPTIONS = [
  { value: 'measured' as const, label: 'Tempé. mesurée' },
  { value: 'forecast' as const, label: 'Tempé. prévue' },
  { value: 'custom' as const, label: 'Tempé. personnalisée' },
];

interface ChartCardProps {
  itineraries: CentralPanelItinerary[];
  ui: CentralPanelUiState;
  markers?: ChartMarker[];
  dayNight?: DayNightBand[];
  onHover?: (xValue: number | null) => void;
  onAddTemperatureRow?: () => void;
  onRemoveTemperatureRow?: (id: string) => void;
  onChangeTemperatureMode?: (
    id: string,
    mode: 'measured' | 'forecast' | 'custom',
  ) => void;
}

export function ChartCard({
  itineraries,
  ui,
  markers = [],
  dayNight = [],
  onHover,
  onAddTemperatureRow,
  onRemoveTemperatureRow,
  onChangeTemperatureMode,
}: ChartCardProps) {
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [plotSize, setPlotSize] = useState({ w: 0, h: 0 });
  const [hoverX, setHoverX] = useState<number | null>(null);

  // Track plot-area pixel size (without the 95px head column) so the SVG
  // can be sized exactly. We use a callback ref + ResizeObserver.
  const setPlotRef = useCallback((node: HTMLDivElement | null) => {
    plotRef.current = node;
    if (!node) return;
    const update = () =>
      setPlotSize({ w: node.clientWidth, h: node.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    // Cleanup is intentionally omitted — when node detaches React calls
    // the callback ref again with `null` and the previous observer is GC'd.
  }, []);

  const primarySeries = useMemo(
    () => visibleSeries(itineraries, 'primary'),
    [itineraries],
  );
  const secondarySeries = useMemo(
    () => visibleSeries(itineraries, 'secondary'),
    [itineraries],
  );

  const xDomain = useMemo<[number, number]>(() => {
    const all = [...primarySeries, ...secondarySeries].map((s) => s.samples);
    return ui.zoomRangeKm ?? xExtent(all);
  }, [primarySeries, secondarySeries, ui.zoomRangeKm]);

  // Round Y domains so the labels look clean (3000 / 2000 / 1000 / 0).
  const y1Domain = useMemo(
    () => niceDomain(seriesExtent(primarySeries.map((s) => s.samples)), Y_TICKS - 1),
    [primarySeries],
  );
  const y2Domain = useMemo(
    () => niceDomain(seriesExtent(secondarySeries.map((s) => s.samples)), Y_TICKS - 1),
    [secondarySeries],
  );

  const y1Ticks = useMemo(() => evenTicks(y1Domain, Y_TICKS), [y1Domain]);
  const y2Ticks = useMemo(() => evenTicks(y2Domain, Y_TICKS), [y2Domain]);

  const primaryUnit = PRIMARY_METRIC_OPTIONS.find(
    (o) => o.value === ui.primaryMetric,
  )?.unit;
  const secondaryUnit = SECONDARY_METRIC_OPTIONS.find(
    (o) => o.value === ui.secondaryMetric,
  )?.unit ?? '°';
  void primaryUnit;

  // Plot pixel area = the cells column area (without 95px head, without the
  // last "current value" cell which is bg-black). Keep curves running across
  // the full cells area though (Figma curves cover the entire plot grid).
  const plotW = plotSize.w;
  const plotH = ROW_H * Y_ROWS; // 192 px — the Y-axis rows

  const xScale = useMemo(
    () => makeLinearScale(xDomain, [0, Math.max(1, plotW)]),
    [xDomain, plotW],
  );
  const y1Scale = useMemo(
    () => makeLinearScale(y1Domain, [plotH, 0]),
    [y1Domain, plotH],
  );
  const y2Scale = useMemo(
    () => makeLinearScale(y2Domain, [plotH, 0]),
    [y2Domain, plotH],
  );

  const handleMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const node = plotRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const px = e.clientX - rect.left;
      if (px < 0 || px > rect.width) {
        setHoverX(null);
        onHover?.(null);
        return;
      }
      const v = xScale.toValue(px);
      setHoverX(v);
      onHover?.(v);
    },
    [onHover, xScale],
  );
  const handleLeave = useCallback(() => {
    setHoverX(null);
    onHover?.(null);
  }, [onHover]);

  const tempRows = itineraries.filter(
    (it) => it.visible && it.temperaturesC && it.temperaturesC.length > 0,
  );

  // X axis labels — evenly distributed (one per cell, at left edge).
  const xLabels = useMemo<string[]>(() => {
    const [a, b] = xDomain;
    const step = (b - a) / X_BINS;
    return Array.from({ length: X_BINS }, (_, i) => {
      const v = a + step * i;
      if (ui.axis1 === 'time') {
        const total = Math.max(0, Math.round(v));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        return `${h}:${m.toString().padStart(2, '0')}`;
      }
      return Math.round(v).toString();
    });
  }, [xDomain, ui.axis1]);

  // Y axis label rows: row 0 empty, then label / empty / label / empty …
  // Reverse so highest value sits at the top.
  const yLabelByRow: (string | null)[] = useMemo(() => {
    const out: (string | null)[] = Array(Y_ROWS).fill(null);
    const sorted = [...y1Ticks].sort((a, b) => b - a); // top → bottom
    sorted.forEach((t, i) => {
      const rowIdx = 1 + i * 2; // rows 1,3,5,7
      if (rowIdx < Y_ROWS) out[rowIdx] = Math.round(t).toString();
    });
    return out;
  }, [y1Ticks]);

  const y2LabelByRow: (string | null)[] = useMemo(() => {
    const out: (string | null)[] = Array(Y_ROWS).fill(null);
    const sorted = [...y2Ticks].sort((a, b) => b - a);
    sorted.forEach((t, i) => {
      const rowIdx = 1 + i * 2;
      if (rowIdx < Y_ROWS) out[rowIdx] = `${Math.round(t)}${secondaryUnit}`;
    });
    return out;
  }, [y2Ticks, secondaryUnit]);

  // Width of each cell as a percentage (11 cells share 100% of plot width).
  const cellPct = 100 / X_BINS;

  return (
    <div className="rvc-card-wrap">
      <div className="rvc-card" aria-label="Profil et températures">
        {/* ───────────── Y-axis rows (0..7) — the chart plot area. ───────── */}
        <div
          className="rvc-card__plot"
          onMouseMove={handleMove}
          onMouseLeave={handleLeave}
        >
          {Array.from({ length: Y_ROWS }).map((_, rowIdx) => (
            <Row
              key={`y-${rowIdx}`}
              leftLabel={yLabelByRow[rowIdx] ?? ''}
              rightLabel={y2LabelByRow[rowIdx] ?? ''}
              cells={X_BINS}
              cellPct={cellPct}
            />
          ))}

          {/* Plot overlay: day bands + curves + markers + tooltips. */}
          <div
            ref={setPlotRef}
            className="rvc-card__plot-overlay"
            style={{ left: HEAD_W }}
          >
            {/* Day bands behind curves. */}
            {ui.overlays.daynight
              ? dayNight.map((b, idx) => {
                  if (b.kind !== 'day') return null;
                  const x = xScale.toPx(b.fromX);
                  const w = Math.max(0, xScale.toPx(b.toX) - x);
                  return (
                    <div
                      key={`band-${idx}`}
                      className="rvc-card__band"
                      style={{ left: x, width: w }}
                    />
                  );
                })
              : null}

            <svg
              className="rvc-card__svg"
              width={plotW}
              height={plotH}
              role="img"
              aria-label="Courbes de profil"
            >
              {/* Secondary curves — dashed. */}
              {secondarySeries.map(({ itinerary, samples }) => (
                <path
                  key={`sec-${itinerary.id}`}
                  d={samplesToPath(samples, xScale, y2Scale)}
                  fill="none"
                  stroke={itinerary.color}
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  opacity={0.85}
                />
              ))}
              {/* Primary curves — solid. */}
              {primarySeries.map(({ itinerary, samples }) => (
                <path
                  key={`pri-${itinerary.id}`}
                  d={samplesToPath(samples, xScale, y1Scale)}
                  fill="none"
                  stroke={itinerary.color}
                  strokeWidth={2}
                />
              ))}

              {/* Hover guide line. */}
              {hoverX !== null && plotW > 0 ? (
                <line
                  x1={xScale.toPx(hoverX)}
                  x2={xScale.toPx(hoverX)}
                  y1={0}
                  y2={plotH}
                  stroke="rgba(255,255,255,0.85)"
                  strokeWidth={1}
                  pointerEvents="none"
                />
              ) : null}
            </svg>

            {/* Markers (water droplets, waypoints…). */}
            {markers.map((m) => {
              if (m.x < xDomain[0] || m.x > xDomain[1]) return null;
              const owner = itineraries.find((it) => it.id === m.itineraryId);
              if (!owner || !owner.visible) return null;
              const x = xScale.toPx(m.x);
              const sample = sampleNear(owner.primary ?? [], m.x);
              const y = sample ? y1Scale.toPx(sample.y) : plotH / 2;
              return (
                <DropletMarker key={m.id} x={x} y={y} />
              );
            })}

            {/* Floating tooltip cards — only on hover, anchored top-right of
               the white guide line. */}
            {hoverX !== null && plotW > 0 ? (
              <ChartTooltipStack
                itineraries={itineraries}
                maxCards={3}
                hoverX={hoverX}
                hoverPx={xScale.toPx(hoverX)}
                plotW={plotW}
              />
            ) : null}
          </div>
        </div>

        {/* ───────────── X-axis row (numeric labels). ──────────────────── */}
        <Row
          leftLabel=""
          rightLabel=""
          cells={X_BINS}
          cellPct={cellPct}
          cellLabels={xLabels}
          xAxis
        />

        {/* ───────────── Temperature rows. ─────────────────────────────── */}
        {tempRows.map((it) => (
          <div
            key={`t-${it.id}`}
            className="rvc-card__row"
            style={{ '--cell-pct': `${cellPct}%` } as CSSProperties}
          >
            <div className="rvc-card__head rvc-card__head--temp">
              <span
                className="rvc-card__swatch"
                style={{ background: it.color }}
                aria-hidden
              />
              <Select
                value="measured"
                options={TEMP_MODE_OPTIONS}
                onChange={(v) => onChangeTemperatureMode?.(it.id, v)}
                ariaLabel={`Source de température pour ${it.name}`}
              />
            </div>
            <div className="rvc-card__cells">
              {Array.from({ length: X_BINS }).map((_, i) => {
                const isLast = i === X_BINS - 1;
                return (
                  <div
                    key={i}
                    className={`rvc-card__cell${isLast ? ' is-current' : ''}`}
                    style={{ width: `${cellPct}%` }}
                  >
                    {isLast ? (
                      <button
                        type="button"
                        className="rvc-card__row-trash"
                        aria-label={`Retirer la ligne ${it.name}`}
                        onClick={() => onRemoveTemperatureRow?.(it.id)}
                      >
                        <IconTrash size={12} />
                      </button>
                    ) : (
                      formatTemperature(it.temperaturesC?.[i] ?? null)
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {/* ───────────── Ajouter row. ──────────────────────────────────── */}
        <div
          className="rvc-card__row rvc-card__row--add"
          style={{ '--cell-pct': `${cellPct}%` } as CSSProperties}
        >
          <div className="rvc-card__head">
            <button
              type="button"
              className="rvc-card__add"
              onClick={onAddTemperatureRow}
              aria-label="Ajouter une ligne de température"
            >
              <IconPlusCircle size={12} />
              <span>Ajouter</span>
              <IconChevronDown size={14} />
            </button>
          </div>
          <div className="rvc-card__cells">
            {Array.from({ length: X_BINS }).map((_, i) => (
              <div
                key={i}
                className={`rvc-card__cell${i === X_BINS - 1 ? ' is-current' : ''}`}
                style={{ width: `${cellPct}%` }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Day/Night legend glyphs under the bottom-left corner. */}
      <div className="rvc-card__daynight-legend" aria-hidden>
        <span className="rvc-card__daynight-icon">
          <IconSun size={14} />
        </span>
        <span className="rvc-card__daynight-icon">
          <IconMoon size={14} />
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sub-components                                                             */
/* -------------------------------------------------------------------------- */

interface RowProps {
  leftLabel: string;
  rightLabel: string;
  cells: number;
  cellPct: number;
  cellLabels?: string[];
  xAxis?: boolean;
}

function Row({ leftLabel, rightLabel, cells, cellPct, cellLabels, xAxis }: RowProps) {
  return (
    <div className={`rvc-card__row${xAxis ? ' rvc-card__row--xaxis' : ''}`}>
      <div className="rvc-card__head rvc-card__head--ylabel">
        <span className="rvc-card__head-text">{leftLabel}</span>
      </div>
      <div className="rvc-card__cells">
        {Array.from({ length: cells }).map((_, i) => {
          const isLast = i === cells - 1;
          return (
            <div
              key={i}
              className={`rvc-card__cell${isLast ? ' is-current' : ''}`}
              style={{ width: `${cellPct}%` }}
            >
              {isLast ? (
                <span className="rvc-card__cell-right">{rightLabel}</span>
              ) : cellLabels ? (
                <span className="rvc-card__xtick">{cellLabels[i]}</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DropletMarker({ x, y }: { x: number; y: number }) {
  // 26 × 28 group with droplet inside a blue circle and a downward pointer.
  return (
    <div
      className="rvc-card__droplet"
      style={{ left: x - 13, top: y - 28 }}
      aria-hidden
    >
      <div className="rvc-card__droplet-bubble">
        <IconWaterDrop size={12} />
      </div>
      <div className="rvc-card__droplet-tip" />
    </div>
  );
}

interface TooltipStackProps {
  itineraries: CentralPanelItinerary[];
  hoverX: number;
  hoverPx: number;
  plotW: number;
  maxCards: number;
}

/**
 * Hover-only tooltip stack. Anchored to the right of the white guide line;
 * flips to the left if there isn't enough room in the plot area.
 */
function ChartTooltipStack({
  itineraries,
  hoverX,
  hoverPx,
  plotW,
  maxCards,
}: TooltipStackProps) {
  const visible = itineraries
    .filter((it) => it.visible && it.primary && it.primary.length > 0)
    .slice(0, maxCards);
  if (visible.length === 0) return null;

  // Rough width estimate so we can flip when overflowing the right edge.
  const estWidth = visible.length * 116 + 8;
  const gap = 6;
  const flip = hoverPx + gap + estWidth > plotW;
  const style: CSSProperties = flip
    ? { right: Math.max(4, plotW - hoverPx + gap), top: 4 }
    : { left: hoverPx + gap, top: 4 };

  return (
    <div className="rvc-card__tt" style={style}>
      {visible.map((it) => {
        const last = it.primary?.[it.primary.length - 1];
        const total = last?.x ?? 0;
        const x = hoverX ?? total;
        const ratio = total > 0 ? Math.max(0, Math.min(1, x / total)) : 0;
        const dist = it.stats.distanceKm ?? total;
        const gain = (it.stats.elevationGainM ?? 0) * ratio;
        const loss = (it.stats.elevationLossM ?? 0) * ratio;
        const dur = (it.stats.durationSec ?? 0) * ratio;
        return (
          <div key={it.id} className="rvc-card__tt-card">
            <span
              className="rvc-card__tt-swatch"
              style={{ background: it.color }}
              aria-hidden
            />
            <div className="rvc-card__tt-rows">
              <div>{formatDistanceKm(dist)} km</div>
              <div>{formatGain(gain)} m</div>
              <div>{formatLoss(loss)} m</div>
              <div>{formatDurationSpaced(dur)}</div>
              <div>J1 - 08:29</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function sampleNear(samples: { x: number; y: number }[], x: number) {
  if (samples.length === 0) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid].x < x) lo = mid + 1;
    else hi = mid;
  }
  return samples[lo];
}

/** Round a domain to a "nice" interval that divides evenly into `count` parts. */
function niceDomain(
  [min, max]: [number, number],
  count: number,
): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return [0, 1];
  }
  const span = max - min;
  const rough = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = norm < 1.5 ? 1 * mag : norm < 3 ? 2 * mag : norm < 7 ? 5 * mag : 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = lo + step * count;
  return [lo, hi];
}

function evenTicks([min, max]: [number, number], count: number): number[] {
  const out: number[] = [];
  const step = (max - min) / Math.max(1, count - 1);
  for (let i = 0; i < count; i += 1) out.push(min + step * i);
  return out;
}

/* Re-export icons used in CentralPanel for convenience (not strictly needed
   but keeps `IconDots` referenced when ZoomScrollbar imports indirectly). */
export { IconDots };
