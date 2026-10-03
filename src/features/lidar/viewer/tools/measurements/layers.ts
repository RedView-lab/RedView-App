// ============================================
// LiDAR viewer tools — what each measurement draws
// ============================================
//
// Overlay primitives (lines, vertices, labels) and draped meshes of a
// measurement, built once when it is created; the overlay only reprojects
// them as the camera moves. Each label is one headline; its details show
// while the measurement is hovered.

import { translateAppText as t } from '@/shared/i18n/config';
import { classificationLabel } from '../classification';
import {
  formatAltitude,
  formatAngle,
  formatArea,
  formatAspect,
  formatDistance,
  formatElevationDelta,
  formatPercent,
} from '../format';
import { buildCellMesh, type OverlayMeshData } from '../overlay/cellMesh';
import { buildDrapedPolygonMesh } from '../overlay/polygonMesh';
import type { OverlayLabelTone, OverlayLayer, OverlayPath } from '../overlay/toolsOverlay';
import { ALPHA_EXPOSED_DEG, type AvalancheExposureLevel } from '../terrain/avalancheExposure';
import type { FallLineStop } from '../terrain/fallLine';
import type { ProfileResult } from '../terrain/profile';
import { slopeBandOf } from '../terrain/slopeBands';
import type { DrapedSample, TerrainField } from '../terrain/terrainField';
import type { ScenePick, ToolId, Vec3 } from '../types';
import type { Measurement } from './types';

/** Draped lines float this high above the ground model (m). */
const DRAPE_LIFT_M = 0.4;
/** Points drawn per draped line at most. */
const MAX_PATH_POINTS = 300;

export const TOOL_COLORS = {
  vertex: '#ff2a1f',
  distance: '#ffffff',
  height: '#4fc3f7',
  area: '#ffd54f',
  profile: '#ff2a1f',
  viewshed: '#3ecf8e',
  guide: 'rgba(255, 255, 255, 0.85)',
} as const;

const TONE_STROKE: Record<OverlayLabelTone, string> = {
  neutral: '#ffffff',
  ok: '#3ecf8e',
  warning: '#f5a524',
  danger: '#ff5a4f',
};

function emptyLayer(id: string): OverlayLayer {
  return { id, paths: [], dots: [], labels: [] };
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function distancePlan(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

function draped(field: TerrainField, s: { projX: number; projY: number; altitudeM: number }): Vec3 {
  return field.toLocal(s.projX, s.projY, s.altitudeM + DRAPE_LIFT_M);
}

function decimate<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const stride = (items.length - 1) / (max - 1);
  const out: T[] = [];
  for (let k = 0; k < max; k++) out.push(items[Math.round(k * stride)]!);
  return out;
}

function vertexDots(picks: readonly ScenePick[], color: string = TOOL_COLORS.vertex) {
  return picks.map((p) => ({ at: p.local, color, radius: 4 }));
}

/** Ground distance at horizontal distance `d` along draped samples (linear between samples). */
function surfaceDistanceAt(samples: readonly DrapedSample[], d: number): number {
  let lo = 0;
  let hi = samples.length - 1;
  if (d <= samples[0]!.distanceM) return samples[0]!.surfaceDistanceM;
  if (d >= samples[hi]!.distanceM) return samples[hi]!.surfaceDistanceM;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.distanceM < d) lo = mid;
    else hi = mid;
  }
  const a = samples[lo]!;
  const b = samples[hi]!;
  const f = (d - a.distanceM) / Math.max(1e-9, b.distanceM - a.distanceM);
  return a.surfaceDistanceM + (b.surfaceDistanceM - a.surfaceDistanceM) * f;
}

function gainLossLine(profile: ProfileResult): string {
  return `↗ ${formatElevationDelta(profile.gainM)}  ↘ ${formatElevationDelta(-profile.lossM)}`;
}

// ── Per measurement ─────────────────────────────────────────────────────────

