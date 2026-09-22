import { useAppI18n } from '@/shared/i18n';

import './dashboard-project-loading.css';

type DashboardProjectLoadingProps = {
  /** Project being opened, shown as a caption under the spinner. */
  projectName?: string | null;
};

/**
 * Full-screen transition page displayed between the project manager and the
 * 3D editor while a project is being created or loaded.
 *
 * It deliberately sits above both surfaces (z-index > the project browser
 * overlay) so the switch reads as two distinct full screens with a loading
 * page in between, instead of a hard cut.
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
        <img src="/landing/icons/redview-logo.svg" alt="RedView" width={125} height={24} />
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
