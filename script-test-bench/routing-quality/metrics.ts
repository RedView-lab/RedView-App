/**
 * Statistiques d'un tracé BRouter, calculées de la même façon avant/après :
 * D+/D− par la méthode de l'app (points stockés → computeRouteElevationMetrics),
 * revêtements via `classifySegment` de l'app, types de voies, sens interdits,
 * allers-retours, pentes sur fenêtre glissante de 200 m.
 */
import { haversineKm } from './scenarios.ts';

/** Fonctions de l'app chargées via Vite SSR (`loadSrc`). */
export interface AppMetricFns {
  parseWayTags(tags: string): Record<string, string>;
  classifySegment(tags: string): string;
  computeRouteElevationMetrics(points: unknown[]): { ascentM: number; descentM: number } | null;
  buildStoredRoutePointsFromBrouter(geometry: unknown[], profile: unknown, distanceM: number): unknown[];
  toGeometryRoutePoints(coords: [number, number][]): unknown[];
  extractRouteProfileFromBrouter(route: unknown): unknown;
}

export interface RouteLike {
  coordinates: [number, number][];
  distanceM: number;
  durationS: number;
  ascentM: number;
  descentM: number;
  raw: { features?: Array<{ properties?: Record<string, unknown> }> };
}

export const ROAD_CLASSES = ['motorway', 'major', 'secondary', 'tertiary', 'minor', 'cycleway', 'track', 'path', 'steps', 'ferry', 'other'] as const;
export type RoadClass = (typeof ROAD_CLASSES)[number];
export const SURFACES = ['asphalt', 'paved', 'gravel', 'dirt', 'sand', 'unknown'] as const;
export type SurfaceClass = (typeof SURFACES)[number];

