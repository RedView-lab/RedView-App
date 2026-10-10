import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { isProjectCloudError } from '@/shared/services/projects';
import { useLatestRef } from '@/shared/hooks/useLatestRef';
import { confirmDialog } from '@/shared/lib/appDialog';
import { notify } from '@/shared/lib/notify';
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

  // Question de conflit encore ouverte quand le projet se ferme ou change
  // (la page vit derrière la pop-in) : elle se ferme, rien n'est forcé. La
  // sauvegarde forcée vise le projet ouvert à ce moment-là, plus celui-ci.
  const conflictDialogRef = useRef<AbortController | null>(null);
  useEffect(() => () => conflictDialogRef.current?.abort(), [projectId]);

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
        if (!isProjectCloudError(error) || error.kind !== 'conflict') throw error;
        const dialog = new AbortController();
        conflictDialogRef.current = dialog;
        const replace = await confirmDialog({
          title: t('Ce projet a été modifié sur un autre appareil'),
          message: t('Remplacer la version du cloud par la vôtre ? Sinon, vos modifications restent sur cet appareil.'),
          confirmLabel: t('Remplacer la version du cloud'),
          cancelLabel: t('Garder sur cet appareil'),
        }, { signal: dialog.signal });
        if (conflictDialogRef.current === dialog) conflictDialogRef.current = null;
        if (!replace || dialog.signal.aborted) throw error;
        saved = await onSaveProject({ force: true });
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

  // Modifications gardées nulle part (stockage plein, cloud pas confirmé) :
  // l'indicateur ne suffit pas, un toast le dit une fois par épisode.
  const localCopyLost = autosaveStatus?.localCopyLost === true;
  const localCopyLostMessage = autosaveStatus?.message;
  useEffect(() => {
    if (localCopyLost && localCopyLostMessage) notify.error(localCopyLostMessage);
  }, [localCopyLost, localCopyLostMessage]);

  const handleSaveProjectRef = useLatestRef(handleSaveProject);
  useEffect(() => {
    if (!onSaveProject) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      void handleSaveProjectRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSaveProjectRef, onSaveProject]);

  return { handleSaveProject, displayedSaveStatus, displayedSaveMessage };
}
