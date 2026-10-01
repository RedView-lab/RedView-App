/**
 * Audit A — substitut en mémoire de src/shared/utils/storage/idbProjectStore.ts
 * (même API, structuredClone comme IndexedDB). Utilisé par a-persistence-sim.ts.
 */
import type { ProjectRow } from '../../src/shared/utils/projects/types.ts';
import type { ItineraryProject } from '../../src/features/itineraryPanel/types.ts';

const projects = new Map<string, ProjectRow>();
const cache = new Map<string, { projectId: string; ownerId?: string; cachedAt: string; project: ItineraryProject }>();
const thumbs = new Map<string, Blob>();

export const __idb = { projects, cache, thumbs, clear: () => { projects.clear(); cache.clear(); thumbs.clear(); } };

export async function clearProjectStore(): Promise<void> {
  __idb.clear();
}
export async function migrateFromLocalStorageIfNeeded(): Promise<void> {}
export async function idbSaveProject(row: ProjectRow): Promise<void> {
  projects.set(row.id, structuredClone(row));
}
export async function idbGetProject(id: string): Promise<ProjectRow | null> {
  const r = projects.get(id);
  return r ? structuredClone(r) : null;
}
export async function idbListProjects(): Promise<ProjectRow[]> {
  return [...projects.values()]
    .map((r) => structuredClone(r))
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}
export async function idbDeleteProject(id: string): Promise<void> {
  projects.delete(id);
  cache.delete(id);
  thumbs.delete(id);
}
export async function idbSaveProjectCache(projectId: string, project: ItineraryProject, ownerId?: string): Promise<void> {
  cache.set(projectId, { projectId, ownerId, cachedAt: new Date().toISOString(), project: structuredClone(project) });
}
export async function idbGetProjectCache(projectId: string) {
  const c = cache.get(projectId);
  return c ? structuredClone(c) : null;
}
export async function idbSaveThumbnail(projectId: string, blob: Blob): Promise<void> {
  thumbs.set(projectId, blob);
}
export async function idbGetThumbnail(projectId: string): Promise<Blob | null> {
  return thumbs.get(projectId) ?? null;
}
