import { fetchBrouterRoute } from '../brouter';
import { parseMessages } from './parser';
import { isOffroadSurface, isPavedSurface } from './surface';
import type { RoutePointInput, RouteSurfaceMetrics, Surface } from './types';
import { haversineM } from './elevation';

export interface SurfaceAnalysisProgress {
  completedChunks: number;
  totalChunks: number;
  progress01: number;
}

export interface SurfaceAnalysisOptions {
  signal?: AbortSignal;
  onProgress?: (progress: SurfaceAnalysisProgress) => void;
  maxConcurrency?: number;
  chunkTargetDistanceKm?: number;
}

export interface SurfaceAnalysisResult {
  points: RoutePointInput[];
  metrics: RouteSurfaceMetrics | null;
  surfaceBreakdownKm: {
    asphalt: number;
    paved: number;
    gravel: number;
    dirt: number;
    sand: number;
    unknown: number;
  };
}

interface SampledWaypoint {
  lat: number;
  lon: number;
  distanceM: number;
  pointIndex: number;
}

interface SurfaceInterval {
  startDistanceM: number;
  endDistanceM: number;
  surface: Surface;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_CHUNK_TARGET_KM = 35;
const MAX_WAYPOINTS_PER_CHUNK = 28;
const MIN_WAYPOINTS_PER_CHUNK = 4;
const MAX_WAYPOINT_SPACING_M = 1800;
const MIN_WAYPOINT_SPACING_M = 150;
const BEARING_CHANGE_THRESHOLD_DEG = 22;

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function calculateBearing(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function bearingDifference(b1: number, b2: number): number {
  const diff = Math.abs(b1 - b2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Samples key guiding waypoints along the GPX track based on:
 * - Curvature / turns (direction changes > BEARING_CHANGE_THRESHOLD_DEG)
 * - Maximum distance spacing constraint (preventing BRouter shortcuts)
 */
function sampleGuidingWaypoints(points: RoutePointInput[], distancesM: number[]): SampledWaypoint[] {
  if (points.length <= 2) {
    return points.map((p, idx) => ({
      lat: p.lat,
      lon: p.lon,
      distanceM: distancesM[idx] ?? 0,
      pointIndex: idx,
    }));
  }

  const waypoints: SampledWaypoint[] = [
    {
      lat: points[0].lat,
      lon: points[0].lon,
      distanceM: 0,
      pointIndex: 0,
    },
  ];

  let lastSampledIndex = 0;
  let previousBearing: number | null = null;

  for (let i = 1; i < points.length - 1; i++) {
    const current = points[i];
    const next = points[i + 1];

    const distFromLastM = (distancesM[i] ?? 0) - (distancesM[lastSampledIndex] ?? 0);

    const currentBearing = calculateBearing(current, next);
    const hasTurn =
      previousBearing != null &&
      bearingDifference(previousBearing, currentBearing) >= BEARING_CHANGE_THRESHOLD_DEG;

    const shouldSample =
      distFromLastM >= MAX_WAYPOINT_SPACING_M ||
      (hasTurn && distFromLastM >= MIN_WAYPOINT_SPACING_M);

    if (shouldSample) {
      waypoints.push({
        lat: current.lat,
        lon: current.lon,
        distanceM: distancesM[i] ?? 0,
        pointIndex: i,
      });
      lastSampledIndex = i;
    }

    previousBearing = currentBearing;
  }

  const lastIndex = points.length - 1;
  const lastPoint = points[lastIndex];
  const lastDistM = distancesM[lastIndex] ?? 0;
  const lastSampled = waypoints[waypoints.length - 1];

  if (lastSampled && lastDistM - lastSampled.distanceM < MIN_WAYPOINT_SPACING_M && waypoints.length > 1) {
    waypoints[waypoints.length - 1] = {
      lat: lastPoint.lat,
      lon: lastPoint.lon,
      distanceM: lastDistM,
      pointIndex: lastIndex,
    };
  } else {
    waypoints.push({
      lat: lastPoint.lat,
      lon: lastPoint.lon,
      distanceM: lastDistM,
      pointIndex: lastIndex,
    });
  }

  return waypoints;
}

interface WaypointChunk {
  chunkIndex: number;
  waypoints: SampledWaypoint[];
  startDistM: number;
  endDistM: number;
}

function createWaypointChunks(
  waypoints: SampledWaypoint[],
  targetChunkDistanceKm: number,
): WaypointChunk[] {
  if (waypoints.length <= 2) {
    return [
      {
        chunkIndex: 0,
        waypoints,
        startDistM: waypoints[0]?.distanceM ?? 0,
        endDistM: waypoints[waypoints.length - 1]?.distanceM ?? 0,
      },
    ];
  }

  const chunks: WaypointChunk[] = [];
  const targetDistM = targetChunkDistanceKm * 1000;
  let chunkStartIdx = 0;

  while (chunkStartIdx < waypoints.length - 1) {
    let chunkEndIdx = chunkStartIdx + 1;
    const startDist = waypoints[chunkStartIdx].distanceM;

    while (chunkEndIdx < waypoints.length - 1) {
      const currentDist = waypoints[chunkEndIdx].distanceM - startDist;
      const count = chunkEndIdx - chunkStartIdx + 1;

      if (count >= MAX_WAYPOINTS_PER_CHUNK || currentDist >= targetDistM) {
        break;
      }
      chunkEndIdx++;
    }

    if (chunkEndIdx - chunkStartIdx + 1 < MIN_WAYPOINTS_PER_CHUNK && chunkEndIdx < waypoints.length - 1) {
      chunkEndIdx = Math.min(waypoints.length - 1, chunkStartIdx + MIN_WAYPOINTS_PER_CHUNK - 1);
    }

    const chunkWaypoints = waypoints.slice(chunkStartIdx, chunkEndIdx + 1);
    chunks.push({
      chunkIndex: chunks.length,
      waypoints: chunkWaypoints,
      startDistM: chunkWaypoints[0].distanceM,
      endDistM: chunkWaypoints[chunkWaypoints.length - 1].distanceM,
    });

    chunkStartIdx = chunkEndIdx;
  }

  return chunks;
}

async function fetchChunkSurfaces(
  chunk: WaypointChunk,
  signal?: AbortSignal,
): Promise<SurfaceInterval[]> {
  const { waypoints, startDistM, endDistM } = chunk;
  if (waypoints.length < 2) return [];

  const start = waypoints[0];
  const end = waypoints[waypoints.length - 1];
  const via = waypoints.slice(1, -1).map((wp) => ({ lat: wp.lat, lon: wp.lon }));

  try {
    const route = await fetchBrouterRoute({
      start: { lat: start.lat, lon: start.lon },
      via: via.length > 0 ? via : undefined,
      end: { lat: end.lat, lon: end.lon },
      profile: 'trekking',
      signal,
    });

    const rows = parseMessages(route);
    if (rows.length === 0) {
      return [{ startDistanceM: startDistM, endDistanceM: endDistM, surface: 'asphalt' }];
    }

    let brouterTotalDistM = 0;
    for (let i = 1; i < rows.length; i++) {
      brouterTotalDistM += rows[i].segDistM;
    }

    const chunkSpanM = Math.max(1, endDistM - startDistM);
    const scale = brouterTotalDistM > 0 ? chunkSpanM / brouterTotalDistM : 1;

    const intervals: SurfaceInterval[] = [];
    let currentDist = startDistM;

    for (let i = 1; i < rows.length; i++) {
      const segLengthM = rows[i].segDistM * scale;
      const nextDist = Math.min(endDistM, currentDist + segLengthM);
      const surface = rows[i].surface;

      if (intervals.length > 0 && intervals[intervals.length - 1].surface === surface) {
        intervals[intervals.length - 1].endDistanceM = nextDist;
      } else {
        intervals.push({
          startDistanceM: currentDist,
          endDistanceM: nextDist,
          surface,
        });
      }
      currentDist = nextDist;
    }

    if (intervals.length > 0) {
      intervals[intervals.length - 1].endDistanceM = endDistM;
    }

    return intervals;
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn(`[gpx-surface-analyzer] Chunk ${chunk.chunkIndex} direct route failed, trying sub-segments...`, error);

    // Fallback: if chunk has > 2 waypoints, split into halves
    if (waypoints.length > 2) {
      const mid = Math.floor(waypoints.length / 2);
      const leftChunk: WaypointChunk = {
        chunkIndex: chunk.chunkIndex * 2,
        waypoints: waypoints.slice(0, mid + 1),
        startDistM,
        endDistM: waypoints[mid].distanceM,
      };
      const rightChunk: WaypointChunk = {
        chunkIndex: chunk.chunkIndex * 2 + 1,
        waypoints: waypoints.slice(mid),
        startDistM: waypoints[mid].distanceM,
        endDistM,
      };

      const [leftIntervals, rightIntervals] = await Promise.all([
        fetchChunkSurfaces(leftChunk, signal).catch(() => [
          { startDistanceM: startDistM, endDistanceM: waypoints[mid].distanceM, surface: 'unknown' as Surface },
        ]),
        fetchChunkSurfaces(rightChunk, signal).catch(() => [
          { startDistanceM: waypoints[mid].distanceM, endDistanceM: endDistM, surface: 'unknown' as Surface },
        ]),
      ]);

      return [...leftIntervals, ...rightIntervals];
    }

    return [{ startDistanceM: startDistM, endDistanceM: endDistM, surface: 'unknown' }];
  }
}

/**
 * Dispatches tasks with bounded concurrency.
 */
async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function resolveSurfaceAtDistance(intervals: SurfaceInterval[], distanceM: number): Surface {
  if (intervals.length === 0) return 'unknown';

  let low = 0;
  let high = intervals.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const interval = intervals[mid];

    if (distanceM < interval.startDistanceM) {
      high = mid - 1;
    } else if (distanceM > interval.endDistanceM) {
      low = mid + 1;
    } else {
      return interval.surface;
    }
  }

  if (low >= intervals.length) return intervals[intervals.length - 1].surface;
  if (high < 0) return intervals[0].surface;
  return intervals[low].surface;
}

/**
 * Analyzes and qualifies surface types for an arbitrary GPX track of any length.
 * Optimized for ultra-distance routes (e.g. 1500 km Desertus Bikus).
 */
export async function analyzeGpxSurfaces(
  points: RoutePointInput[],
  options?: SurfaceAnalysisOptions,
): Promise<SurfaceAnalysisResult> {
  if (points.length < 2) {
    return {
      points: points.map((p) => ({ ...p, surface: p.surface ?? 'unknown' })),
      metrics: null,
      surfaceBreakdownKm: { asphalt: 0, paved: 0, gravel: 0, dirt: 0, sand: 0, unknown: 0 },
    };
  }

  const distancesM: number[] = new Array(points.length).fill(0);
  for (let i = 1; i < points.length; i++) {
    const prevDist = distancesM[i - 1];
    const candidate = points[i].distanceM;
    if (Number.isFinite(candidate) && (candidate as number) >= prevDist) {
      distancesM[i] = candidate as number;
    } else {
      distancesM[i] = prevDist + haversineM(points[i - 1], points[i]);
    }
  }

  const totalDistanceM = distancesM[distancesM.length - 1] ?? 0;
  const targetChunkKm = options?.chunkTargetDistanceKm ?? DEFAULT_CHUNK_TARGET_KM;
  const maxConcurrency = options?.maxConcurrency ?? DEFAULT_CONCURRENCY;

  const sampledWaypoints = sampleGuidingWaypoints(points, distancesM);
  const chunks = createWaypointChunks(sampledWaypoints, targetChunkKm);

  let completedChunks = 0;
  const totalChunks = chunks.length;

  const handleChunk = async (chunk: WaypointChunk): Promise<SurfaceInterval[]> => {
    if (options?.signal?.aborted) throw new Error('Surface analysis aborted');
    const result = await fetchChunkSurfaces(chunk, options?.signal);
    completedChunks++;
    options?.onProgress?.({
      completedChunks,
      totalChunks,
      progress01: totalChunks > 0 ? completedChunks / totalChunks : 1,
    });
    return result;
  };

  const chunkResults = await runWithConcurrencyLimit(chunks, maxConcurrency, handleChunk);
  const allIntervals = chunkResults.flat().sort((a, b) => a.startDistanceM - b.startDistanceM);

  const breakdown = {
    asphalt: 0,
    paved: 0,
    gravel: 0,
    dirt: 0,
    sand: 0,
    unknown: 0,
  };

  let tarmacDist = 0;
  let offroadDist = 0;

  const enrichedPoints: RoutePointInput[] = points.map((p, idx) => {
    const dist = distancesM[idx] ?? 0;
    const surface = resolveSurfaceAtDistance(allIntervals, dist);

    if (idx > 0) {
      const segM = Math.max(0, dist - (distancesM[idx - 1] ?? 0));
      breakdown[surface] += segM / 1000;

      if (isPavedSurface(surface)) {
        tarmacDist += segM;
      } else if (isOffroadSurface(surface)) {
        offroadDist += segM;
      }
    }

    return {
      ...p,
      distanceM: dist,
      surface,
    };
  });

  const classifiedDist = tarmacDist + offroadDist;
  const metrics: RouteSurfaceMetrics | null =
    classifiedDist > 0
      ? {
          distanceM: totalDistanceM,
          tarmacPercent: (tarmacDist / classifiedDist) * 100,
          offroadPercent: (offroadDist / classifiedDist) * 100,
        }
      : null;

  return {
    points: enrichedPoints,
    metrics,
    surfaceBreakdownKm: {
      asphalt: Math.round(breakdown.asphalt * 10) / 10,
      paved: Math.round(breakdown.paved * 10) / 10,
      gravel: Math.round(breakdown.gravel * 10) / 10,
      dirt: Math.round(breakdown.dirt * 10) / 10,
      sand: Math.round(breakdown.sand * 10) / 10,
      unknown: Math.round(breakdown.unknown * 10) / 10,
    },
  };
}
