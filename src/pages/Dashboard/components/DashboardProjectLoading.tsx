import { useAppI18n } from '@/shared/i18n';
import { RedViewLogo } from '@/shared/components/RedViewLogo';

import './dashboard-project-loading.css';

type DashboardProjectLoadingProps = {
  /** Projet en cours d'ouverture, affiché en légende sous l'indicateur de chargement. */
  projectName?: string | null;
};

/**
 * Page de transition plein écran affichée entre le gestionnaire de projets et
 * l'éditeur 3D pendant la création ou le chargement d'un projet.
 *
 * Elle se place volontairement au-dessus des deux surfaces (z-index > la
 * surcouche du gestionnaire de projets) pour que la bascule se lise comme deux
 * écrans distincts avec une page de chargement entre eux, plutôt qu'une coupe
 * franche.
 */
export function DashboardProjectLoading({ projectName }: DashboardProjectLoadingProps) {
  const { t } = useAppI18n();

  return (
    <div
      className="rv-loading-screen rv-fixed-viewport"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="rv-loading-screen__brand">
        <RedViewLogo width={125} height={24} />
      </div>

      <div className="rv-loading-screen__center">
        <span className="rv-loading-screen__spinner" aria-hidden="true" />
        <p className="rv-loading-screen__label">{t('Chargement du projet…')}</p>
        {projectName ? (
          <p className="rv-loading-screen__project" title={projectName}>
            {projectName}
          </p>
        ) : null}
      </div>
    </div>
  );
}