export function measurementLayer(m: Measurement, field: TerrainField): OverlayLayer {
  switch (m.kind) {
    case 'distance':
      return distanceLayer(m.id, m.vertices, m.profile, field);
    case 'height':
      return heightLayer(m.id, m.a, m.b);
    case 'area':
      return areaLayer(m, field);
    case 'profile':
      return profileLayer(m, field);
    case 'fallLine':
      return fallLineLayer(m, field);
    case 'avalanche':
      return avalancheLayer(m, field);
    case 'viewshed':
      return viewshedLayer(m);
    case 'pin':
      return pinLayer(m.id, m.at);
  }
}

/** Draped surface of a measurement, for the renderer's analysis mesh. */
export function measurementMesh(m: Measurement, field: TerrainField): OverlayMeshData | null {
  switch (m.kind) {
    case 'avalanche': {
      const { grid, reachingCells, reachingAlphaDeg } = m.result;
      return buildCellMesh(field, grid, reachingCells, (k) => (reachingAlphaDeg[k]! >= ALPHA_EXPOSED_DEG
        ? [226, 52, 43, 115]
        : [242, 138, 46, 95]));
    }
    case 'viewshed': {
      const { grid, visible } = m.result;
      const cells: number[] = [];
      for (let i = 0; i < visible.length; i++) if (visible[i]) cells.push(i);
      return buildCellMesh(field, grid, cells, () => [62, 207, 142, 80]);
    }
    case 'area':
      return buildDrapedPolygonMesh(field, m.vertices, [255, 213, 79, 70]);
    default:
      return null;
  }
}

function distanceLayer(id: string, picks: readonly ScenePick[], profile: ProfileResult | null, field: TerrainField): OverlayLayer {
  const layer = emptyLayer(id);
  const last = picks[picks.length - 1]!;
  layer.dots.push(...vertexDots(picks));
  let direct = 0;
  let plan = 0;
  for (let k = 1; k < picks.length; k++) {
    direct += distance3(picks[k - 1]!.local, picks[k]!.local);
    plan += distancePlan(picks[k - 1]!.local, picks[k]!.local);
  }
  if (!profile) {
    layer.paths.push({ points: picks.map((p) => p.local), color: TOOL_COLORS.distance, width: 2 });
    layer.labels.push({ at: last.local, headline: formatDistance(direct), details: [t('{{distance}} à plat', { distance: formatDistance(plan) })] });
    return layer;
  }
  layer.paths.push({
    points: decimate(profile.samples, MAX_PATH_POINTS).map((s) => draped(field, s)),
    color: TOOL_COLORS.distance,
    width: 2,
  });
  if (picks.length > 2) {
    for (let k = 1; k < picks.length; k++) {
      const d0 = profile.vertexDistancesM[k - 1]!;
      const d1 = profile.vertexDistancesM[k]!;
      const ground = surfaceDistanceAt(profile.samples, d1) - surfaceDistanceAt(profile.samples, d0);
      layer.labels.push({ at: midpoint(picks[k - 1]!.local, picks[k]!.local), headline: formatDistance(ground), size: 'small' });
    }
  }
  layer.labels.push({
    at: last.local,
    headline: t('{{distance}} au sol', { distance: formatDistance(profile.surfaceLengthM) }),
    details: [
      `${t('{{distance}} à plat', { distance: formatDistance(plan) })} · ${t('direct {{distance}}', { distance: formatDistance(direct) })}`,
      gainLossLine(profile),
      t('Pente max {{angle}} (sur 10 m)', { angle: formatAngle(profile.maxSlopeDeg) }),
    ],
  });
  return layer;
}

