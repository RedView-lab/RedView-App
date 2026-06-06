// ─────────────────────────────────────────────────────────────────────
// POI corridor refinement — multi-stage pipeline
// ─────────────────────────────────────────────────────────────────────
//
// Replaces the legacy FIFO-by-progress per-category cap with a 4-stage
// pipeline that materially improves the picks:
//
//   1. ENRICH   — project each POI onto the route (progressM, lateralM)
//                 and (when possible) compute its ETA, then score it.
//   2. FILTER   — drop POIs strictly closed at their ETA (best-effort
//                 opening_hours parser; degrades gracefully).
//   3. CLUSTER  — group POIs into multi-category stops along the route
//                 and reward clusters with a richness bonus so a
//                 boulangerie+fontaine+toilettes stop beats three
//                 isolated POIs.
//   4. CAP      — per category, greedy pick by score with a minimum
//                 spacing (distance, or time when ETA is available).
//                 Time-based spacing makes density adaptive to terrain
//                 (rare POIs kept on slow climbs, denser ones culled in
//                 fast descents).
//
// Backward compatibility:
//   The existing call `refinePoiFeaturesAlongRoute(features, points,
//   { maxPerCategoryPerKm, windowM })` keeps working — the new options
//   (etaSecByPoint, startTimeMs, timezoneOffsetMin, …) are optional and
//   simply unlock additional stages when provided.
//
// Failure mode philosophy: every optional stage degrades to a pass-
// through when its inputs are missing or look wrong. The function MUST
// only ever drop a POI for which it has positive evidence (e.g. parsed
// closed hours) — never on a hunch.
// ─────────────────────────────────────────────────────────────────────

import type { GpxRoute, PoiCategory, PoiFeature } from '../types';

// ── Constants ────────────────────────────────────────────────────────

const METERS_PER_DEG_LAT = 110_540;
const METERS_PER_DEG_LON = 111_320;

/** Window of progress (meters) a POI can drift before it starts a new
 *  cluster. ~150 m matches a typical "1-stop" perception on a bike. */
const DEFAULT_CLUSTER_RADIUS_M = 150;

/** Max lateral spread between cluster members. Beyond, we consider
 *  them spatially distinct even if their progress aligns. */
const DEFAULT_CLUSTER_LATERAL_M = 80;

/** Cluster richness bonus is capped to keep a multi-cat stop from
 *  steamrolling a single legitimately better POI down the road. */
const CLUSTER_BONUS_PER_EXTRA_CATEGORY = 0.18;
const CLUSTER_BONUS_MAX = 1.6;

/** Default minimum spacing (seconds) between two accepted POIs of the
 *  same category, when ETA is available. Used as the "pacing" rule.
 *  Categories absent from this table fall back to distance-only
 *  spacing (1000 m / maxPerKm). */
const DEFAULT_MIN_SPACING_SEC: Partial<Record<PoiCategory, number>> = {
  drinking_water: 45 * 60,     // boire toutes les ~45 min d'effort
  bakery: 2 * 3600,
  convenience: 2 * 3600,
  supermarket: 2 * 3600,
  restaurant: 4 * 3600,
  fast_food: 4 * 3600,
  cafe: 4 * 3600,
  bar: 4 * 3600,
  hotel: 12 * 3600,            // re-enforced by maxHotelsPerNight when set
  alpine_hut: 12 * 3600,
  camp_site: 12 * 3600,
  shelter: 6 * 3600,
};

/** Categories we explicitly do NOT cadence by time even when ETA is
 *  available — they are "as found" services where extra ≠ noise. They
 *  still respect the distance-based density cap. */
const NON_CADENCED_CATEGORIES: ReadonlySet<PoiCategory> = new Set<PoiCategory>([
  'toilets',
  'bicycle',
  'bicycle_repair',
  'pharmacy',
  'hospital',
  'fuel',
]);

/** Tag keys that signal a richer / more reliable OSM entry. */
const RICH_TAG_KEYS = [
  'phone', 'website', 'opening_hours', 'wheelchair',
  'cuisine', 'operator', 'email', 'addr:street',
];

/** Lateral distance at which proximity score reaches zero. POIs further
 *  than this from the track are typically a detour. */
const PROXIMITY_FULL_FALLOFF_M = 500;

