import { useRef, useState } from 'react';

import { useAppI18n } from '@/shared/i18n';
import { notify } from '@/shared/ui/notify';

import { exportAccountData, type AccountExportProgress } from '../lib/accountData';
import { AccountSection } from './AccountSection';
import { DeleteAccountDialog } from './DeleteAccountDialog';

type AccountDataFormProps = {
  email: string;
};

/**
 * « Vos données » : télécharger tout ce que le compte possède, supprimer le
 * compte (RGPD — accès, portabilité, effacement).
 */
export function AccountDataForm({ email }: AccountDataFormProps) {
  const { t } = useAppI18n();
  const [progress, setProgress] = useState<AccountExportProgress | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const exporting = progress !== null;

  const runExport = async () => {
    if (exporting) return;
    setProgress({ done: 0, total: 0 });
    try {
      const result = await exportAccountData(setProgress);
      if (result.failedProjects.length > 0) {
        notify.error('Export terminé, mais {{count}} projet(s) illisible(s) : {{names}}.', {
          count: result.failedProjects.length,
          names: result.failedProjects.join(', '),
        });
      } else {
        notify.success('Vos données sont téléchargées ({{count}} projet(s)).', { count: result.projectCount });
      }
    } catch (error) {
      console.warn('[account] export failed', error);
      notify.error('L’export de vos données a échoué. Réessayez.');
    } finally {
      setProgress(null);
    }
  };

  return (
    <AccountSection title={t('Vos données')}>
      <div className="rvpb-account-data-row">
        <div className="rvpb-account-data-text">
          <div className="rvpb-account-password-label">{t('Télécharger mes données')}</div>
          <p className="rvpb-account-data-hint">
            {t('Une archive avec votre compte, vos dossiers et chacun de vos projets au format .redview (tracés, POI, fichiers .fit…).')}
          </p>
        </div>
        <div className="rvpb-account-actions">
          <button type="button" className="rvpb-inline-cta" onClick={() => void runExport()} disabled={exporting}>
            {exporting
              ? progress.total > 0
                ? t('Export… {{done}}/{{total}}', { done: progress.done, total: progress.total })
                : t('Préparation…')
              : t('Télécharger')}
          </button>
        </div>
      </div>

      <div className="rvpb-account-data-row">
        <div className="rvpb-account-data-text">
          <div className="rvpb-account-password-label">{t('Supprimer mon compte')}</div>
          <p className="rvpb-account-data-hint">
            {t('Efface définitivement votre compte, vos projets, fichiers et partages, et arrête votre abonnement.')}
          </p>
        </div>
        <div className="rvpb-account-actions">
          <button
            ref={deleteButtonRef}
            type="button"
            className="rvpb-inline-cta is-danger"
            onClick={() => setDeleteOpen(true)}
          >
            {t('Supprimer mon compte')}
          </button>
        </div>
      </div>

      {deleteOpen ? (
        <DeleteAccountDialog
          email={email}
          anchorEl={deleteButtonRef.current}
          exporting={exporting}
          onExport={() => void runExport()}
          onClose={() => setDeleteOpen(false)}
        />
      ) : null}
    </AccountSection>
  );
}
