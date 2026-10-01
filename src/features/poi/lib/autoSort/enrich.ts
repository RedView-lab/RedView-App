// Enrichissement géométrique des POI pour le tri auto : passages sur la
// trace (progression, écart latéral, côté), pente locale et qualité
// intrinsèque. Aucune notion d'horaire ici (voir select.ts).

import type { PoiFeature } from '../../types';
import { buildPoiClusters } from '../refinePoiClustering';
import {
  getRouteChunks,
  projectOntoSegmentLocal,
  projectRoutePoints,
  projectedLatLon,
  scorePoiFeature,
  type ProjectedPoi,
  type ProjectedRoutePoint,
  type ProjectedRouteMetadata,
} from '../refinePoiProjection';
import { isOpen247 } from './openingHours';
import {
  AUTO_SORT_BASE_QUALITY,
  AUTO_SORT_GAP_FAMILY,
  AUTO_SORT_KIND_BY_CATEGORY,
  type AutoSortGapFamily,
  type AutoSortRules,
} from './rules';
import type { AutoSortKind, RouteSide } from './types';

export interface RouteIndex {
  projected: ProjectedRoutePoint[];
  totalM: number;
  /** Altitude interpolée à une progression donnée (null si la trace n'a pas d'altitude). */
  elevationAt: (progressM: number) => number | null;
}

export interface Candidate {
  /** Unique par passage : `${id}@${passIndex}`. */
  key: string;
  feature: PoiFeature;
  kind: AutoSortKind;
  family: AutoSortGapFamily | null;
  progressM: number;
  lateralM: number;
  side: RouteSide;
  gradePct: number;
  is247: boolean;
  /** Qualité intrinsèque (catégorie, source, métadonnées, proximité), sans horaire. */
  quality: number;
  /** Bonus de regroupement (plusieurs types de ravito au même endroit). */
  clusterBonus: number;
  clusterId: number;
  /** Point d'eau recevable seulement faute de mieux (descente, côté gauche…). */
  fallback: boolean;
  inDescent: boolean;
}

export function buildRouteIndex(
  points: readonly { lat: number; lon: number; elevationM?: number | null }[],
): RouteIndex {
  const projected = projectRoutePoints(points as { lat: number; lon: number }[]);
  const totalM = projected.length > 0 ? projected[projected.length - 1]!.progressM : 0;

  const progress: number[] = [];
  const elevation: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const ele = points[i]!.elevationM;
    if (ele == null || !Number.isFinite(ele)) continue;
    progress.push(projected[i]!.progressM);
    elevation.push(ele);
  }

  const elevationAt = (progressM: number): number | null => {
    const n = progress.length;
    if (n === 0) return null;
    if (progressM <= progress[0]!) return elevation[0]!;
    if (progressM >= progress[n - 1]!) return elevation[n - 1]!;
    let lo = 0;
    let hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (progress[mid]! <= progressM) lo = mid;
      else hi = mid;
    }
    const span = progress[hi]! - progress[lo]!;
    if (span <= 0) return elevation[lo]!;
    const t = (progressM - progress[lo]!) / span;
    return elevation[lo]! + t * (elevation[hi]! - elevation[lo]!);
  };

  return { projected, totalM, elevationAt };
}

interface Pass {
  progressM: number;
  lateralM: number;
  cross: number;
}

/**
 * Tous les passages de la trace à moins de `maxLateralM` du POI (une trace en
 * aller-retour ou en boucle peut frôler le même POI plusieurs fois, dans des
 * sens opposés) : un passage par groupe de segments contigus en progression.
 */
export function findRoutePasses(
  feature: PoiFeature,
  route: readonly ProjectedRoutePoint[],
  maxLateralM: number,
  separationM: number,
): Pass[] {
  if (route.length < 2) return [];
  const meta = route as unknown as Partial<ProjectedRouteMetadata>;
  const lonScale = meta.lonScale ?? Math.cos((feature.lat * Math.PI) / 180) * 111_320;
  const latScale = meta.latScale ?? 110_540;
  const px = feature.lon * lonScale;
  const py = feature.lat * latScale;

  const hits: Pass[] = [];
  for (const chunk of getRouteChunks(route)) {
    if (
      px < chunk.minX - maxLateralM
      || px > chunk.maxX + maxLateralM
      || py < chunk.minY - maxLateralM
      || py > chunk.maxY + maxLateralM
    ) continue;

    for (let i = chunk.start; i < chunk.end; i++) {
      const a = route[i]!;
      const b = route[i + 1]!;
      // Métrique locale du segment (cos de sa latitude) : les x/y globaux ne
      // servent qu'à l'élagage ci-dessus.
      const seg = projectOntoSegmentLocal(
        projectedLatLon(a, meta),
        projectedLatLon(b, meta),
        feature.lat,
        feature.lon,
      );
      if (seg.distanceM > maxLateralM) continue;
      hits.push({
        progressM: a.progressM + seg.t * (b.progressM - a.progressM),
        lateralM: seg.distanceM,
        // x = est, y = nord : produit vectoriel > 0 ⇒ POI à gauche du sens de marche.
        cross: seg.cross,
      });
    }
  }
  if (hits.length === 0) return [];

  hits.sort((l, r) => l.progressM - r.progressM);
  const passes: Pass[] = [];
  let best = hits[0]!;
  let lastProgress = best.progressM;
  for (let i = 1; i < hits.length; i++) {
    const hit = hits[i]!;
    if (hit.progressM - lastProgress > separationM) {
      passes.push(best);
      best = hit;
    } else if (hit.lateralM < best.lateralM) {
      best = hit;
    }
    lastProgress = hit.progressM;
  }
  passes.push(best);
  return passes;
}