function heightLayer(id: string, a: ScenePick, b: ScenePick): OverlayLayer {
  const layer = emptyLayer(id);
  const [low, high] = a.altitudeM <= b.altitudeM ? [a, b] : [b, a];
  const corner: Vec3 = [high.local[0], low.local[1], high.local[2]];
  const rise = high.altitudeM - low.altitudeM;
  const run = distancePlan(low.local, high.local);
  const angle = (Math.atan2(rise, run) * 180) / Math.PI;
  layer.paths.push({ points: [low.local, high.local], color: TOOL_COLORS.height, width: 2.5 });
  layer.paths.push({ points: [high.local, corner, low.local], color: TOOL_COLORS.guide, width: 1.5, dash: [6, 4] });
  layer.dots.push(...vertexDots([low, high], TOOL_COLORS.height));
  layer.labels.push({
    at: midpoint(low.local, high.local),
    headline: `Δh ${formatDistance(rise)} · ${formatAngle(angle, 1)}`,
    details: [
      `↔ ${formatDistance(run)} · ${t('direct {{distance}}', { distance: formatDistance(distance3(low.local, high.local)) })}`,
      `${formatAltitude(low.altitudeM)} → ${formatAltitude(high.altitudeM)}`,
    ],
    tone: angle >= 45 ? 'danger' : angle >= 30 ? 'warning' : 'neutral',
  });
  return layer;
}

function areaLayer(m: Measurement & { kind: 'area' }, field: TerrainField): OverlayLayer {
  const layer = emptyLayer(m.id);
  const ring = [...m.vertices, m.vertices[0]!];
  const outline = field.drape(ring, field.cell);
  layer.paths.push({
    points: outline.length > 1 ? decimate(outline, MAX_PATH_POINTS * 2).map((s) => draped(field, s)) : ring.map((p) => p.local),
    color: TOOL_COLORS.area,
    width: 2,
  });
  layer.dots.push(...vertexDots(m.vertices, TOOL_COLORS.area));
  let cx = 0;
  let cy = 0;
  for (const v of m.vertices) {
    cx += v.projX / m.vertices.length;
    cy += v.projY / m.vertices.length;
  }
  const centroidAltitude = field.altitudeAt(cx, cy) ?? m.vertices[0]!.altitudeM;
  const at = field.toLocal(cx, cy, centroidAltitude + DRAPE_LIFT_M);
  const stats = m.stats;
  if (!stats) {
    layer.labels.push({ at, headline: t('Hors de la zone chargée'), tone: 'warning' });
    return layer;
  }
  layer.labels.push({
    at,
    headline: `${formatArea(stats.planAreaM2)} · ${t('pente moy. {{angle}}', { angle: formatAngle(stats.meanSlopeDeg) })}`,
    details: [
      `${t('{{area}} au sol', { area: formatArea(stats.surfaceAreaM2) })} · ${t('périmètre {{distance}}', { distance: formatDistance(stats.perimeterM) })}`,
      `≥30° ${formatPercent(stats.shareAbove[30])} · ≥35° ${formatPercent(stats.shareAbove[35])} · ≥40° ${formatPercent(stats.shareAbove[40])} · ≥45° ${formatPercent(stats.shareAbove[45])}`,
      `${stats.dominantAspectDeg != null ? `${t('Orientation {{aspect}}', { aspect: formatAspect(stats.dominantAspectDeg) })} · ` : ''}${formatAltitude(stats.minAltitudeM)} – ${formatAltitude(stats.maxAltitudeM)}`,
    ],
    tone: stats.shareAbove[35] >= 0.25 ? 'warning' : 'neutral',
  });
  return layer;
}

function profileLayer(m: Measurement & { kind: 'profile' }, field: TerrainField): OverlayLayer {
  const layer = emptyLayer(m.id);
  layer.paths.push({
    points: decimate(m.profile.samples, MAX_PATH_POINTS).map((s) => draped(field, s)),
    color: TOOL_COLORS.profile,
    width: 2.5,
  });
  layer.dots.push(...vertexDots(m.vertices));
  layer.labels.push({
    at: m.vertices[m.vertices.length - 1]!.local,
    headline: t('Profil {{distance}}', { distance: formatDistance(m.profile.lengthM) }),
    details: [gainLossLine(m.profile), t('Pente max {{angle}} (sur 10 m)', { angle: formatAngle(m.profile.maxSlopeDeg) })],
  });
  return layer;
}