// ── Public types ─────────────────────────────────────────────────────

export interface RefinementOptions {
  /** Density target: at most ~N POIs of the same category per
   *  `windowM` of route. Required (kept for back-compat). */
  maxPerCategoryPerKm: number;

  /** Sliding window width in meters for the distance density cap.
   *  Default 1000 m. */
  windowM?: number;

  /** Optional: ETA in seconds at each route point. MUST have the same
   *  length as `routePoints`. When provided, unlocks temporal pacing
   *  and opening_hours evaluation. */
  etaSecByPoint?: readonly number[];

  /** Optional: absolute start time of the ride (Unix ms, UTC). */
  startTimeMs?: number;

  /** Optional: timezone offset in minutes east of UTC at the ride
   *  origin (e.g. +120 for Paris summer). Used to evaluate
   *  `opening_hours` in local wall-clock time. */
  timezoneOffsetMin?: number;

  /** Optional: per-category minimum spacing in seconds. Overrides the
   *  built-in defaults. Only applied when ETA is also provided. */
  minSpacingSecByCategory?: Partial<Record<PoiCategory, number>>;

  /** Optional: clustering radius along the route progress axis (m). */
  clusterRadiusM?: number;

  /** Optional: max lateral spread inside a cluster (m). */
  clusterMaxLateralM?: number;

  /** Optional: hard cap on hotel-like POIs per local-time night
   *  (00:00–24:00 buckets in local time). Requires startTimeMs + ETA. */
  maxHotelsPerNight?: number;

  /** Optional: tolerance (minutes) before opening_hours is treated as
   *  closed at the estimated arrival. Default 30 min — accounts for
   *  ETA imprecision and small wait. */
  openingToleranceMin?: number;

  /** Optional: hard lateral cap (m) from the route. Defaults to the
   *  point where proximity scoring already reaches zero. */
  maxLateralDistanceM?: number;

  /** Optional: per-category hard lateral caps (m). When provided, each
   *  category uses its own route distance budget before falling back to
   *  `maxLateralDistanceM`. */
  maxLateralDistanceByCategory?: Partial<Record<PoiCategory, number>>;
}

// ── Internal types ───────────────────────────────────────────────────

interface ProjectedRoutePoint {
  x: number;
  y: number;
  progressM: number;
}

type OpenStatus = 'open' | 'closed' | 'unknown';

interface ProjectedPoi {
  feature: PoiFeature;
  progressM: number;
  lateralDistanceM: number;
  /** ETA in seconds since start, or null when no ETA series. */
  etaSec: number | null;
  /** Base score in [0, ~1.2] (before cluster bonus). */
  baseScore: number;
  /** Effective score = baseScore * clusterBonus. */
  score: number;
  openStatus: OpenStatus;
  /** Index of the cluster this POI belongs to (after stage 3). */
  clusterId: number;
}

interface Cluster {
  id: number;
  progressStart: number;
  progressEnd: number;
  members: ProjectedPoi[];
  distinctCategories: Set<PoiCategory>;
  bonus: number;
}

// ─────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────

