import { PROJECT_CACHE_KEY_PREFIX } from '@/features/map3d/lib/mapCacheEpoch';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { idbGetProjectCache } from '@/shared/utils/storage/idbProjectStore';
import { getCachedCurrentUserIdSync } from '@/shared/utils/projects/auth';

/**
 * Caches de reprise écrits par les versions précédentes (store IndexedDB
 * `project_cache` + copie localStorage compactée). L'autosave ne les écrit plus :
 * la copie locale de référence est désormais la ligne projet IndexedDB
 * (`dirty` tant que le cloud n'a pas confirmé, voir projectRows.ts). Ils ne
 * sont plus que lus à l'ouverture (instantané complet plus récent, migration).
 */
export interface LocalProjectCacheEntry {
  /** Utilisateur propriétaire du snapshot : une entrée d'un autre compte est un cache miss. */
  ownerId?: string;
  cachedAt: string;
  project: ItineraryProject;
}

const LOCAL_PROJECT_CACHE_MAX_ENTRY_BYTES = 900_000;
const LOCAL_PROJECT_CACHE_TOTAL_BUDGET_BYTES = 2_500_000;
const LOCAL_PROJECT_CACHE_MAX_ENTRIES = 3;

function estimateSerializedBytes(value: string): number {
  try {
    return new Blob([value]).size;
  } catch {
    return value.length * 2;
  }
}

export function compactProjectCacheStorage(projectIdToKeep?: string | null): void {
  const pinnedKey = projectIdToKeep ? getProjectCacheKey(projectIdToKeep) : null;
  const entries: { key: string; cachedAtMs: number; bytes: number; pinned: boolean }[] = [];

  // Clés relevées d'abord : une suppression pendant un parcours par index
  // décale les suivantes, et l'entrée qui suit une entrée retirée était sautée.
  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key?.startsWith(PROJECT_CACHE_KEY_PREFIX)) keys.push(key);
  }

  for (const key of keys) {
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

function getProjectCacheKey(projectId: string): string {
  return `${PROJECT_CACHE_KEY_PREFIX}${projectId}`;
}

/**
 * Instantané complet (store IndexedDB `project_cache`) uniquement, jamais la
 * copie localStorage compactée (sans traces d'origine / POI) : une version
 * compactée ne doit jamais être rouverte puis renvoyée au cloud.
 */
export async function readFullProjectCacheAsync(projectId: string): Promise<LocalProjectCacheEntry | null> {
  try {
    const idbEntry = await idbGetProjectCache(projectId);
    if (idbEntry?.project && idbEntry.ownerId === getCachedCurrentUserIdSync()) {
      return { ownerId: idbEntry.ownerId, cachedAt: idbEntry.cachedAt, project: idbEntry.project };
    }
  } catch {
    // pas d'IndexedDB
  }
  return null;
}
