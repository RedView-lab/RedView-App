import { haversineRouteDistanceM } from '../routes';
import { isStyledSurface } from '../route-metrics/surface';
import type { Surface } from '../route-metrics/types';

export interface RouteLayerPoint {
  lat: number;
  lon: number;
  distanceM?: number | null;
  elevationM?: number | null;
  gradientPct?: number | null;
  surface?: Surface;
}

export interface RouteSlopeBand {
  id: string;
  minDeg: number;
  maxDeg: number;
  color: string;
}

type RouteRenderMode = 'default' | 'slope' | 'speedEst';

export interface RouteLayerOptions {
  color: string;
  opacity01: number;
  visible: boolean;
  traceWidthPx?: number;
  renderMode?: RouteRenderMode;
  slopeBands?: ReadonlyArray<RouteSlopeBand>;
}

export interface RouteLayerRenderSpec {
  data: GeoJSON.Feature<GeoJSON.LineString> | GeoJSON.FeatureCollection<GeoJSON.LineString>;
  lineColorPaint: string | unknown[];
  lineGradientPaint: unknown[] | null;
  lineBorderColorPaint: string | unknown[];
  lineBorderWidthPx: number;
  casingColorPaint: string | unknown[] | null;
  casingWidthPx: number;
  casingFilter: unknown[] | null;
  accentColorPaint: string | unknown[] | null;
  accentWidthPx: number;
  accentDasharray: number[] | null;
  accentFilter: unknown[] | null;
  accentCap: 'butt' | 'round';
  overlayColorPaint: string | unknown[] | null;
  overlayWidthPx: number;
  overlayDasharray: number[] | null;
  overlayFilter: unknown[] | null;
  overlayCap: 'butt' | 'round';
  textureColorPaint: string | unknown[] | null;
  textureWidthPx: number;
  textureDasharray: number[] | null;
  textureFilter: unknown[] | null;
  textureCap: 'butt' | 'round';
  requiresLineMetrics: boolean;
}

const ROUTE_SLOPE_TARGET_SEGMENT_M = 10;
const ROUTE_MIN_SEGMENT_DISTANCE_M = 0.5;
const ROUTE_PAVED_DASHARRAY = [1.35, 0.7];
const ROUTE_GRAVEL_DASHARRAY = [0.95, 0.95];
const ROUTE_DIRT_DASHARRAY = [0.42, 1.1];
const ROUTE_TRANSPARENT_COLOR = 'rgba(0,0,0,0)';

interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

type StyledSurface = 'paved' | 'gravel' | 'dirt' | 'unknown';

export function normalizeTraceWidthPx(value: number | null | undefined): number {
  return Math.max(8, Math.min(20, Math.round(value ?? 8)));
}

export function inferMountedRouteUsesLineGradient(
  map: { getLayer(id: string): unknown; getPaintProperty(id: string, property: string): unknown },
  layerId: string,
): boolean | null {
  try {
    if (!map.getLayer(layerId)) return null;
    return map.getPaintProperty(layerId, 'line-gradient') != null;
  } catch {
    return null;
  }
}

function tarmacBorderWidthPx(traceWidthPx: number): number {
  return Math.max(1.25, Math.min(3.25, traceWidthPx * 0.22));
}

function pavedPatternWidthPx(traceWidthPx: number): number {
  return Math.max(2.8, Math.min(6, traceWidthPx * 0.7));
}

function gravelPatternWidthPx(traceWidthPx: number): number {
  return Math.max(2.1, Math.min(4.4, traceWidthPx * 0.42));
}

