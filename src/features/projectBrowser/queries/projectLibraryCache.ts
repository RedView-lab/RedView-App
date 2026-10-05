import type { ProjectBrowserSnapshot, ProjectFolderSummary, ProjectSummary } from '@/shared/utils/projects';

/**
 * Mises à jour de la liste en cache après une mutation confirmée (fonctions
 * pures, testées) : l'interface suit sans relire toute la liste. Les autres
 * champs du snapshot (`fetchedAt`…) sont conservés.
 */

const touched = () => new Date().toISOString();

export function prependProjects<T extends ProjectBrowserSnapshot>(snapshot: T | undefined, projects: ProjectSummary[]): T | undefined {
  if (!snapshot || projects.length === 0) return snapshot;
  const ids = new Set(projects.map((project) => project.id));
  return { ...snapshot, projects: [...projects, ...snapshot.projects.filter((project) => !ids.has(project.id))] };
}

export function patchProject<T extends ProjectBrowserSnapshot>(
  snapshot: T | undefined,
  projectId: string,
  patch: Partial<ProjectSummary>,
): T | undefined {
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === projectId ? { ...project, ...patch, updatedAt: touched() } : project,
    ),
  };
}

export function removeProject<T extends ProjectBrowserSnapshot>(snapshot: T | undefined, projectId: string): T | undefined {
  if (!snapshot) return snapshot;
  return { ...snapshot, projects: snapshot.projects.filter((project) => project.id !== projectId) };
}

export function prependFolder<T extends ProjectBrowserSnapshot>(snapshot: T | undefined, folder: ProjectFolderSummary): T | undefined {
  if (!snapshot) return snapshot;
  return { ...snapshot, folders: [folder, ...snapshot.folders.filter((entry) => entry.id !== folder.id)] };
}

export function patchFolder<T extends ProjectBrowserSnapshot>(
  snapshot: T | undefined,
  folderId: string,
  patch: Partial<ProjectFolderSummary>,
): T | undefined {
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    folders: snapshot.folders.map((folder) => (folder.id === folderId ? { ...folder, ...patch, updatedAt: touched() } : folder)),
  };
}

export function removeFolder<T extends ProjectBrowserSnapshot>(snapshot: T | undefined, folderId: string): T | undefined {
  if (!snapshot) return snapshot;
  return { ...snapshot, folders: snapshot.folders.filter((folder) => folder.id !== folderId) };
}

/** Noms des projets d'un dossier (noms libres d'une copie ou d'un import). */
export function projectNamesIn(snapshot: ProjectBrowserSnapshot | undefined, folderId: string | null): string[] {
  return (snapshot?.projects ?? []).filter((project) => project.folderId === folderId).map((project) => project.name);
}