export function refinePoiFeaturesAlongRoute(
  features: PoiFeature[],
  routePoints: GpxRoute['points'],
  options: RefinementOptions,
): PoiFeature[] {
  const maxPerKm = Math.max(0, Math.floor(options.maxPerCategoryPerKm));
  if (features.length <= 1 || routePoints.length < 2 || maxPerKm <= 0) {
    return features;
  }

  const windowM = Math.max(250, options.windowM ?? 1_000);
  const clusterRadiusM = Math.max(20, options.clusterRadiusM ?? DEFAULT_CLUSTER_RADIUS_M);
  const clusterMaxLateralM = Math.max(20, options.clusterMaxLateralM ?? DEFAULT_CLUSTER_LATERAL_M);
  const openingToleranceMin = Math.max(0, options.openingToleranceMin ?? 30);
  const maxLateralDistanceM = Math.max(
    50,
    options.maxLateralDistanceM ?? PROXIMITY_FULL_FALLOFF_M,
  );
  const maxLateralDistanceByCategory = options.maxLateralDistanceByCategory ?? null;

  const etaSecByPoint =
    options.etaSecByPoint && options.etaSecByPoint.length === routePoints.length
      ? options.etaSecByPoint
      : null;

  const canCheckHours = etaSecByPoint !== null && typeof options.startTimeMs === 'number';
  const startMs = options.startTimeMs ?? 0;
  const tzOffsetMin = options.timezoneOffsetMin ?? 0;
  const spacingTable: Partial<Record<PoiCategory, number>> = {
    ...DEFAULT_MIN_SPACING_SEC,
    ...(options.minSpacingSecByCategory ?? {}),
  };

  // 1) ENRICH — project + score.
  const route = projectRoute(routePoints);
  const projected: ProjectedPoi[] = features.map((feature) =>
    projectPoi(feature, route, routePoints, etaSecByPoint),
  );

  // 2) FILTER — opening_hours hard filter when feasible.
  let survivors = projected;
  if (canCheckHours) {
    for (const p of projected) {
      const etaMs = startMs + (p.etaSec ?? 0) * 1000;
      p.openStatus = evaluateOpenStatus(
        p.feature.tags?.opening_hours ?? null,
        etaMs,
        tzOffsetMin,
        openingToleranceMin,
      );
    }
    survivors = projected.filter((p) => p.openStatus !== 'closed');
  }

  // Hard detour guard: once a POI is far enough from the route that its
  // proximity score would already be zero, keeping it only lets cluster
  // bonuses resurrect off-route village groups that look wrong in 3D.
  survivors = survivors.filter((p) => {
    const categoryCap = maxLateralDistanceByCategory?.[p.feature.category];
    const lateralCap = Number.isFinite(categoryCap)
      ? Math.max(10, categoryCap as number)
      : maxLateralDistanceM;
    return p.lateralDistanceM <= lateralCap;
  });
  if (survivors.length === 0) return [];

  // 3) CLUSTER + bonus → effective score.
  const clusters = clusterAlongRoute(survivors, clusterRadiusM, clusterMaxLateralM);
  for (const c of clusters) {
    for (const m of c.members) {
      m.score = m.baseScore * c.bonus;
    }
  }

  // 4) CAP — per-category density (greedy, by score).
  let kept = applyDensityCap(survivors, {
    maxPerKm,
    windowM,
    hasEta: etaSecByPoint !== null,
    spacingSecByCategory: spacingTable,
  });

  // 5) Optional: hard hotel-per-night cap.
  if (canCheckHours && options.maxHotelsPerNight !== undefined && options.maxHotelsPerNight > 0) {
    kept = applyHotelPerNightCap(kept, startMs, tzOffsetMin, options.maxHotelsPerNight);
  }

  // 6) Stable final order along route.
  kept.sort((a, b) => {
    if (a.progressM !== b.progressM) return a.progressM - b.progressM;
    if (a.feature.category !== b.feature.category) {
      return a.feature.category.localeCompare(b.feature.category);
    }
    return a.feature.id - b.feature.id;
  });

  return kept.map((entry) => entry.feature);
}

// ─────────────────────────────────────────────────────────────────────
// Stage 1 — Projection + scoring
// ─────────────────────────────────────────────────────────────────────

function projectRoute(points: GpxRoute['points']): ProjectedRoutePoint[] {
  const originLat = points[0]?.lat ?? 0;
  const cosLat = Math.cos((originLat * Math.PI) / 180);
  let cumulative = 0;

  return points.map((point, index) => {
    if (index > 0) {
      cumulative += planarDistanceM(points[index - 1]!, point, cosLat);
    }
    return {
      x: point.lon * METERS_PER_DEG_LON * cosLat,
      y: point.lat * METERS_PER_DEG_LAT,
      progressM: point.distanceM ?? cumulative,
    };
  });
}