function dirtPatternWidthPx(traceWidthPx: number): number {
  return Math.max(1.7, Math.min(3.4, traceWidthPx * 0.28));
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseHexColor(color: string): RgbColor | null {
  const normalized = color.trim();
  if (/^#[0-9a-f]{3}$/i.test(normalized)) {
    return {
      red: Number.parseInt(normalized[1] + normalized[1], 16),
      green: Number.parseInt(normalized[2] + normalized[2], 16),
      blue: Number.parseInt(normalized[3] + normalized[3], 16),
    };
  }
  if (/^#[0-9a-f]{6}$/i.test(normalized)) {
    return {
      red: Number.parseInt(normalized.slice(1, 3), 16),
      green: Number.parseInt(normalized.slice(3, 5), 16),
      blue: Number.parseInt(normalized.slice(5, 7), 16),
    };
  }
  return null;
}

function formatRgbColor(color: RgbColor): string {
  const toHex = (value: number) => clampByte(value).toString(16).padStart(2, '0');
  return `#${toHex(color.red)}${toHex(color.green)}${toHex(color.blue)}`;
}

function mixRgbColors(base: RgbColor, target: RgbColor, amount: number): RgbColor {
  const t = Math.max(0, Math.min(1, amount));
  return {
    red: clampByte(base.red + ((target.red - base.red) * t)),
    green: clampByte(base.green + ((target.green - base.green) * t)),
    blue: clampByte(base.blue + ((target.blue - base.blue) * t)),
  };
}

function tintUserColor(color: string, amount: number): string {
  const parsed = parseHexColor(color);
  if (!parsed) return color;
  return formatRgbColor(mixRgbColors(parsed, { red: 255, green: 255, blue: 255 }, amount));
}

function shadeUserColor(color: string, amount: number): string {
  const parsed = parseHexColor(color);
  if (!parsed) return color;
  return formatRgbColor(mixRgbColors(parsed, { red: 0, green: 0, blue: 0 }, amount));
}

function clampSlopeDeg(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-90, Math.min(90, value));
}

function interpolateNumber(a: number, b: number, t: number): number {
  return a + ((b - a) * t);
}

function interpolateOptionalNumber(a: number | null | undefined, b: number | null | undefined, t: number): number | null {
  if (Number.isFinite(a) && Number.isFinite(b)) {
    return interpolateNumber(a as number, b as number, t);
  }
  if (Number.isFinite(a)) return a as number;
  if (Number.isFinite(b)) return b as number;
  return null;
}

function buildDefaultRouteGeoJson(
  points: readonly RouteLayerPoint[],
): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: points.map((point) => [point.lon, point.lat] as [number, number]),
    },
  };
}

function resolveSegmentDistanceM(start: RouteLayerPoint, end: RouteLayerPoint): number {
  const startDistance = start.distanceM;
  const endDistance = end.distanceM;
  if (Number.isFinite(startDistance) && Number.isFinite(endDistance)) {
    const delta = (endDistance as number) - (startDistance as number);
    if (delta > ROUTE_MIN_SEGMENT_DISTANCE_M) return delta;
  }
  return haversineRouteDistanceM(start, end);
}

function resolveSlopeDeg(start: RouteLayerPoint, end: RouteLayerPoint, distanceM: number): number {
  if (!(distanceM > ROUTE_MIN_SEGMENT_DISTANCE_M)) return 0;

  if (Number.isFinite(start.elevationM) && Number.isFinite(end.elevationM)) {
    const riseM = (end.elevationM as number) - (start.elevationM as number);
    return clampSlopeDeg((Math.atan(riseM / distanceM) * 180) / Math.PI);
  }

  const gradientCandidates = [start.gradientPct, end.gradientPct]
    .filter((value): value is number => Number.isFinite(value));

  if (gradientCandidates.length === 0) return 0;

  const avgGradientPct = gradientCandidates.reduce((sum, value) => sum + value, 0) / gradientCandidates.length;
  return clampSlopeDeg((Math.atan(avgGradientPct / 100) * 180) / Math.PI);
}

interface RouteSamplePoint {
  lon: number;
  lat: number;
  distanceM: number;
  elevationM: number | null;
  gradientPct: number | null;
}

function buildRouteSlopeSamples(points: readonly RouteLayerPoint[]): RouteSamplePoint[] {
  if (points.length === 0) return [];

  const samples: RouteSamplePoint[] = [];
  let cumulativeDistanceM = 0;

  const pushSample = (sample: RouteSamplePoint) => {
    const last = samples[samples.length - 1];
    if (
      last
      && Math.abs(last.distanceM - sample.distanceM) < 1e-6
      && last.lon === sample.lon
      && last.lat === sample.lat
    ) {
      samples[samples.length - 1] = sample;
      return;
    }
    samples.push(sample);
  };

  pushSample({
    lon: points[0].lon,
    lat: points[0].lat,
    distanceM: 0,
    elevationM: Number.isFinite(points[0].elevationM) ? (points[0].elevationM as number) : null,
    gradientPct: Number.isFinite(points[0].gradientPct) ? (points[0].gradientPct as number) : null,
  });

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segmentDistanceM = resolveSegmentDistanceM(start, end);
    if (!(segmentDistanceM > ROUTE_MIN_SEGMENT_DISTANCE_M)) continue;

    const subdivisionCount = Math.max(1, Math.ceil(segmentDistanceM / ROUTE_SLOPE_TARGET_SEGMENT_M));
    for (let partIndex = 1; partIndex <= subdivisionCount; partIndex += 1) {
      const t = partIndex / subdivisionCount;
      const targetDistanceM = cumulativeDistanceM + (segmentDistanceM * t);
      pushSample({
        lon: interpolateNumber(start.lon, end.lon, t),
        lat: interpolateNumber(start.lat, end.lat, t),
        distanceM: targetDistanceM,
        elevationM: interpolateOptionalNumber(start.elevationM, end.elevationM, t),
        gradientPct: interpolateOptionalNumber(start.gradientPct, end.gradientPct, t),
      });
    }

    cumulativeDistanceM += segmentDistanceM;
  }

  return samples;
}

