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
}

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