function projectPoi(
  feature: PoiFeature,
  route: ProjectedRoutePoint[],
  rawPoints: GpxRoute['points'],
  etaSecByPoint: readonly number[] | null,
): ProjectedPoi {
  const originLat = (route[0]?.y ?? 0) / METERS_PER_DEG_LAT;
  const cosLat = Math.cos((originLat * Math.PI) / 180);
  const pointX = feature.lon * METERS_PER_DEG_LON * cosLat;
  const pointY = feature.lat * METERS_PER_DEG_LAT;

  let bestProgress = route[0]?.progressM ?? 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestSegIndex = 0;
  let bestSegT = 0;

  for (let index = 1; index < route.length; index += 1) {
    const a = route[index - 1]!;
    const b = route[index]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;

    if (lenSq <= 1e-6) {
      const dist = Math.hypot(pointX - a.x, pointY - a.y);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestProgress = a.progressM;
        bestSegIndex = index;
        bestSegT = 0;
      }
      continue;
    }

    const t = Math.max(0, Math.min(1, ((pointX - a.x) * dx + (pointY - a.y) * dy) / lenSq));
    const projX = a.x + dx * t;
    const projY = a.y + dy * t;
    const dist = Math.hypot(pointX - projX, pointY - projY);

    if (dist < bestDistance) {
      bestDistance = dist;
      bestProgress = a.progressM + (b.progressM - a.progressM) * t;
      bestSegIndex = index;
      bestSegT = t;
    }
  }

  // Interpolate ETA at the projected position on the route.
  let etaSec: number | null = null;
  if (etaSecByPoint && etaSecByPoint.length === rawPoints.length) {
    const a = etaSecByPoint[bestSegIndex - 1] ?? etaSecByPoint[0] ?? 0;
    const b = etaSecByPoint[bestSegIndex] ?? a;
    etaSec = a + (b - a) * bestSegT;
  }

  const baseScore = scorePoi(feature, bestDistance);

  return {
    feature,
    progressM: bestProgress,
    lateralDistanceM: bestDistance,
    etaSec,
    baseScore,
    score: baseScore,
    openStatus: 'unknown',
    clusterId: -1,
  };
}

/** Continuous quality score for a single POI in [0, ~1.05].
 *  Weights chosen so proximity dominates, name presence is meaningful,
 *  and tag richness is a tie-breaker only. */
function scorePoi(feature: PoiFeature, lateralDistanceM: number): number {
  const proximity = Math.max(0, 1 - lateralDistanceM / PROXIMITY_FULL_FALLOFF_M);

  const hasName = feature.name && feature.name.trim().length > 0;
  const namedness = hasName ? 1 : 0.45;

  let richHits = 0;
  const tags = feature.tags ?? {};
  for (const key of RICH_TAG_KEYS) {
    if (tags[key]) richHits += 1;
  }
  const richness = Math.min(1, richHits / 3);

  // Proximity remains the outer gate: metadata can break ties between
  // near-route POIs, but it must not let a far-away clustered village
  // outrank a modest POI sitting next to the trace.
  return proximity * (0.55 + 0.27 * namedness + 0.18 * richness);
}