function pickSlopeBand(
  bands: ReadonlyArray<RouteSlopeBand>,
  slopeDeg: number,
): RouteSlopeBand | null {
  if (bands.length === 0) return null;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const isLast = index === bands.length - 1;
    if (slopeDeg >= band.minDeg && (slopeDeg < band.maxDeg || isLast)) {
      return band;
    }
  }
  return bands[bands.length - 1] ?? null;
}

function buildUniformRouteGradientPaint(color: string): unknown[] {
  return ['interpolate', ['linear'], ['line-progress'], 0, color, 1, color];
}

function normalizeSurfaceForStyle(surface: Surface): StyledSurface {
  if (surface === 'sand') return 'dirt';
  if (surface === 'paved' || surface === 'gravel' || surface === 'dirt') return surface;
  return 'unknown';
}

function resolveSegmentSurface(start: RouteLayerPoint, end: RouteLayerPoint): Surface {
  return end.surface ?? start.surface ?? 'unknown';
}

function hasStyledSurface(points: readonly RouteLayerPoint[]): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const surface = normalizeSurfaceForStyle(resolveSegmentSurface(points[index - 1], points[index]));
    if (isStyledSurface(surface)) return true;
  }
  return false;
}

function hasSurface(points: readonly RouteLayerPoint[], targetSurface: StyledSurface): boolean {
  for (let index = 1; index < points.length; index += 1) {
    if (normalizeSurfaceForStyle(resolveSegmentSurface(points[index - 1], points[index])) === targetSurface) return true;
  }
  return false;
}

function resolveSurfaceFillColor(surface: StyledSurface, fallbackColor: string): string {
  if (surface === 'paved') return shadeUserColor(fallbackColor, 0.72);
  if (surface === 'gravel') return tintUserColor(fallbackColor, 0.88);
  if (surface === 'dirt') return tintUserColor(fallbackColor, 0.8);
  return fallbackColor;
}

function resolveSurfaceBorderColor(surface: StyledSurface, fallbackColor: string): string {
  if (surface === 'paved') return tintUserColor(fallbackColor, 0.82);
  if (surface === 'gravel') return tintUserColor(fallbackColor, 0.9);
  if (surface === 'dirt') return shadeUserColor(fallbackColor, 0.58);
  return ROUTE_TRANSPARENT_COLOR;
}

function resolveSurfacePatternColor(surface: 'paved' | 'gravel' | 'dirt', fallbackColor: string): string {
  if (surface === 'paved') return tintUserColor(fallbackColor, 0.92);
  if (surface === 'gravel') return shadeUserColor(fallbackColor, 0.84);
  if (surface === 'dirt') return shadeUserColor(fallbackColor, 0.84);
  return shadeUserColor(fallbackColor, 0.84);
}

interface SurfaceRouteFeatureProperties {
  surface: StyledSurface;
  lineColor: string;
  casingColor: string;
}

function buildSurfaceRouteFeatureProperties(
  surface: Surface,
  fallbackColor: string,
): SurfaceRouteFeatureProperties {
  const styledSurface = normalizeSurfaceForStyle(surface);
  return {
    surface: styledSurface,
    lineColor: resolveSurfaceFillColor(styledSurface, fallbackColor),
    casingColor: resolveSurfaceBorderColor(styledSurface, fallbackColor),
  };
}

function buildSurfaceColorExpression(property: 'lineColor' | 'casingColor', fallbackColor: string): unknown[] {
  return ['coalesce', ['get', property], fallbackColor];
}

function buildStyledSurfaceFilter(): unknown[] {
  return ['in', ['get', 'surface'], ['literal', ['paved', 'gravel', 'dirt']]];
}

