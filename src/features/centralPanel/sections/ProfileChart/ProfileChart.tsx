/**
 * Profile chart — multi-series elevation/temperature/etc. plot.
 *
 * Pure SVG, zero dependencies. Renders:
 *  - Day/night background bands (merged across visible series)
 *  - Horizontal gridlines + Y axis labels (left = primary, right = secondary)
 *  - Sun/Moon overlay icons at top
 *  - Solid curves for the primary metric, dashed for the secondary
 *  - Markers (waypoint, POI, pause, alert) along curves
 *  - Vertical hover line + per-itinerary tooltip cards
 *  - X axis labels along the bottom (rendered by the panel, not here)
 */
import { useCallback, useMemo, useRef, useState } from 'react';

import { useElementSize } from '../../hooks/useElementSize';
import {
  IconMoon,
  IconPause,
  IconPoiPin,
  IconSun,
  IconWaypointMarker,
  IconAlertTriangle,
} from '../../components/icons';
import {
  PRIMARY_METRIC_OPTIONS,
  SECONDARY_METRIC_OPTIONS,
} from '../../defaultState';
import {
  formatClockHHMM,
  formatDayOffset,
  formatDistanceKm,
  formatDurationSpaced,
  formatGain,
  formatLoss,
} from '../../components/format';
import type {
  CentralPanelItinerary,
  ChartHoverPoint,
  ChartMarker,
  ChartMarkerKind,
  CentralPanelUiState,
  DayNightBand,
} from '../../types';
import {
  makeLinearScale,
  makeTicks,
  samplesToPath,
  seriesExtent,
  visibleSeries,
  xExtent,
} from './scales';

const PADDING = { top: 18, right: 56, bottom: 4, left: 56 };

interface ProfileChartProps {
  itineraries: CentralPanelItinerary[];
  ui: CentralPanelUiState;
  markers?: ChartMarker[];
  dayNight?: DayNightBand[];
  onHover?: (xValue: number | null) => void;
}

