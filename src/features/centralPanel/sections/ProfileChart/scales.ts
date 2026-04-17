/**
 * Pure helpers for the profile chart: scales, sample bounds, tick generation.
 *
 * Kept side-effect free so they can be unit-tested without a DOM.
 */
import type { CentralPanelItinerary, ProfileSample } from '../../types';

export interface Scale {
  /** Domain → pixels. */
  toPx: (v: number) => number;
  /** Pixels → domain. */
  toValue: (px: number) => number;
  /** [min, max] of the domain (post-padding). */
  domain: [number, number];
  /** [start, end] of the pixel range. */
  range: [number, number];
}

export function makeLinearScale(
  domain: [number, number],
  range: [number, number],
): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const pxSpan = r1 - r0;
  return {
    domain,
    range,
    toPx: (v) => r0 + ((v - d0) / span) * pxSpan,
    toValue: (px) => d0 + ((px - r0) / pxSpan) * span,
  };
}

/** Compute combined [min, max] across many series. */
export function seriesExtent(series: ProfileSample[][]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (let i = 0; i < s.length; i += 1) {
      const v = s[i].y;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min - 1, max + 1];
  return [min, max];
}

export function xExtent(series: ProfileSample[][]): [number, number] {
  let max = 0;
  for (const s of series) {
    if (s.length === 0) continue;
    const last = s[s.length - 1].x;
    if (last > max) max = last;
  }
  return [0, max || 100];
}

/**
 * "Pretty" tick generator: chooses a step from {1, 2, 5} × 10ⁿ so that the
 * tick count lands close to `targetCount`.
 */
export function makeTicks(
  domain: [number, number],
  targetCount: number,
): number[] {
  const [min, max] = domain;
  const span = max - min;
  if (span <= 0) return [min];
  const rawStep = span / Math.max(1, targetCount);
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const step =
    norm < 1.5 ? 1 * mag : norm < 3 ? 2 * mag : norm < 7 ? 5 * mag : 10 * mag;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.0001; v += step) {
    ticks.push(Math.round(v / step) * step);
  }
  return ticks;
}

/** Convert samples to an SVG path string ("M x0 y0 L x1 y1 …"). */
export function samplesToPath(
  samples: ProfileSample[],
  xScale: Scale,
  yScale: Scale,
): string {
  if (samples.length === 0) return '';
  let d = '';
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    d += i === 0 ? 'M' : 'L';
    d += ` ${xScale.toPx(s.x).toFixed(1)} ${yScale.toPx(s.y).toFixed(1)} `;
  }
  return d;
}

/** Pick the visible itineraries that have at least one sample. */
export function visibleSeries(
  itineraries: CentralPanelItinerary[],
  field: 'primary' | 'secondary',
): { itinerary: CentralPanelItinerary; samples: ProfileSample[] }[] {
  const out: { itinerary: CentralPanelItinerary; samples: ProfileSample[] }[] = [];
  for (const it of itineraries) {
    if (!it.visible) continue;
    const samples = it[field];
    if (!samples || samples.length === 0) continue;
    out.push({ itinerary: it, samples });
  }
  return out;
}
