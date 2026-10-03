// ============================================
// LiDAR viewer — ground profile card
// ============================================
//
// Altitude along the drawn line, filled with the avalanche slope classes.
// "1:1" draws it at true scale: profile charts usually stretch altitude 5
// to 20 times, which makes every slope look steeper than it is.

import { useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { translateAppText as t } from '@/shared/i18n/config';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import { formatAltitude, formatAngle, formatDistance, formatElevationDelta } from '../format';
import { SLOPE_BANDS, slopeBandOf } from '../terrain/slopeBands';
import type { ProfileSample } from '../terrain/profile';
import { CloseGlyph } from './glyphs';
import type { ProfileCardModel, ToolsUiActions } from './toolsUiStore';

/** Card width minus its padding: the chart keeps its aspect (true scale). */
const CHART_WIDTH = 536;
const CHART_HEIGHT = 140;
/** Columns drawn at most (one sample per column). */
const MAX_COLUMNS = 360;

interface ChartGeometry {
  x: (distanceM: number) => number;
  y: (altitudeM: number) => number;
  /** Distance at a chart abscissa. */
  distanceAt: (x: number) => number;
}

function chartGeometry(samples: readonly ProfileSample[], trueScale: boolean): ChartGeometry {
  const length = Math.max(1, samples[samples.length - 1]!.distanceM);
  let min = Infinity;
  let max = -Infinity;
  for (const s of samples) {
    min = Math.min(min, s.altitudeM);
    max = Math.max(max, s.altitudeM);
  }
  if (trueScale) {
    const scale = Math.min(CHART_WIDTH / length, CHART_HEIGHT / Math.max(1, max - min));
    return {
      x: (d) => d * scale,
      y: (a) => CHART_HEIGHT - (a - min) * scale,
      distanceAt: (x) => x / scale,
    };
  }
  const pad = Math.max(5, (max - min) * 0.08);
  const lo = min - pad;
  const range = max + pad - lo;
  return {
    x: (d) => (d / length) * CHART_WIDTH,
    y: (a) => CHART_HEIGHT - ((a - lo) / range) * CHART_HEIGHT,
    distanceAt: (x) => (x / CHART_WIDTH) * length,
  };
}

function decimateByDistance(samples: readonly ProfileSample[]): ProfileSample[] {
  if (samples.length <= MAX_COLUMNS) return [...samples];
  const length = samples[samples.length - 1]!.distanceM;
  const out: ProfileSample[] = [];
  let next = 0;
  for (const s of samples) {
    if (s.distanceM >= next) {
      out.push(s);
      next = s.distanceM + length / MAX_COLUMNS;
    }
  }
  if (out[out.length - 1] !== samples[samples.length - 1]) out.push(samples[samples.length - 1]!);
  return out;
}

function nearestSampleIndex(samples: readonly ProfileSample[], distanceM: number): number {
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.distanceM < distanceM) lo = mid;
    else hi = mid;
  }
  return distanceM - samples[lo]!.distanceM <= samples[hi]!.distanceM - distanceM ? lo : hi;
}

interface ProfileCardProps {
  model: ProfileCardModel;
  actions: ToolsUiActions;
}