const FALL_LINE_STOP_LABELS: Record<FallLineStop, string> = {
  runout: 'Arrêt sur un replat',
  trap: 'Arrêt dans un creux (piège)',
  edge: 'Sort de la zone chargée',
  maxLength: 'Limite de 4 km atteinte',
};

function fallLineLayer(m: Measurement & { kind: 'fallLine' }, field: TerrainField): OverlayLayer {
  const layer = emptyLayer(m.id);
  const { result } = m;
  const samples = decimate(result.samples, MAX_PATH_POINTS);
  const path: OverlayPath = {
    points: samples.map((s) => draped(field, s)),
    color: samples.slice(1).map((s, k) => slopeBandOf(Math.max(s.slopeDeg, samples[k]!.slopeDeg)).color),
    width: 3,
  };
  layer.paths.push(path);
  const start = path.points[0]!;
  const end = path.points[path.points.length - 1]!;
  layer.dots.push({ at: start, color: '#ffffff', radius: 4 }, { at: end, color: '#111111', radius: 4 });

  const severe = result.maxSlopeDeg >= 45 || result.maxCliffDropM > 0 || result.stop === 'trap';
  const details = [
    t(FALL_LINE_STOP_LABELS[result.stop]),
    `${t('angle moyen {{angle}}', { angle: formatAngle(result.pathAngleDeg) })} · ${t('Pente max {{angle}} (sur 10 m)', { angle: formatAngle(result.maxSlopeDeg) })}`,
  ];
  if (result.maxCliffDropM > 0) details.push(t('Barre rocheuse de {{height}}', { height: formatDistance(result.maxCliffDropM) }));
  // At the clicked point: the end is often far away, or off screen.
  layer.labels.push({
    at: start,
    headline: `${t('Ligne de pente')} · ${formatDistance(result.lengthM)} · ${formatElevationDelta(-result.dropM)}`,
    details,
    tone: severe ? 'danger' : 'warning',
  });
  return layer;
}

const AVALANCHE_HEADLINES: Record<AvalancheExposureLevel, string> = {
  exposed: 'Avalanche : exposé',
  possible: 'Avalanche : portée possible',
  low: 'Avalanche : hors de portée',
  none: 'Avalanche : aucune zone de départ',
};

const AVALANCHE_EXPLANATIONS: Record<AvalancheExposureLevel, string> = {
  exposed: 'Sous une zone de départ (α ≥ 24°)',
  possible: 'À portée d’une grosse avalanche (α 20–24°)',
  low: 'Hors de portée estimée (α < 20°)',
  none: 'Aucune pente de départ en amont dans la zone chargée',
};

const AVALANCHE_TONES: Record<AvalancheExposureLevel, OverlayLabelTone> = {
  exposed: 'danger',
  possible: 'warning',
  low: 'ok',
  none: 'ok',
};

