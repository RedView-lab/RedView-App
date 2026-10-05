import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_PROFILES } from '../../lib/project';
import {
  ensureCustomProfilesSynced,
  getSavedCustomProfiles,
  mergeAvailableCustomProfiles,
  saveCustomProfileToStorage,
  deleteCustomProfileFromStorage,
  CUSTOM_PROFILES_CHANGED_EVENT,
  type SavedCustomProfile,
} from '../../lib/project/customProfiles';
import type { RouteProfile } from '../../types';

/**
 * Profils de tracé perso : bibliothèque du compte (copie locale synchronisée
 * avec les préférences Appwrite, cf. customProfiles.ts) complétée des profils
 * embarqués dans le projet ouvert, et liste combinée présets + profils perso
 * affichée dans le sélecteur.
 */
export function useCustomProfiles(projectProfiles?: readonly SavedCustomProfile[]) {
  const [libraryProfiles, setLibraryProfiles] = useState<SavedCustomProfile[]>(() =>
    getSavedCustomProfiles(),
  );

  useEffect(() => {
    const handler = () => setLibraryProfiles(getSavedCustomProfiles());
    window.addEventListener(CUSTOM_PROFILES_CHANGED_EVENT, handler);
    ensureCustomProfilesSynced();
    return () => window.removeEventListener(CUSTOM_PROFILES_CHANGED_EVENT, handler);
  }, []);

  const savedCustomProfiles = useMemo(
    () => mergeAvailableCustomProfiles(libraryProfiles, projectProfiles),
    [libraryProfiles, projectProfiles],
  );

  const combinedProfiles = useMemo<RouteProfile[]>(() => {
    const customItems: RouteProfile[] = savedCustomProfiles.map((cp) => ({
      id: cp.id,
      name: cp.name,
    }));
    return [...DEFAULT_PROFILES, ...customItems];
  }, [savedCustomProfiles]);

  const saveCustomProfile = useCallback((profile: Parameters<typeof saveCustomProfileToStorage>[0] | null | undefined) => {
    if (!profile) return;
    saveCustomProfileToStorage(profile);
    setLibraryProfiles(getSavedCustomProfiles());
  }, []);

  const deleteCustomProfile = useCallback((id: string) => {
    deleteCustomProfileFromStorage(id);
    setLibraryProfiles(getSavedCustomProfiles());
  }, []);

  return { savedCustomProfiles, combinedProfiles, saveCustomProfile, deleteCustomProfile };
}
