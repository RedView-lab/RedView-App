import type { ItineraryFitUpload, ItineraryProject } from '@/features/itineraryPanel/types';

export type ProjectPrivacy = 'private' | 'public';

export interface ProjectRow {
  id: string;
  user_id: string;
  folder_id: string | null;
  name: string;
  data: ItineraryProject;
  size_bytes: number;
  privacy: ProjectPrivacy;
  created_at: string;
  updated_at: string;
  /**
   * Copie locale (IndexedDB) uniquement : modifications pas encore confirmées
   * par le cloud. Une ligne `dirty` est resynchronisée à la prochaine ouverture
   * et bloque la déconnexion tant qu'elle n'est pas envoyée.
   */
  dirty?: boolean;
  /**
   * Copie locale uniquement : `$updatedAt` du document cloud sur lequel cette
   * copie est basée (contrôle de conflit multi-appareils).
   */
  cloud_updated_at?: string | null;
}

/** Ligne de projet sans le contenu `data` (lecture IndexedDB sans désérialiser). */
export type ProjectRowMeta = Omit<ProjectRow, 'data'>;

export interface ProjectSummary {
  id: string;
  folderId: string | null;
  name: string;
  privacy: ProjectPrivacy;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFolderRow {
  id: string;
  user_id: string;
  parent_folder_id: string | null;
  name: string;
  privacy: ProjectPrivacy;
  created_at: string;
  updated_at: string;
}

export interface ProjectFolderSummary {
  id: string;
  parentFolderId: string | null;
  name: string;
  privacy: ProjectPrivacy;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectBrowserSnapshot {
  folders: ProjectFolderSummary[];
  projects: ProjectSummary[];
}

export type { ItineraryFitUpload, ItineraryProject };