import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_PROFILES } from '../../lib/project';
import {
  getSavedCustomProfiles,
  saveCustomProfileToStorage,
  deleteCustomProfileFromStorage,
  CUSTOM_PROFILES_CHANGED_EVENT,
  type SavedCustomProfile,
} from '../../lib/project/customProfiles';
import type { RouteProfile } from '../../types';

/**
 * Profils de tracé enregistrés par l'utilisateur (localStorage), synchronisés
 * entre onglets/panneaux via `CUSTOM_PROFILES_CHANGED_EVENT`, et liste
 * combinée présets + profils perso affichée dans le sélecteur.
 */
export function useCustomProfiles() {
  const [savedCustomProfiles, setSavedCustomProfiles] = useState<SavedCustomProfile[]>(() =>
    getSavedCustomProfiles(),
  );

  useEffect(() => {
    const handler = () => setSavedCustomProfiles(getSavedCustomProfiles());
    window.addEventListener(CUSTOM_PROFILES_CHANGED_EVENT, handler);
    return () => window.removeEventListener(CUSTOM_PROFILES_CHANGED_EVENT, handler);
  }, []);

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
    setSavedCustomProfiles(getSavedCustomProfiles());
  }, []);

  const deleteCustomProfile = useCallback((id: string) => {
    deleteCustomProfileFromStorage(id);
    setSavedCustomProfiles(getSavedCustomProfiles());
  }, []);

  return { savedCustomProfiles, combinedProfiles, saveCustomProfile, deleteCustomProfile };
}
