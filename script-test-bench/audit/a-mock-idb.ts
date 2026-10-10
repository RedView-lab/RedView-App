/**
 * Audit A — substitut en mémoire de src/shared/services/storage/idbProjectStore.ts
 * (même API, structuredClone comme IndexedDB). Utilisé par a-persistence-sim.ts.
 *
 * Comme le vrai store, une ligne projet ne garde que le document partagé et le
 * travail en attente (la vue de l'utilisateur va dans `views`) : `data` relu
 * est recomposé par les mêmes fonctions que l'application.
 */
import type { ProjectRow, ProjectRowMeta } from '../../src/shared/services/projects/types.ts';
import type { ItineraryProject } from '../../src/features/itineraryPanel/types/index.ts';
import {
  parseStoredLocalWork,
  parseStoredProject,
  serializeProjectForStorage,
  type SerializedProject,
} from '../../src/shared/services/projects/storedProject.ts';
import type { IdbProjectViewEntry } from '../../src/shared/services/storage/idbProjectStore.ts';

type StoredRow = ProjectRowMeta & { data_json: string; work_json?: string };

// Base globale : deux bundles chargés (deux onglets, scénarios T*) lisent la même IndexedDB.
type SharedIdb = {
  projects: Map<string, StoredRow>;
  cache: Map<string, { projectId: string; ownerId?: string; cachedAt: string; project: ItineraryProject }>;
  thumbs: Map<string, Blob>;
  views: Map<string, IdbProjectViewEntry>;
};
const sharedIdb = ((globalThis as typeof globalThis & { __rvAuditIdb?: SharedIdb }).__rvAuditIdb ??= {
  projects: new Map(),
  cache: new Map(),
  thumbs: new Map(),
  views: new Map(),
});
const { projects, cache, thumbs, views } = sharedIdb;

function hydrate(stored: StoredRow): ProjectRow | null {
  const parsed = parseStoredProject(JSON.parse(stored.data_json), parseStoredLocalWork(stored.work_json));
  if (!parsed) return null;
  const meta: Partial<StoredRow> = { ...stored };
  delete meta.data_json;
  delete meta.work_json;
  return { ...(structuredClone(meta) as ProjectRowMeta), data: parsed.project };
}

export const __idb = {
  projects: {
    get: (id: string) => {
      const stored = projects.get(id);
      return stored ? hydrate(stored) : undefined;
    },
    raw: (id: string) => projects.get(id),
    values: () => [...projects.values()].map(hydrate).filter((row): row is ProjectRow => row != null),
    get size() {
      return projects.size;
    },
  },
  cache,
  thumbs,
  views,
  clear: () => {
    projects.clear();
    cache.clear();
    thumbs.clear();
    views.clear();
  },
};

export async function clearProjectStore(): Promise<void> {
  __idb.clear();
}
export async function migrateFromLocalStorageIfNeeded(): Promise<void> {}
export async function idbSaveProject(row: ProjectRow, serialized?: SerializedProject): Promise<void> {
  const { data, ...meta } = row;
  const { documentJson, workJson } = serialized ?? serializeProjectForStorage(data);
  const stored: StoredRow = { ...structuredClone(meta), data_json: documentJson };
  if (workJson) stored.work_json = workJson;
  projects.set(row.id, stored);
}
export async function idbGetProject(id: string): Promise<ProjectRow | null> {
  const stored = projects.get(id);
  return stored ? hydrate(stored) : null;
}
function toMeta(stored: StoredRow): ProjectRowMeta {
  const meta: Partial<StoredRow> = { ...stored };
  delete meta.data_json;
  delete meta.work_json;
  return structuredClone(meta) as ProjectRowMeta;
}
export async function idbGetProjectMeta(id: string): Promise<ProjectRowMeta | null> {
  const stored = projects.get(id);
  return stored ? toMeta(stored) : null;
}
export async function idbUpdateProjectMeta(
  id: string,
  patch: Partial<Omit<ProjectRowMeta, 'id'>> | ((meta: ProjectRowMeta) => Partial<Omit<ProjectRowMeta, 'id'>>),
): Promise<boolean> {
  const stored = projects.get(id);
  if (!stored) return false;
  const next = typeof patch === 'function' ? patch(toMeta(stored)) : patch;
  projects.set(id, { ...stored, ...structuredClone(next), id });
  return true;
}
export async function idbListProjectMetas(): Promise<ProjectRowMeta[]> {
  return [...projects.values()]
    .map(toMeta)
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}
export async function idbDeleteProject(id: string): Promise<void> {
  projects.delete(id);
  cache.delete(id);
  thumbs.delete(id);
  views.delete(id);
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
export async function idbGetProjectView(projectId: string): Promise<IdbProjectViewEntry | null> {
  const entry = views.get(projectId);
  return entry ? structuredClone(entry) : null;
}
export async function idbSaveProjectView(entry: IdbProjectViewEntry): Promise<void> {
  views.set(entry.projectId, structuredClone(entry));
}
export async function idbDeleteProjectView(projectId: string): Promise<void> {
  views.delete(projectId);
}