export function ProfileCard({ model, actions }: ProfileCardProps) {
  const { profile } = model;
  const [trueScale, setTrueScale] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const geometry = useMemo(() => chartGeometry(profile.samples, trueScale), [profile, trueScale]);
  const { bands, line } = useMemo(() => {
    const columns = decimateByDistance(profile.samples);
    const base = CHART_HEIGHT;
    const runs: Array<{ color: string; d: string }> = [];
    for (let k = 0; k + 1 < columns.length; k++) {
      const a = columns[k]!;
      const b = columns[k + 1]!;
      const color = slopeBandOf(Math.abs(b.gradeDeg)).color;
      const quad = `M${geometry.x(a.distanceM)},${base}L${geometry.x(a.distanceM)},${geometry.y(a.altitudeM)}`
        + `L${geometry.x(b.distanceM)},${geometry.y(b.altitudeM)}L${geometry.x(b.distanceM)},${base}Z`;
      const last = runs[runs.length - 1];
      if (last && last.color === color) last.d += quad;
      else runs.push({ color, d: quad });
    }
    const path = columns
      .map((s, k) => `${k === 0 ? 'M' : 'L'}${geometry.x(s.distanceM).toFixed(1)},${geometry.y(s.altitudeM).toFixed(1)}`)
      .join('');
    return { bands: runs, line: path };
  }, [geometry, profile]);

  const hover = hoverIndex != null ? profile.samples[hoverIndex] : null;

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * CHART_WIDTH;
    const distance = Math.max(0, Math.min(profile.lengthM, geometry.distanceAt(x)));
    const index = nearestSampleIndex(profile.samples, distance);
    setHoverIndex(index);
    actions.hoverProfile(index);
  };
  const onPointerLeave = () => {
    setHoverIndex(null);
    actions.hoverProfile(null);
  };

  return (
    <div className="rv-lidar-profile" role="region" aria-label={t('Profil')}>
      <MapCanvasGlassBackdrop blur={40} saturate={1.4} tint="rgba(15, 15, 15, 0.74)" />
      <div className="rv-lidar-profile__header">
        <span className="rv-lidar-profile__title">{t('Profil')}</span>
        <span className="rv-lidar-profile__stats">
          {formatDistance(profile.lengthM)} · ↗ {formatElevationDelta(profile.gainM)} ↘ {formatElevationDelta(-profile.lossM)}
          {' · '}
          {t('pente max {{angle}}', { angle: formatAngle(profile.maxSlopeDeg) })}
        </span>
        <button
          type="button"
          className="rv-lidar-profile__toggle"
          aria-pressed={trueScale}
          onClick={() => setTrueScale((value) => !value)}
          title={t('Échelle réelle : 1 m horizontal = 1 m vertical')}
        >
          1:1
        </button>
        <button
          type="button"
          className="rv-lidar-ctx__icon-button"
          onClick={() => actions.closeProfile()}
          aria-label={t('Fermer le profil')}
          title={t('Fermer le profil')}
        >
          <CloseGlyph />
        </button>
      </div>

      <div className="rv-lidar-profile__chart">
        <span className="rv-lidar-profile__axis rv-lidar-profile__axis--top">{formatAltitude(profile.maxAltitudeM)}</span>
        <span className="rv-lidar-profile__axis rv-lidar-profile__axis--bottom">{formatAltitude(profile.minAltitudeM)}</span>
        {hover ? (
          <span className="rv-lidar-profile__readout">
            {formatDistance(hover.distanceM)} · {formatAltitude(hover.altitudeM)} · {formatAngle(Math.abs(hover.gradeDeg))}
          </span>
        ) : null}
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          role="img"
          aria-label={t('Profil')}
        >
          {bands.map((band, k) => (
            <path key={k} d={band.d} fill={band.color} fillOpacity={0.55} />
          ))}
          {profile.vertexDistancesM.slice(1, -1).map((d) => (
            <line
              key={d}
              x1={geometry.x(d)}
              x2={geometry.x(d)}
              y1={0}
              y2={CHART_HEIGHT}
              stroke="rgba(255,255,255,0.35)"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <path d={line} fill="none" stroke="#ffffff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          {hover ? (
            <>
              <line
                x1={geometry.x(hover.distanceM)}
                x2={geometry.x(hover.distanceM)}
                y1={0}
                y2={CHART_HEIGHT}
                stroke="#ffffff"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={geometry.x(hover.distanceM)} cy={geometry.y(hover.altitudeM)} r={3} fill="#ff2a1f" />
            </>
          ) : null}
        </svg>
      </div>

      <div className="rv-lidar-profile__legend" aria-hidden>
        {SLOPE_BANDS.map((band, k) => (
          <span key={band.minDeg} className="rv-lidar-profile__legend-item">
            <span className="rv-lidar-ctx__band" style={{ background: band.color }} />
            {k === 0 ? `< ${SLOPE_BANDS[1]!.minDeg}°` : k === SLOPE_BANDS.length - 1 ? `≥ ${band.minDeg}°` : `${band.minDeg}–${SLOPE_BANDS[k + 1]!.minDeg}°`}
          </span>
        ))}
      </div>
    </div>
  );
}