function planarDistanceM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  cosLat: number,
): number {
  const dx = (a.lon - b.lon) * METERS_PER_DEG_LON * cosLat;
  const dy = (a.lat - b.lat) * METERS_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

// ─────────────────────────────────────────────────────────────────────
// Stage 3 — Clustering along route progress
// ─────────────────────────────────────────────────────────────────────

/** Greedy single-pass clustering. POIs are sorted by progress and a
 *  new POI joins the current cluster if it falls within
 *  `clusterRadiusM` of the cluster end AND is laterally close to at
 *  least one current member (within `clusterMaxLateralM`). Otherwise a
 *  fresh cluster starts.
 *
 *  Side-effect: each ProjectedPoi gets its `clusterId` set. The
 *  cluster's `bonus` is `1 + k·(distinctCats − 1)`, capped, so a stop
 *  bundling water + food + toilets meaningfully out-scores three
 *  isolated POIs. The bonus is then applied at the call site. */
function clusterAlongRoute(
  pois: ProjectedPoi[],
  clusterRadiusM: number,
  clusterMaxLateralM: number,
): Cluster[] {
  if (pois.length === 0) return [];

  // We don't mutate the input order — make a sorted copy by progress.
  const sorted = pois.slice().sort((a, b) => a.progressM - b.progressM);

  const clusters: Cluster[] = [];
  for (const p of sorted) {
    const last = clusters[clusters.length - 1];
    const canJoin =
      last !== undefined &&
      p.progressM - last.progressEnd <= clusterRadiusM &&
      lateralCloseEnough(p, last.members, clusterMaxLateralM);

    if (canJoin && last) {
      last.members.push(p);
      last.distinctCategories.add(p.feature.category);
      last.progressEnd = Math.max(last.progressEnd, p.progressM);
      p.clusterId = last.id;
    } else {
      const fresh: Cluster = {
        id: clusters.length,
        progressStart: p.progressM,
        progressEnd: p.progressM,
        members: [p],
        distinctCategories: new Set([p.feature.category]),
        bonus: 1,
      };
      p.clusterId = fresh.id;
      clusters.push(fresh);
    }
  }

  // Compute bonus once cluster is closed.
  for (const c of clusters) {
    const extra = c.distinctCategories.size - 1;
    c.bonus = Math.min(CLUSTER_BONUS_MAX, 1 + extra * CLUSTER_BONUS_PER_EXTRA_CATEGORY);
  }

  return clusters;
}

function lateralCloseEnough(
  candidate: ProjectedPoi,
  members: ProjectedPoi[],
  maxLateralM: number,
): boolean {
  const cosLat = Math.cos((candidate.feature.lat * Math.PI) / 180);
  for (const m of members) {
    if (planarDistanceM(candidate.feature, m.feature, cosLat) <= maxLateralM) {
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// Stage 4 — Per-category density cap
// ─────────────────────────────────────────────────────────────────────

interface DensityCapOptions {
  maxPerKm: number;
  windowM: number;
  hasEta: boolean;
  spacingSecByCategory: Partial<Record<PoiCategory, number>>;
}

/** For each category, accept POIs greedily by descending effective
 *  score, subject to a minimum spacing constraint:
 *
 *  - distance-based: `windowM / maxPerKm` along route progress (always
 *    enforced; this preserves a sane visual density everywhere).
 *  - time-based   : `spacingSecByCategory[cat]` along ETA, when ETA is
 *    available AND the category is in the cadence table AND it is not
 *    in the NON_CADENCED set. Time-based spacing is naturally tighter
 *    on fast sections and looser on slow climbs — the right behavior. */
function applyDensityCap(
  pois: ProjectedPoi[],
  opt: DensityCapOptions,
): ProjectedPoi[] {
  const minSpacingM = opt.windowM / Math.max(1, opt.maxPerKm);

  const byCategory = new Map<PoiCategory, ProjectedPoi[]>();
  for (const p of pois) {
    const arr = byCategory.get(p.feature.category);
    if (arr) arr.push(p);
    else byCategory.set(p.feature.category, [p]);
  }

  const kept: ProjectedPoi[] = [];

  for (const [cat, group] of byCategory) {
    group.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.lateralDistanceM !== b.lateralDistanceM) {
        return a.lateralDistanceM - b.lateralDistanceM;
      }
      return a.feature.id - b.feature.id;
    });

    const useTime =
      opt.hasEta &&
      !NON_CADENCED_CATEGORIES.has(cat) &&
      typeof opt.spacingSecByCategory[cat] === 'number';
    const minSpacingSec = useTime ? opt.spacingSecByCategory[cat]! : 0;

    const acceptedProgress: number[] = [];
    const acceptedEta: number[] = [];

    for (const cand of group) {
      let conflict = false;

      // Distance constraint (always).
      for (const pr of acceptedProgress) {
        if (Math.abs(pr - cand.progressM) < minSpacingM) {
          conflict = true;
          break;
        }
      }

      // Time constraint (when applicable).
      if (!conflict && useTime && cand.etaSec !== null) {
        for (const e of acceptedEta) {
          if (Math.abs(e - cand.etaSec) < minSpacingSec) {
            conflict = true;
            break;
          }
        }
      }

      if (!conflict) {
        kept.push(cand);
        acceptedProgress.push(cand.progressM);
        if (cand.etaSec !== null) acceptedEta.push(cand.etaSec);
      }
    }
  }

  return kept;
}

// ─────────────────────────────────────────────────────────────────────
// Optional stage — Hotel-per-night hard cap
// ─────────────────────────────────────────────────────────────────────

const HOTEL_CATEGORIES: ReadonlySet<PoiCategory> = new Set<PoiCategory>([
  'hotel', 'alpine_hut', 'camp_site',
]);

/** Buckets hotel-like POIs by local-time calendar day of their ETA,
 *  then keeps the top-N per bucket by effective score. The
 *  ride-relative "night" is defined as the local calendar day of the
 *  arrival ETA. */
function applyHotelPerNightCap(
  kept: ProjectedPoi[],
  startMs: number,
  tzOffsetMin: number,
  maxPerNight: number,
): ProjectedPoi[] {
  const buckets = new Map<number, ProjectedPoi[]>();
  const nonHotel: ProjectedPoi[] = [];

  for (const p of kept) {
    if (!HOTEL_CATEGORIES.has(p.feature.category) || p.etaSec === null) {
      nonHotel.push(p);
      continue;
    }
    const etaMs = startMs + p.etaSec * 1000;
    const dayKey = localDayIndex(etaMs, tzOffsetMin);
    const arr = buckets.get(dayKey);
    if (arr) arr.push(p);
    else buckets.set(dayKey, [p]);
  }

  const out = nonHotel;
  for (const group of buckets.values()) {
    group.sort((a, b) => b.score - a.score);
    for (let i = 0; i < group.length && i < maxPerNight; i += 1) {
      out.push(group[i]);
    }
  }
  return out;
}

function localDayIndex(utcMs: number, tzOffsetMin: number): number {
  return Math.floor((utcMs + tzOffsetMin * 60_000) / 86_400_000);
}

// ─────────────────────────────────────────────────────────────────────
// Opening hours — best-effort OSM parser
// ─────────────────────────────────────────────────────────────────────
//
// Handles the common subset of OSM `opening_hours`:
//   - `24/7`
//   - Rule groups separated by `;`
//   - Day specs: `Mo`, `Mo-Fr`, `Mo,We,Fr`, `PH`, omitted (= every day)
//   - Time spans: `08:00-12:00,14:00-19:00`, `off`, `closed`
//   - Cross-midnight spans (`22:00-02:00`)
//   - Trailing `off`/`closed` rule (e.g. `; PH off`)
//
// Anything we don't recognize → returns `'unknown'`, which means the
// POI is kept (fail open). Never returns `'closed'` for a string we
// don't fully understand. `PH` (public holidays) is conservatively
// treated as "not a public holiday today" (no holiday calendar).
// ─────────────────────────────────────────────────────────────────────

const DAY_TOKENS: Record<string, number> = {
  Mo: 0, Tu: 1, We: 2, Th: 3, Fr: 4, Sa: 5, Su: 6,
};

interface ParsedRule {
  days: Set<number> | 'all';
  /** Public holiday rule. Skipped when no calendar; PH off still
   *  affects nothing because we don't know if today is a PH. */
  ph: boolean;
  /** When true, this rule explicitly closes its day range. */
  off: boolean;
  /** Time spans in minutes-since-midnight (start, end). end ≤ 1440;
   *  cross-midnight spans are split into two by the parser. */
  spans: Array<[number, number]>;
}

function evaluateOpenStatus(
  raw: string | null | undefined,
  etaMs: number,
  tzOffsetMin: number,
  toleranceMin: number,
): OpenStatus {
  if (!raw || typeof raw !== 'string') return 'unknown';
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'unknown') return 'unknown';
  if (trimmed === '24/7') return 'open';

  const rules = parseOpeningHours(trimmed);
  if (rules === null) return 'unknown';

  // Local wall-clock at ETA (we don't have a real TZ DB, just the
  // ride's tz offset — accurate enough for ±30 min decisions).
  const localMs = etaMs + tzOffsetMin * 60_000;
  const date = new Date(localMs);
  // getUTC* on the shifted timestamp gives us the wall-clock fields.
  const jsDow = date.getUTCDay();         // 0 = Sun … 6 = Sat
  const osmDow = (jsDow + 6) % 7;         // 0 = Mon … 6 = Sun
  const minOfDay = date.getUTCHours() * 60 + date.getUTCMinutes();

  // Apply rules in order; later rules override earlier ones for the
  // same day. Final decision = state of the last matching rule.
  let decision: OpenStatus = 'closed';
  let matched = false;

  for (const rule of rules) {
    if (rule.ph) continue; // no holiday calendar — ignore PH rules
    const dayMatch = rule.days === 'all' || rule.days.has(osmDow);
    if (!dayMatch) continue;
    matched = true;
    if (rule.off) {
      decision = 'closed';
      continue;
    }
    let openNow = false;
    for (const [s, e] of rule.spans) {
      if (minOfDay >= s - toleranceMin && minOfDay <= e + toleranceMin) {
        openNow = true;
        break;
      }
    }
    decision = openNow ? 'open' : 'closed';
  }

  if (!matched) {
    // No rule covered this day of week — OSM convention: closed.
    // But to stay safe with our partial parser, return unknown.
    return 'unknown';
  }
  return decision;
}

