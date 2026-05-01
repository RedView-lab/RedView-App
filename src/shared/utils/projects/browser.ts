import { listProjectFolders } from './folders';
import { listProjects } from './projectRows';
import type { ProjectBrowserSnapshot } from './types';

export async function listProjectBrowserSnapshot(): Promise<ProjectBrowserSnapshot> {
  const [folders, projects] = await Promise.all([listProjectFolders(), listProjects()]);
  return { folders, projects };
}