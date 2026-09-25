import type { PrioritiesState, RoadTypesState } from '../../types';

export interface SavedCustomProfile {
  id: string;
  name: string;
  basePresetId?: string;
  roadTypes: Omit<RoadTypesState, 'applyToAllItineraries'>;
  priorities: PrioritiesState;
  createdAt: number;
}

const STORAGE_KEY = 'redview_custom_routing_profiles';
export const CUSTOM_PROFILES_CHANGED_EVENT = 'redview_custom_profiles_changed';

export function getSavedCustomProfiles(): SavedCustomProfile[] {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

export function saveCustomProfileToStorage(profile: SavedCustomProfile): void {
  try {
    const existing = getSavedCustomProfiles();
    const idx = existing.findIndex((p) => p.id === profile.id);
    if (idx >= 0) {
      existing[idx] = profile;
    } else {
      existing.push(profile);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(CUSTOM_PROFILES_CHANGED_EVENT, { detail: existing }));
    }
  } catch (err) {
    console.warn('[CustomProfiles] Failed to save to localStorage:', err);
  }
}

export function deleteCustomProfileFromStorage(id: string): void {
  try {
    const existing = getSavedCustomProfiles().filter((p) => p.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(CUSTOM_PROFILES_CHANGED_EVENT, { detail: existing }));
    }
  } catch (err) {
    console.warn('[CustomProfiles] Failed to delete from localStorage:', err);
  }
}

export function getNextCustomProfileName(existingProfiles: SavedCustomProfile[]): string {
  const existingNames = new Set(existingProfiles.map((p) => p.name.trim().toLowerCase()));
  let num = 1;
  while (existingNames.has(`profil ${num}`)) {
    num++;
  }
  return `Profil ${num}`;
}