function surfaceFeaturePropertiesEqual(
  left: SurfaceRouteFeatureProperties,
  right: SurfaceRouteFeatureProperties,
): boolean {
  return left.surface === right.surface;
}

function buildSurfaceRouteFeature(
  points: readonly RouteLayerPoint[],
  startIndex: number,
  endIndex: number,
  properties: SurfaceRouteFeatureProperties,
): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: 'Feature',
    properties,
    geometry: {
      type: 'LineString',
      coordinates: points
        .slice(startIndex, endIndex + 1)
        .map((point) => [point.lon, point.lat] as [number, number]),
    },
  };
}

function buildSurfaceRouteGeoJson(
  points: readonly RouteLayerPoint[],
  fallbackColor: string,
): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  if (points.length < 2) {
    return {
      type: 'FeatureCollection',
      features: [],
    };
  }

  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  let runStartIndex = 0;
  let runProperties = buildSurfaceRouteFeatureProperties(
    resolveSegmentSurface(points[0], points[1]),
    fallbackColor,
  );

  for (let index = 2; index < points.length; index += 1) {
    const nextProperties = buildSurfaceRouteFeatureProperties(
      resolveSegmentSurface(points[index - 1], points[index]),
      fallbackColor,
    );
    if (surfaceFeaturePropertiesEqual(runProperties, nextProperties)) continue;

    features.push(buildSurfaceRouteFeature(points, runStartIndex, index - 1, runProperties));
    runStartIndex = index - 1;
    runProperties = nextProperties;
  }

  features.push(buildSurfaceRouteFeature(points, runStartIndex, points.length - 1, runProperties));
  return {
    type: 'FeatureCollection',
    features,
  };
}

function buildSlopeRouteGradientPaint(
  samples: readonly RouteSamplePoint[],
  bands: ReadonlyArray<RouteSlopeBand>,
  fallbackColor: string,
): unknown[] {
  if (samples.length < 2) return buildUniformRouteGradientPaint(fallbackColor);

  const totalDistanceM = samples[samples.length - 1]?.distanceM ?? 0;
  if (!(totalDistanceM > ROUTE_MIN_SEGMENT_DISTANCE_M)) {
    return buildUniformRouteGradientPaint(fallbackColor);
  }

  let currentColor = fallbackColor;
  for (let index = 1; index < samples.length; index += 1) {
    const start = samples[index - 1];
    const end = samples[index];
    const segmentDistanceM = end.distanceM - start.distanceM;
    if (!(segmentDistanceM > ROUTE_MIN_SEGMENT_DISTANCE_M)) continue;
    const segmentSlopeDeg = resolveSlopeDeg(start, end, segmentDistanceM);
    currentColor = pickSlopeBand(bands, segmentSlopeDeg)?.color ?? fallbackColor;
    break;
  }

  const expr: unknown[] = ['interpolate', ['linear'], ['line-progress'], 0, currentColor];
  let lastColor = currentColor;
  let lastStopProgress = 0;

  const pushStop = (progress: number, color: string) => {
    if (!(progress > lastStopProgress + 1e-6)) return;
    expr.push(progress, color);
    lastStopProgress = progress;
  };

  for (let index = 1; index < samples.length; index += 1) {
    const start = samples[index - 1];
    const end = samples[index];
    const segmentDistanceM = end.distanceM - start.distanceM;
    if (!(segmentDistanceM > ROUTE_MIN_SEGMENT_DISTANCE_M)) continue;

    const segmentSlopeDeg = resolveSlopeDeg(start, end, segmentDistanceM);
    const segmentColor = pickSlopeBand(bands, segmentSlopeDeg)?.color ?? fallbackColor;
    if (segmentColor === lastColor) continue;

    const startProgress = Math.max(0, Math.min(1, start.distanceM / totalDistanceM));
    const endProgress = Math.max(0, Math.min(1, end.distanceM / totalDistanceM));
    if (!(endProgress > startProgress)) continue;

    pushStop(startProgress, lastColor);
    pushStop(endProgress, segmentColor);
    lastColor = segmentColor;
  }

  pushStop(1, lastColor);
  return expr;
}