export function ProfileChart({
  itineraries,
  ui,
  markers = [],
  dayNight = [],
  onHover,
}: ProfileChartProps) {
  const { ref, size } = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);

  const w = Math.max(0, size.width);
  const h = Math.max(0, size.height);
  const innerW = Math.max(0, w - PADDING.left - PADDING.right);
  const innerH = Math.max(0, h - PADDING.top - PADDING.bottom);

  const primarySeries = useMemo(
    () => visibleSeries(itineraries, 'primary'),
    [itineraries],
  );
  const secondarySeries = useMemo(
    () => visibleSeries(itineraries, 'secondary'),
    [itineraries],
  );

  const xDomain = useMemo(() => {
    const all = [...primarySeries, ...secondarySeries].map((s) => s.samples);
    return ui.zoomRangeKm ?? xExtent(all);
  }, [primarySeries, secondarySeries, ui.zoomRangeKm]);

  const y1Domain = useMemo(
    () => seriesExtent(primarySeries.map((s) => s.samples)),
    [primarySeries],
  );
  const y2Domain = useMemo(
    () => seriesExtent(secondarySeries.map((s) => s.samples)),
    [secondarySeries],
  );

  const xScale = useMemo(
    () =>
      makeLinearScale(xDomain, [PADDING.left, PADDING.left + innerW]),
    [xDomain, innerW],
  );
  const y1Scale = useMemo(
    () => makeLinearScale(y1Domain, [PADDING.top + innerH, PADDING.top]),
    [y1Domain, innerH],
  );
  const y2Scale = useMemo(
    () => makeLinearScale(y2Domain, [PADDING.top + innerH, PADDING.top]),
    [y2Domain, innerH],
  );

  const y1Ticks = useMemo(() => makeTicks(y1Domain, 4), [y1Domain]);
  const y2Ticks = useMemo(() => makeTicks(y2Domain, 4), [y2Domain]);

  const handleMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const px = e.clientX - rect.left;
      if (px < PADDING.left || px > PADDING.left + innerW) {
        setHoverX(null);
        onHover?.(null);
        return;
      }
      const value = xScale.toValue(px);
      setHoverX(value);
      onHover?.(value);
    },
    [innerW, onHover, xScale],
  );

  const handleLeave = useCallback(() => {
    setHoverX(null);
    onHover?.(null);
  }, [onHover]);

  const primaryMetric = PRIMARY_METRIC_OPTIONS.find(
    (o) => o.value === ui.primaryMetric,
  );
  void primaryMetric;
  const secondaryMetric = SECONDARY_METRIC_OPTIONS.find(
    (o) => o.value === ui.secondaryMetric,
  );

  const showMarkers = (kind: ChartMarkerKind): boolean => {
    if (kind === 'waypoint') return ui.overlays.waypoint;
    if (kind === 'poi') return ui.overlays.poi;
    if (kind === 'pause') return ui.overlays.pause;
    if (kind === 'alert') return ui.overlays.alerts;
    return true;
  };

  const isEmpty = primarySeries.length === 0 && secondarySeries.length === 0;

  return (
    <div ref={ref} className="rvc-chart">
      <svg
        ref={svgRef}
        className="rvc-chart__svg"
        width={w}
        height={h}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        role="img"
        aria-label="Graphique de profil"
      >
        {/* Day / night vertical bands */}
        {ui.overlays.daynight
          ? dayNight.map((b, idx) => (
              <rect
                key={idx}
                x={xScale.toPx(b.fromX)}
                width={Math.max(0, xScale.toPx(b.toX) - xScale.toPx(b.fromX))}
                y={PADDING.top}
                height={innerH}
                fill={b.kind === 'night' ? 'rgba(20, 24, 40, 0.45)' : 'transparent'}
              />
            ))
          : null}

        {/* Horizontal gridlines (using primary ticks). Hidden when empty. */}
        {!isEmpty &&
          y1Ticks.map((t) => (
            <line
              key={`g-${t}`}
              x1={PADDING.left}
              x2={PADDING.left + innerW}
              y1={y1Scale.toPx(t)}
              y2={y1Scale.toPx(t)}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={1}
            />
          ))}

        {/* Y1 axis labels (left). Hidden when there's no primary data. */}
        {primarySeries.length > 0 &&
          y1Ticks.map((t) => (
            <text
              key={`y1-${t}`}
              x={PADDING.left - 8}
              y={y1Scale.toPx(t) + 4}
              textAnchor="end"
              className="rvc-chart__axis-label"
            >
              {Math.round(t)}
            </text>
          ))}

        {/* Y2 axis labels (right). Hidden when there's no secondary data. */}
        {secondarySeries.length > 0 &&
          y2Ticks.map((t) => (
            <text
              key={`y2-${t}`}
              x={PADDING.left + innerW + 8}
              y={y2Scale.toPx(t) + 4}
              textAnchor="start"
              className="rvc-chart__axis-label"
            >
              {Math.round(t)}
              {secondaryMetric?.unit ?? ''}
            </text>
          ))}

        {/* Sun / Moon overlay glyphs at top of day/night bands. */}
        {ui.overlays.daynight
          ? dayNight.map((b, idx) => {
              const cx = (xScale.toPx(b.fromX) + xScale.toPx(b.toX)) / 2;
              if (cx < PADDING.left || cx > PADDING.left + innerW) return null;
              return (
                <g
                  key={`dn-${idx}`}
                  transform={`translate(${cx - 8}, ${PADDING.top - 4})`}
                  className="rvc-chart__daynight-icon"
                >
                  {b.kind === 'day' ? (
                    <IconSun size={14} />
                  ) : (
                    <IconMoon size={14} />
                  )}
                </g>
              );
            })
          : null}

        {/* Secondary curves (dashed). */}
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

        {/* Primary curves (solid). */}
        {primarySeries.map(({ itinerary, samples }) => (
          <path
            key={`pri-${itinerary.id}`}
            d={samplesToPath(samples, xScale, y1Scale)}
            fill="none"
            stroke={itinerary.color}
            strokeWidth={2}
          />
        ))}

        {/* Markers along the primary curves. */}
        {markers.map((m) => {
          if (!showMarkers(m.kind)) return null;
          if (m.x < xDomain[0] || m.x > xDomain[1]) return null;
          const owner = itineraries.find((it) => it.id === m.itineraryId);
          if (!owner || !owner.visible) return null;
          const x = xScale.toPx(m.x);
          // Y positioning: ride the curve when y absent.
          let y: number;
          if (typeof m.y === 'number') y = y1Scale.toPx(m.y);
          else {
            const sample = sampleNear(owner.primary ?? [], m.x);
            y = sample ? y1Scale.toPx(sample.y) : PADDING.top + innerH / 2;
          }
          return (
            <g
              key={m.id}
              transform={`translate(${x - 6}, ${y - 12})`}
              className="rvc-chart__marker"
              style={{ color: owner.color }}
            >
              {markerGlyph(m.kind)}
            </g>
          );
        })}

        {/* Hover guide line. */}
        {hoverX !== null ? (
          <line
            x1={xScale.toPx(hoverX)}
            x2={xScale.toPx(hoverX)}
            y1={PADDING.top}
            y2={PADDING.top + innerH}
            stroke="rgba(255,255,255,0.85)"
            strokeWidth={1}
            pointerEvents="none"
          />
        ) : null}
      </svg>

      {/* Tooltip cards. Positioned absolutely over the SVG. */}
      {hoverX !== null && !isEmpty ? (
        <ChartTooltip
          itineraries={itineraries}
          xValue={hoverX}
          xPx={xScale.toPx(hoverX)}
          paddingTop={PADDING.top}
        />
      ) : null}

      {/* Empty state. */}
      {isEmpty ? (
        <div className="rvc-chart__empty">
          Aucun profil à afficher. Ajoutez ou calculez un itinéraire pour
          remplir le graphique.
        </div>
      ) : null}
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

function markerGlyph(kind: ChartMarkerKind) {
  switch (kind) {
    case 'waypoint':
      return <IconWaypointMarker size={14} />;
    case 'poi':
      return <IconPoiPin size={14} />;
    case 'pause':
      return <IconPause size={14} />;
    case 'alert':
      return <IconAlertTriangle size={14} />;
    case 'sun':
      return <IconSun size={14} />;
    case 'moon':
      return <IconMoon size={14} />;
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Tooltip                                                                    */
/* -------------------------------------------------------------------------- */

interface ChartTooltipProps {
  itineraries: CentralPanelItinerary[];
  xValue: number;
  xPx: number;
  paddingTop: number;
}

function ChartTooltip({
  itineraries,
  xValue,
  xPx,
  paddingTop,
}: ChartTooltipProps) {
  const cards: ChartHoverPoint[] = itineraries
    .filter((it) => it.visible && it.primary && it.primary.length > 0)
    .map((it) => {
      const last = it.primary?.[it.primary.length - 1];
      const totalDistance = last?.x ?? 0;
      const ratio = totalDistance > 0 ? xValue / totalDistance : 0;
      const dist = Math.max(0, Math.min(totalDistance, xValue));
      // Linear approximation of cumulative gain/loss from the available
      // stats — replaced by precise per-sample integrals once the engine
      // exposes them.
      const gain = (it.stats.elevationGainM ?? 0) * ratio;
      const loss = (it.stats.elevationLossM ?? 0) * ratio;
      const dur = (it.stats.durationSec ?? 0) * ratio;
      return {
        itineraryId: it.id,
        color: it.color,
        distanceKm: dist,
        elevationGainM: gain,
        elevationLossM: loss,
        durationSec: dur,
        dayOffset: 1,
        clockHHMM: '08:29',
      };
    });

  if (cards.length === 0) return null;

  const left = Math.round(xPx + 6);

  return (
    <div
      className="rvc-chart__tooltip"
      style={{ left, top: paddingTop }}
      role="tooltip"
    >
      {cards.map((c) => (
        <div key={c.itineraryId} className="rvc-chart__tooltip-card">
          <span
            className="rvc-chart__tooltip-swatch"
            style={{ background: c.color }}
            aria-hidden
          />
          <div className="rvc-chart__tooltip-rows">
            <div>{formatDistanceKm(c.distanceKm)} km</div>
            <div>{formatGain(c.elevationGainM)} m</div>
            <div>{formatLoss(c.elevationLossM)} m</div>
            <div>{formatDurationSpaced(c.durationSec)}</div>
            <div>
              {formatDayOffset(c.dayOffset)} - {formatClockHHMM(c.clockHHMM)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
