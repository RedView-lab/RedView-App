import { PROJECT_CACHE_KEY_PREFIX } from '@/features/map3d/lib/mapCacheEpoch';
import type { ItineraryProject } from '@/features/itineraryPanel/types';

export interface LocalProjectCacheEntry {
  cachedAt: string;
  project: ItineraryProject;
}

export const KEEPALIVE_BODY_LIMIT_BYTES = 60_000;
export const LOCAL_PROJECT_CACHE_MAX_ENTRY_BYTES = 900_000;
export const LOCAL_PROJECT_CACHE_TOTAL_BUDGET_BYTES = 2_500_000;
export const LOCAL_PROJECT_CACHE_MAX_ENTRIES = 3;

const cacheWritesDisabledForProject = new Set<string>();
let projectCacheStorageCompacted = false;

export function isQuotaExceededError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
}

export function estimateSerializedBytes(value: string): number {
  try {
    return new Blob([value]).size;
  } catch {
    return value.length * 2;
  }
}

export function buildLocalProjectCachePayload(project: ItineraryProject): {
  compacted: boolean;
  serialized: string;
} | null {
  const payload: LocalProjectCacheEntry = {
    cachedAt: new Date().toISOString(),
    project: structuredClone(project),
  };

  let compacted = false;
  let serialized = JSON.stringify(payload);
  if (estimateSerializedBytes(serialized) <= LOCAL_PROJECT_CACHE_MAX_ENTRY_BYTES) {
    return { compacted, serialized };
  }

  const compactionSteps: Array<(draft: ItineraryProject) => void> = [
    (draft) => {
      for (const itinerary of draft.itineraries) {
        if (itinerary.gpxRoute?.originalPoints) {
          delete itinerary.gpxRoute.originalPoints;
        }
      }
    },
    (draft) => {
      for (const itinerary of draft.itineraries) {
        delete itinerary.poiFeatures;
      }
    },
    (draft) => {
      for (const itinerary of draft.itineraries) {
        delete itinerary.metrics;
        delete itinerary.routeAudit;
      }
    },
    (draft) => {
      for (const itinerary of draft.itineraries) {
        delete itinerary.prediction;
        delete itinerary.fitUploads;
      }
    },
    (draft) => {
      for (const itinerary of draft.itineraries) {
        delete itinerary.pendingTraceExtension;
        delete itinerary.pendingRoutePatch;
      }
    },
  ];

  for (const compact of compactionSteps) {
    compact(payload.project);
    const nextSerialized = JSON.stringify(payload);
    if (nextSerialized !== serialized) {
      compacted = true;
      serialized = nextSerialized;
    }
    if (estimateSerializedBytes(serialized) <= LOCAL_PROJECT_CACHE_MAX_ENTRY_BYTES) {
      return { compacted, serialized };
    }
  }

  return null;
}

export function compactProjectCacheStorage(projectIdToKeep?: string | null): void {
  const pinnedKey = projectIdToKeep ? getProjectCacheKey(projectIdToKeep) : null;
  const entries: { key: string; cachedAtMs: number; bytes: number; pinned: boolean }[] = [];

  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (!key || !key.startsWith(PROJECT_CACHE_KEY_PREFIX)) continue;

    let cachedAtMs = Number.NEGATIVE_INFINITY;
    let bytes = 0;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) {
        window.localStorage.removeItem(key);
        continue;
      }
      bytes = estimateSerializedBytes(raw);
      const parsed = JSON.parse(raw) as Partial<LocalProjectCacheEntry>;
      if (typeof parsed.cachedAt === 'string') {
        const parsedMs = Date.parse(parsed.cachedAt);
        if (Number.isFinite(parsedMs)) cachedAtMs = parsedMs;
      }
    } catch {
      window.localStorage.removeItem(key);
      continue;
    }

    entries.push({
      key,
      cachedAtMs,
      bytes,
      pinned: key === pinnedKey,
    });
  }

  entries.sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return right.cachedAtMs - left.cachedAtMs;
  });

  let keptEntries = 0;
  let keptBytes = 0;

  for (const entry of entries) {
    const keepWithinBudget =
      entry.bytes <= LOCAL_PROJECT_CACHE_MAX_ENTRY_BYTES &&
      (entry.pinned ||
        (keptEntries < LOCAL_PROJECT_CACHE_MAX_ENTRIES &&
          keptBytes + entry.bytes <= LOCAL_PROJECT_CACHE_TOTAL_BUDGET_BYTES));

    if (!keepWithinBudget) {
      window.localStorage.removeItem(entry.key);
      continue;
    }

    keptEntries += 1;
    keptBytes += entry.bytes;
  }
}

export function readAccessTokenSync(anonKey: string): string {
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith('sb-')) continue;
      if (!key.endsWith('-auth-token')) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed?.access_token) return parsed.access_token as string;
    }
  } catch {
    /* fall through */
  }
  return anonKey;
}

export function getProjectCacheKey(projectId: string): string {
  return `${PROJECT_CACHE_KEY_PREFIX}${projectId}`;
}

export function readProjectCache(projectId: string): LocalProjectCacheEntry | null {
  try {
    if (!projectCacheStorageCompacted) {
      compactProjectCacheStorage(projectId);
      projectCacheStorageCompacted = true;
    }

    const raw = window.localStorage.getItem(getProjectCacheKey(projectId));
    if (!raw) return null;

    if (estimateSerializedBytes(raw) > LOCAL_PROJECT_CACHE_MAX_ENTRY_BYTES) {
      window.localStorage.removeItem(getProjectCacheKey(projectId));
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<LocalProjectCacheEntry>;
    if (!parsed || typeof parsed.cachedAt !== 'string' || !parsed.project) {
      window.localStorage.removeItem(getProjectCacheKey(projectId));
      return null;
    }
    return {
      cachedAt: parsed.cachedAt,
      project: parsed.project as ItineraryProject,
    };
  } catch {
    return null;
  }
}

export function writeProjectCache(projectId: string, project: ItineraryProject): void {
  if (cacheWritesDisabledForProject.has(projectId)) return;

  const key = getProjectCacheKey(projectId);
  const payload = buildLocalProjectCachePayload(project);
  if (!payload) {
    cacheWritesDisabledForProject.add(projectId);
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Ignore
    }
    console.warn('[Dashboard] local project cache skipped: project snapshot too large', {
      projectId,
    });
    return;
  }

  if (!projectCacheStorageCompacted) {
    compactProjectCacheStorage(projectId);
    projectCacheStorageCompacted = true;
  }

  try {
    window.localStorage.setItem(key, payload.serialized);
  } catch (error) {
    if (isQuotaExceededError(error)) {
      try {
        compactProjectCacheStorage(projectId);
        window.localStorage.setItem(key, payload.serialized);
        return;
      } catch (retryError) {
        cacheWritesDisabledForProject.add(projectId);
        console.warn(
          '[Dashboard] local project cache disabled after quota exhaustion',
          retryError,
        );
        return;
      }
    }

    cacheWritesDisabledForProject.add(projectId);
    console.warn('[Dashboard] local project cache write failed', error);
  }
}
