import type { ItineraryProject } from './types';

export const MAX_SUPABASE_PROJECT_SIZE_BYTES = 16 * 1024 * 1024;

export function computeProjectSizeBytes(project: ItineraryProject): number {
  try {
    return new Blob([JSON.stringify(project)]).size;
  } catch {
    return 0;
  }
}

export function isSupabaseProjectTooLarge(sizeBytes: number): boolean {
  return sizeBytes > MAX_SUPABASE_PROJECT_SIZE_BYTES;
}