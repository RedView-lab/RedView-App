import { PROJECT_CACHE_KEY_PREFIX } from '@/features/map3d/lib/mapCacheEpoch';
import { logger } from '@/shared/lib/logger';
import type { ProjectRow } from './types';

// Stockage local hérité (mode dev sans Appwrite) et cache localStorage du Dashboard.

const LOCAL_PROJECTS_KEY = 'redview:local-projects:v1';

export function readLocalProjects(): ProjectRow[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_PROJECTS_KEY);
    return raw ? (JSON.parse(raw) as ProjectRow[]) : [];
  } catch {
    return [];
  }
}

export function writeLocalProjects(projects: ProjectRow[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify(projects));
  } catch (e) {
    // QuotaExceededError ignoré sans risque : IndexedDB a déjà persisté la donnée complète
    logger.projects.debug('LocalStorage write skipped or quota exceeded', e);
  }
}

export function removeLocalProjectCacheEntry(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(`${PROJECT_CACHE_KEY_PREFIX}${id}`);
  } catch {
    // ignore storage access errors
  }
}