function avalancheLayer(m: Measurement & { kind: 'avalanche' }, field: TerrainField): OverlayLayer {
  const layer = emptyLayer(m.id);
  const { result, origin } = m;
  const tone = result.inReleaseArea && result.level !== 'exposed' ? 'warning' : AVALANCHE_TONES[result.level];
  const at = field.toLocal(origin.projX, origin.projY, (origin.groundAltitudeM ?? origin.altitudeM) + DRAPE_LIFT_M);
  layer.dots.push({ at, color: TONE_STROKE[tone], radius: 5 });
  if (result.source && result.maxAlphaDeg != null) {
    const source = field.toLocal(result.source.projX, result.source.projY, result.source.altitudeM + DRAPE_LIFT_M);
    const color = TONE_STROKE[AVALANCHE_TONES[result.level]];
    layer.paths.push({ points: [at, source], color, width: 2, dash: [8, 5] });
    layer.dots.push({ at: source, color, radius: 3 });
  }
  const details = [t(AVALANCHE_EXPLANATIONS[result.level])];
  if (result.reachingZoneCount > 0) {
    details.push(t('{{count}} zone(s) de départ l’atteignent · {{area}}', {
      count: result.reachingZoneCount,
      area: formatArea(result.reachingAreaM2),
    }));
  }
  if (result.inReleaseArea) details.push(t('Ce point est lui-même dans une pente de départ'));
  details.push(t('Modèle α–β : ni forêt, ni manteau neigeux'));
  layer.labels.push({
    at,
    headline: result.maxAlphaDeg != null
      ? `${t(AVALANCHE_HEADLINES[result.level])} · α ${formatAngle(result.maxAlphaDeg, 1)}`
      : t(AVALANCHE_HEADLINES[result.level]),
    details,
    tone,
  });
  return layer;
}

function viewshedLayer(m: Measurement & { kind: 'viewshed' }): OverlayLayer {
  const layer = emptyLayer(m.id);
  const { result, origin } = m;
  layer.dots.push({ at: origin.local, color: TOOL_COLORS.viewshed, radius: 5 });
  layer.labels.push({
    at: origin.local,
    headline: `${t('Zones visibles')} · ${formatArea(result.visibleAreaM2)}`,
    details: [
      t('{{share}} de la zone chargée', { share: formatPercent(result.visibleRatio) }),
      t('Jusqu’à {{distance}} · œil à 1,7 m', { distance: formatDistance(result.farthestM) }),
    ],
    tone: 'ok',
  });
  return layer;
}

function pinLayer(id: string, at: ScenePick): OverlayLayer {
  const layer = emptyLayer(id);
  layer.dots.push({ at: at.local, color: TOOL_COLORS.vertex, radius: 5 });
  const details: string[] = [];
  if (at.source === 'points' && at.classification != null) {
    details.push(t(classificationLabel(at.classification)));
    if (at.groundAltitudeM != null && at.altitudeM - at.groundAltitudeM >= 0.5) {
      details.push(t('{{height}} au-dessus du sol', { height: formatDistance(at.altitudeM - at.groundAltitudeM) }));
    }
  }
  layer.labels.push({ at: at.local, headline: formatAltitude(at.altitudeM), details });
  return layer;
}

// ── While drawing ───────────────────────────────────────────────────────────

/** Vertices placed so far plus the rubber band to the cursor. */
export function draftLayer(tool: ToolId, picks: readonly ScenePick[], hover: ScenePick | null): OverlayLayer {
  const layer = emptyLayer('');
  const color = tool === 'area' ? TOOL_COLORS.area : tool === 'height' ? TOOL_COLORS.height : tool === 'profile' ? TOOL_COLORS.profile : TOOL_COLORS.distance;
  const points = picks.map((p) => p.local);
  if (points.length > 1) layer.paths.push({ points, color, width: 2 });
  layer.dots.push(...vertexDots(picks));
  if (hover) {
    layer.dots.push({ at: hover.local, color: 'rgba(255, 255, 255, 0.9)', radius: 3 });
    const last = points[points.length - 1];
    if (last) {
      layer.paths.push({ points: [last, hover.local], color, width: 1.5, dash: [5, 4] });
      if (tool === 'area' && points.length >= 2) {
        layer.paths.push({ points: [hover.local, points[0]!], color, width: 1, dash: [3, 4] });
      }
      const headline = tool === 'height'
        ? `Δh ${formatElevationDelta(hover.altitudeM - picks[picks.length - 1]!.altitudeM)} · ↔ ${formatDistance(distancePlan(last, hover.local))}`
        : formatDistance(distance3(last, hover.local));
      layer.labels.push({ at: midpoint(last, hover.local), headline, size: 'small' });
    }
  }
  return layer;
}