export interface RouteMetrics {
  distanceKm: number;
  detourRatio: number;
  ascentM: number;
  descentM: number;
  brouterAscentM: number;
  brouterDescentM: number;
  /** Valeur `descentM` renvoyée par le client de l'app (contrôle du signe). */
  clientDescentM: number;
  durationMin: number;
  cost: number | null;
  surfaceKm: Record<SurfaceClass, number>;
  roadKm: Record<RoadClass, number>;
  cycleRouteKm: number;
  wrongWayKm: number;
  backtrackKm: number;
  maxGrade200Pct: number;
  kmAboveMaxSlope: number;
  kmAbove10Pct: number;
  coordinates: number;
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function roadClassOf(tags: Record<string, string>): RoadClass {
  if (tags.route === 'ferry') return 'ferry';
  switch (tags.highway) {
    case 'motorway':
    case 'motorway_link':
      return 'motorway';
    case 'trunk':
    case 'trunk_link':
    case 'primary':
    case 'primary_link':
      return 'major';
    case 'secondary':
    case 'secondary_link':
      return 'secondary';
    case 'tertiary':
    case 'tertiary_link':
      return 'tertiary';
    case 'unclassified':
    case 'residential':
    case 'living_street':
    case 'service':
    case 'road':
      return 'minor';
    case 'cycleway':
      return 'cycleway';
    case 'track':
      return 'track';
    case 'path':
    case 'footway':
    case 'bridleway':
    case 'pedestrian':
      return 'path';
    case 'steps':
      return 'steps';
    default:
      return 'other';
  }
}

/** Parcours à contresens d'une voie à sens unique (vélo uniquement). */
function isWrongWay(tags: Record<string, string>): boolean {
  if (tags['oneway:bicycle'] === 'no') return false;
  const reversed = tags.reversedirection === 'yes';
  const oneway = tags.oneway;
  if (reversed) return oneway === 'yes' || oneway === 'true' || oneway === '1' || (oneway === undefined && tags.junction === 'roundabout');
  return oneway === '-1';
}

function zeroRecord<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

/** Kilomètres parcourus deux fois en sens inverse (aller-retour sur la même voie). */
function backtrackKm(coords: [number, number][]): number {
  const key = (c: [number, number]) => `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
  const seen = new Set<string>();
  let km = 0;
  for (let i = 1; i < coords.length; i += 1) {
    const a = key(coords[i - 1]!);
    const b = key(coords[i]!);
    if (a === b) continue;
    if (seen.has(`${b}>${a}`)) {
      km += haversineKm({ lon: coords[i - 1]![0], lat: coords[i - 1]![1] }, { lon: coords[i]![0], lat: coords[i]![1] });
    }
    seen.add(`${a}>${b}`);
  }
  return km;
}

/** Pentes sur fenêtre de 200 m (profil rééchantillonné tous les 25 m). */
function gradeStats(coords: [number, number][], maxSlopePct: number) {
  const dist: number[] = [0];
  const ele: number[] = [];
  for (let i = 0; i < coords.length; i += 1) {
    const e = (coords[i] as unknown as number[])[2];
    ele.push(Number.isFinite(e) ? (e as number) : Number.NaN);
    if (i > 0) {
      dist.push(dist[i - 1]! + haversineKm({ lon: coords[i - 1]![0], lat: coords[i - 1]![1] }, { lon: coords[i]![0], lat: coords[i]![1] }) * 1000);
    }
  }
  if (ele.some((e) => !Number.isFinite(e)) || dist[dist.length - 1]! < 400) {
    return { maxGrade200Pct: 0, kmAboveMaxSlope: 0, kmAbove10Pct: 0 };
  }
  const step = 25;
  const total = dist[dist.length - 1]!;
  const samples: number[] = [];
  let j = 0;
  for (let d = 0; d <= total; d += step) {
    while (j < dist.length - 2 && dist[j + 1]! < d) j += 1;
    const span = dist[j + 1]! - dist[j]!;
    const t = span > 0 ? (d - dist[j]!) / span : 0;
    samples.push(ele[j]! + (ele[j + 1]! - ele[j]!) * Math.max(0, Math.min(1, t)));
  }
  const w = Math.round(200 / step);
  let maxGrade = 0;
  let above = 0;
  let above10 = 0;
  for (let i = 0; i + w < samples.length; i += 1) {
    const grade = ((samples[i + w]! - samples[i]!) / (w * step)) * 100;
    if (grade > maxGrade) maxGrade = grade;
    if (grade > maxSlopePct) above += step;
    if (grade > 10) above10 += step;
  }
  return { maxGrade200Pct: maxGrade, kmAboveMaxSlope: above / 1000, kmAbove10Pct: above10 / 1000 };
}

export function computeRouteMetrics(
  app: AppMetricFns,
  route: RouteLike,
  beelineKm: number,
  maxSlopePct: number,
): RouteMetrics {
  const props = (route.raw.features?.[0]?.properties ?? {}) as Record<string, unknown>;
  const messages = props.messages as unknown[][] | undefined;

  const surfaceKm = zeroRecord(SURFACES);
  const roadKm = zeroRecord(ROAD_CLASSES);
  let cycleRouteKm = 0;
  let wrongWayKm = 0;

  if (Array.isArray(messages) && messages.length > 1) {
    const header = (messages[0] as unknown[]).map(String);
    const idxDist = header.indexOf('Distance');
    const idxTags = header.indexOf('WayTags');
    for (let i = 1; i < messages.length; i += 1) {
      const row = messages[i]!;
      const km = num(row[idxDist]) / 1000;
      if (km <= 0) continue;
      const tagsStr = idxTags >= 0 ? String(row[idxTags] ?? '') : '';
      const tags = app.parseWayTags(tagsStr);
      const surface = app.classifySegment(tagsStr) as SurfaceClass;
      surfaceKm[SURFACES.includes(surface) ? surface : 'unknown'] += km;
      roadKm[roadClassOf(tags)] += km;
      if (/route_bicycle_(icn|ncn|rcn|lcn)=yes|route_hiking_|route_foot_/.test(tagsStr)) cycleRouteKm += km;
      if (isWrongWay(tags)) wrongWayKm += km;
    }
  }

  const geometry = app.toGeometryRoutePoints(route.coordinates);
  const stored = app.buildStoredRoutePointsFromBrouter(geometry, app.extractRouteProfileFromBrouter(route), route.distanceM);
  const elevation = app.computeRouteElevationMetrics(stored);
  const filtered = num(props['filtered ascend']);
  const plain = num(props['plain-ascend']);

  return {
    distanceKm: route.distanceM / 1000,
    detourRatio: beelineKm > 0 ? route.distanceM / 1000 / beelineKm : 1,
    ascentM: elevation?.ascentM ?? 0,
    descentM: elevation?.descentM ?? 0,
    brouterAscentM: route.ascentM,
    brouterDescentM: Math.max(0, filtered - plain),
    clientDescentM: route.descentM,
    durationMin: route.durationS / 60,
    cost: props.cost != null ? num(props.cost) : null,
    surfaceKm,
    roadKm,
    cycleRouteKm,
    wrongWayKm,
    backtrackKm: backtrackKm(route.coordinates),
    ...gradeStats(route.coordinates, maxSlopePct),
    coordinates: route.coordinates.length,
  };
}

/** Géométrie allégée (≤ maxPoints) pour la carte du rapport. */
export function simplifyCoords(coords: [number, number][], maxPoints = 160): [number, number][] {
  if (coords.length <= maxPoints) return coords.map(([lon, lat]) => [Number(lon.toFixed(5)), Number(lat.toFixed(5))]);
  const out: [number, number][] = [];
  const stepF = (coords.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i += 1) {
    const c = coords[Math.round(i * stepF)]!;
    out.push([Number(c[0].toFixed(5)), Number(c[1].toFixed(5))]);
  }
  return out;
}