function parseOpeningHours(raw: string): ParsedRule[] | null {
  const out: ParsedRule[] = [];
  const groups = raw.split(';');
  for (const rawGroup of groups) {
    const group = rawGroup.trim();
    if (group === '') continue;
    const parsed = parseOpeningHoursRule(group);
    if (parsed === null) return null; // bail completely on any unknown token
    out.push(parsed);
  }
  return out.length > 0 ? out : null;
}

function parseOpeningHoursRule(rule: string): ParsedRule | null {
  // Split into "<day spec> <time spec>" — day spec is optional.
  // Time spec is either "off" / "closed" or comma-separated HH:MM-HH:MM.
  const tokens = rule.split(/\s+/);
  if (tokens.length === 0) return null;

  // Find where the time spec starts: first token that looks like a
  // time range or "off"/"closed". Everything before = day spec.
  let timeStart = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (/^(off|closed)$/i.test(t) || /^\d{1,2}:\d{2}-/.test(t)) {
      timeStart = i;
      break;
    }
  }

  const daySpec = timeStart === -1 ? tokens.join(' ') : tokens.slice(0, timeStart).join(' ');
  const timeSpec = timeStart === -1 ? '' : tokens.slice(timeStart).join(' ');

  // Parse day spec.
  const parsedDays = parseDaySpec(daySpec);
  if (parsedDays === null) return null;

  // Parse time spec.
  if (timeSpec === '' && daySpec === '') return null;
  if (/^(off|closed)$/i.test(timeSpec.trim())) {
    return { days: parsedDays.days, ph: parsedDays.ph, off: true, spans: [] };
  }
  if (timeSpec === '') {
    // Day spec only (rare) — treat as open all day.
    return { days: parsedDays.days, ph: parsedDays.ph, off: false, spans: [[0, 1440]] };
  }

  const spans = parseTimeSpans(timeSpec);
  if (spans === null) return null;
  return { days: parsedDays.days, ph: parsedDays.ph, off: false, spans };
}

