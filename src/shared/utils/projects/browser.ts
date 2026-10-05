import { listProjectFolders } from './folders';
import { listProjects, listSharedProjects } from './projectRows';
import type { ProjectBrowserSnapshot } from './types';

export async function listProjectBrowserSnapshot(): Promise<ProjectBrowserSnapshot> {
  const [folders, projects, sharedProjects] = await Promise.all([listProjectFolders(), listProjects(), listSharedProjects()]);
  return { folders, projects, sharedProjects };
}