function gradeAround(route: RouteIndex, progressM: number, rules: AutoSortRules): number {
  const from = Math.max(0, progressM - rules.water.gradeWindowBeforeM);
  const to = Math.min(route.totalM, progressM + rules.water.gradeWindowAfterM);
  if (to - from < 20) return 0;
  const a = route.elevationAt(from);
  const b = route.elevationAt(to);
  if (a == null || b == null) return 0;
  return ((b - a) / (to - from)) * 100;
}

function sourceFactor(feature: PoiFeature): number {
  const confidence = typeof feature.srcConfidence === 'number' ? feature.srcConfidence : 0.8;
  switch (feature.source) {
    case 'overture':
      return 0.75 + 0.2 * confidence;
    // Registre d'entreprises : le siège n'est pas toujours une boutique ouverte au public.
    case 'sirene':
      return 0.65 + 0.2 * confidence;
    default:
      // OSM (source nulle) et AllThePlaces : constatés sur place.
      return 1;
  }
}

function baseQuality(feature: PoiFeature, kind: AutoSortKind): number {
  const base = AUTO_SORT_BASE_QUALITY[feature.category] ?? 0.5;
  if (kind !== 'water') return base;
  // Fontaine / source explicitement potable = aussi fiable qu'un robinet d'eau potable.
  const drinking = feature.tags?.drinking_water;
  if (drinking === 'yes' || drinking === 'treated') return Math.max(base, 0.95);
  if (drinking === 'conditional') return base * 0.8;
  return base;
}

function isExcluded(feature: PoiFeature, kind: AutoSortKind): boolean {
  const tags = feature.tags ?? {};
  if (tags.access === 'private' || tags.access === 'no') return true;
  if (kind === 'water' && (tags.drinking_water === 'no' || tags.drinking_water === 'not')) return true;
  if (tags.opening_hours?.trim().toLowerCase() === 'off') return true;
  return false;
}

/**
 * Candidats du tri auto : un par passage de la trace près d'un POI traité,
 * dans la distance X de sa catégorie (plafonnée pour les points d'eau :
 * « proximité immédiate »).
 */
export function buildCandidates(
  features: readonly PoiFeature[],
  route: RouteIndex,
  rules: AutoSortRules,
  maxLateralMFor: (feature: PoiFeature) => number,
): { candidates: Candidate[]; descentsAvoided: number } {
  const candidates: Candidate[] = [];
  const seen = new Set<string | number>();

  for (const feature of features) {
    if (seen.has(feature.id)) continue;
    seen.add(feature.id);
    const kind = AUTO_SORT_KIND_BY_CATEGORY[feature.category];
    if (!kind || isExcluded(feature, kind)) continue;

    const maxLateralM = kind === 'water'
      ? Math.min(maxLateralMFor(feature), rules.water.maxLateralM)
      : maxLateralMFor(feature);
    const passes = findRoutePasses(feature, route.projected, maxLateralM, rules.multiPassSeparationM);
    passes.forEach((pass, passIndex) => {
      const lateralM = pass.lateralM;
      const side: RouteSide = lateralM <= rules.water.onRouteM ? 'on' : pass.cross > 0 ? 'left' : 'right';
      const gradePct = gradeAround(route, pass.progressM, rules);
      const inDescent = gradePct <= rules.water.descentGradePct;

      let fallback = false;
      if (kind === 'water') {
        if (inDescent) fallback = true;
        if (side === 'left' && lateralM > rules.water.leftSideMaxLateralM) fallback = true;
      }

      const proximity = 1 - 0.4 * Math.min(1, lateralM / 150);
      // Bonus métadonnées de scorePoiFeature (nom, horaires, téléphone…),
      // sans sa composante proximité (déjà comptée ci-dessus).
      const metadata = scorePoiFeature(feature, Number.POSITIVE_INFINITY);
      const sideFactor = kind === 'water' && side === 'left' ? 0.85 : 1;

      candidates.push({
        key: `${feature.id}@${passIndex}`,
        feature,
        kind,
        family: AUTO_SORT_GAP_FAMILY[feature.category] ?? null,
        progressM: pass.progressM,
        lateralM,
        side,
        gradePct,
        is247: isOpen247(feature.tags?.opening_hours),
        quality: baseQuality(feature, kind) * sourceFactor(feature) * proximity * sideFactor * (1 + 0.3 * Math.min(1, metadata)),
        clusterBonus: 1,
        clusterId: -1,
        fallback,
        inDescent,
      });
    });
  }

  applyClusterBonus(candidates, rules);
  candidates.sort((l, r) => l.progressM - r.progressM);
  const descentsAvoided = candidates.filter((c) => c.kind === 'water' && c.inDescent).length;
  return { candidates, descentsAvoided };
}

/**
 * « Priorisation des regroupements » : un village avec boulangerie +
 * supérette + fontaine vaut mieux qu'un commerce isolé. Réutilise
 * `buildPoiClusters` sur les candidats eau / ravito.
 */
function applyClusterBonus(candidates: Candidate[], rules: AutoSortRules): void {
  const pool = candidates.filter((c) => c.kind !== 'hotel');
  const projected: ProjectedPoi[] = pool.map((c) => ({
    feature: c.feature,
    progressM: c.progressM,
    lateralDistanceM: c.lateralM,
    etaSec: null,
    baseScore: 1,
    score: 1,
    openStatus: 'unknown',
    clusterId: -1,
  }));
  const clusters = buildPoiClusters(projected, rules.cluster.radiusM, rules.cluster.maxLateralM);
  pool.forEach((candidate, index) => {
    const clusterId = projected[index]!.clusterId;
    candidate.clusterId = clusterId;
    candidate.clusterBonus = clusters[clusterId]?.bonus ?? 1;
  });
}