function parseDaySpec(spec: string): { days: Set<number> | 'all'; ph: boolean } | null {
  const trimmed = spec.trim();
  if (trimmed === '') return { days: 'all', ph: false };

  const days = new Set<number>();
  let ph = false;
  const parts = trimmed.split(',');
  for (const part of parts) {
    const tok = part.trim();
    if (tok === 'PH') { ph = true; continue; }
    if (tok === 'SH') continue; // school holidays — ignore safely
    const range = tok.split('-');
    if (range.length === 1) {
      const d = DAY_TOKENS[range[0]];
      if (d === undefined) return null;
      days.add(d);
    } else if (range.length === 2) {
      const from = DAY_TOKENS[range[0]];
      const to = DAY_TOKENS[range[1]];
      if (from === undefined || to === undefined) return null;
      let i = from;
      // Inclusive, wrap-around safe (e.g. Sa-Mo).
      // Hard cap at 7 iterations to avoid pathological inputs.
      for (let k = 0; k < 7; k += 1) {
        days.add(i);
        if (i === to) break;
        i = (i + 1) % 7;
      }
    } else {
      return null;
    }
  }

  if (days.size === 0 && !ph) return { days: 'all', ph: false };
  return { days, ph };
}

function parseTimeSpans(spec: string): Array<[number, number]> | null {
  const out: Array<[number, number]> = [];
  const parts = spec.trim().split(',');
  for (const part of parts) {
    const m = part.trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const sH = Number(m[1]); const sM = Number(m[2]);
    const eH = Number(m[3]); const eM = Number(m[4]);
    if (sH > 24 || eH > 24 || sM > 59 || eM > 59) return null;
    const s = sH * 60 + sM;
    let e = eH * 60 + eM;
    if (e === 0) e = 24 * 60; // "08:00-00:00" → end of day
    if (e <= s) {
      // Cross-midnight span: split into [s, 24:00] and [00:00, e].
      out.push([s, 24 * 60]);
      out.push([0, e]);
    } else {
      out.push([s, e]);
    }
  }
  return out.length > 0 ? out : null;
}