function buildSlopeRouteRenderSpec(
  points: readonly RouteLayerPoint[],
  bands: ReadonlyArray<RouteSlopeBand>,
  fallbackColor: string,
): RouteLayerRenderSpec {
  const samples = buildRouteSlopeSamples(points);
  return {
    data: buildDefaultRouteGeoJson(points),
    lineColorPaint: fallbackColor,
    lineGradientPaint: buildSlopeRouteGradientPaint(samples, bands, fallbackColor),
    lineBorderColorPaint: ROUTE_TRANSPARENT_COLOR,
    lineBorderWidthPx: 0,
    casingColorPaint: null,
    casingWidthPx: 0,
    casingFilter: null,
    accentColorPaint: null,
    accentWidthPx: 0,
    accentDasharray: null,
    accentFilter: null,
    accentCap: 'butt',
    overlayColorPaint: null,
    overlayWidthPx: 0,
    overlayDasharray: null,
    overlayFilter: null,
    overlayCap: 'butt',
    textureColorPaint: null,
    textureWidthPx: 0,
    textureDasharray: null,
    textureFilter: null,
    textureCap: 'round',
    requiresLineMetrics: true,
  };
}

function buildSurfaceRouteRenderSpec(
  points: readonly RouteLayerPoint[],
  fallbackColor: string,
  traceWidthPx: number,
): RouteLayerRenderSpec {
  const borderWidthPx = tarmacBorderWidthPx(traceWidthPx);
  const pavedPresent = hasSurface(points, 'paved');
  const gravelPresent = hasSurface(points, 'gravel');
  const dirtPresent = hasSurface(points, 'dirt');
  return {
    data: buildSurfaceRouteGeoJson(points, fallbackColor),
    lineColorPaint: buildSurfaceColorExpression('lineColor', fallbackColor),
    lineGradientPaint: null,
    lineBorderColorPaint: ROUTE_TRANSPARENT_COLOR,
    lineBorderWidthPx: 0,
    casingColorPaint: buildSurfaceColorExpression('casingColor', ROUTE_TRANSPARENT_COLOR),
    casingWidthPx: traceWidthPx + (borderWidthPx * 2),
    casingFilter: buildStyledSurfaceFilter(),
    accentColorPaint: pavedPresent
      ? resolveSurfacePatternColor('paved', fallbackColor)
      : null,
    accentWidthPx: pavedPresent ? pavedPatternWidthPx(traceWidthPx) : 0,
    accentDasharray: pavedPresent ? ROUTE_PAVED_DASHARRAY : null,
    accentFilter: pavedPresent ? ['==', ['get', 'surface'], 'paved'] : null,
    accentCap: 'butt',
    overlayColorPaint: gravelPresent
      ? resolveSurfacePatternColor('gravel', fallbackColor)
      : null,
    overlayWidthPx: gravelPresent ? gravelPatternWidthPx(traceWidthPx) : 0,
    overlayDasharray: gravelPresent ? ROUTE_GRAVEL_DASHARRAY : null,
    overlayFilter: gravelPresent ? ['==', ['get', 'surface'], 'gravel'] : null,
    overlayCap: 'butt',
    textureColorPaint: dirtPresent ? resolveSurfacePatternColor('dirt', fallbackColor) : null,
    textureWidthPx: dirtPresent ? dirtPatternWidthPx(traceWidthPx) : 0,
    textureDasharray: dirtPresent ? ROUTE_DIRT_DASHARRAY : null,
    textureFilter: dirtPresent ? ['==', ['get', 'surface'], 'dirt'] : null,
    textureCap: 'round',
    requiresLineMetrics: false,
  };
}

export function buildRouteGeoJson(
  points: readonly RouteLayerPoint[],
  opts: RouteLayerOptions,
  traceWidthPx: number,
): RouteLayerRenderSpec {
  if (opts.renderMode === 'slope') {
    return buildSlopeRouteRenderSpec(points, opts.slopeBands ?? [], opts.color);
  }
  if (hasStyledSurface(points)) {
    return buildSurfaceRouteRenderSpec(points, opts.color, traceWidthPx);
  }
  return {
    data: buildDefaultRouteGeoJson(points),
    lineColorPaint: opts.color,
    lineGradientPaint: null,
    lineBorderColorPaint: ROUTE_TRANSPARENT_COLOR,
    lineBorderWidthPx: 0,
    casingColorPaint: null,
    casingWidthPx: 0,
    casingFilter: null,
    accentColorPaint: null,
    accentWidthPx: 0,
    accentDasharray: null,
    accentFilter: null,
    accentCap: 'butt',
    overlayColorPaint: null,
    overlayWidthPx: 0,
    overlayDasharray: null,
    overlayFilter: null,
    overlayCap: 'butt',
    textureColorPaint: null,
    textureWidthPx: 0,
    textureDasharray: null,
    textureFilter: null,
    textureCap: 'round',
    requiresLineMetrics: false,
  };
}