import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { isProjectCloudError } from '@/shared/utils/projects';
import { useProjectSyncStatus } from '@/shared/hooks/useProjectSyncStatus';
import type { ItineraryProject, ProjectSaveStatus } from '../../types';

interface UseProjectSaveOptions {
  projectId?: string | null;
  onSaveProject?: (options?: { force?: boolean }) => Promise<ItineraryProject | null>;
  setProject: (updater: (prev: ItineraryProject) => ItineraryProject) => void;
}

/**
 * Bouton Enregistrer du panneau : sauvegarde (avec confirmation d'écrasement
 * en cas de conflit cloud), statut affiché, raccourci Ctrl/Cmd+S.
 */
export function useProjectSave({ projectId, onSaveProject, setProject }: UseProjectSaveOptions) {
  const { t } = useAppI18n();
  const syncStatus = useProjectSyncStatus();
  const [saveStatus, setSaveStatus] = useState<ProjectSaveStatus>('idle');
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
  const saveStatusTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (saveStatusTimerRef.current != null) window.clearTimeout(saveStatusTimerRef.current);
  }, []);

  const handleSaveProject = useCallback(async () => {
    if (!onSaveProject || saveStatus === 'saving') return;
    if (saveStatusTimerRef.current != null) {
      window.clearTimeout(saveStatusTimerRef.current);
      saveStatusTimerRef.current = null;
    }
    setSaveStatus('saving');
    setSaveErrorMessage(null);
    let nextStatus: ProjectSaveStatus;
    try {
      let saved: ItineraryProject | null;
      try {
        saved = await onSaveProject();
      } catch (error) {
        // Version cloud modifiée sur un autre appareil : écraser seulement sur confirmation.
        if (
          isProjectCloudError(error)
          && error.kind === 'conflict'
          && window.confirm(t('Ce projet a été modifié sur un autre appareil. Remplacer la version du cloud par la vôtre ? (Annuler : vos modifications restent sur cet appareil.)'))
        ) {
          saved = await onSaveProject({ force: true });
        } else {
          throw error;
        }
      }
      const savedProject = saved;
      if (savedProject) {
        setProject((p) => ({ ...p, savedAt: savedProject.savedAt, sizeBytes: savedProject.sizeBytes }));
      }
      nextStatus = 'saved';
    } catch (error) {
      console.error('[ItineraryPanel] project save failed', error);
      setSaveErrorMessage(
        isProjectCloudError(error) ? t(error.message) : t('Échec de l’enregistrement'),
      );
      nextStatus = 'error';
    }
    setSaveStatus(nextStatus);
    saveStatusTimerRef.current = window.setTimeout(() => {
      saveStatusTimerRef.current = null;
      setSaveStatus('idle');
    }, nextStatus === 'error' ? 6000 : 2000);
  }, [onSaveProject, saveStatus, setProject, t]);

  // Indicateur : résultat du bouton Enregistrer, sinon état de l'autosave
  // (hors-ligne en attente / erreur persistante) du projet affiché.
  const autosaveStatus = syncStatus.projectId != null && syncStatus.projectId === projectId ? syncStatus : null;
  const displayedSaveStatus: ProjectSaveStatus = saveStatus !== 'idle'
    ? saveStatus
    : autosaveStatus?.state === 'pending-offline'
      ? 'pending'
      : autosaveStatus?.state === 'error'
        ? 'error'
        : 'idle';
  const displayedSaveMessage = saveStatus !== 'idle'
    ? saveErrorMessage
    : autosaveStatus?.message
      ? t(autosaveStatus.message)
      : null;

  const handleSaveProjectRef = useRef(handleSaveProject);
  handleSaveProjectRef.current = handleSaveProject;
  useEffect(() => {
    if (!onSaveProject) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      void handleSaveProjectRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSaveProject]);

  return { handleSaveProject, displayedSaveStatus, displayedSaveMessage };
}
