import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';

type ProjectBrowserOverlayHeaderProps = {
  accountDisplayName: string;
  headerMetaLabel: string;
  tierLabel: string;
  isSigningOut: boolean;
  onSignOut: () => void | Promise<void>;
};

export function ProjectBrowserOverlayHeader({
  accountDisplayName,
  headerMetaLabel,
  tierLabel,
  isSigningOut,
  onSignOut,
}: ProjectBrowserOverlayHeaderProps) {
  const { t } = useAppI18n();

  return (
    <header className="rvpb-header">
      <div className="rvpb-user">
        <div className="rvpb-user__identity">
          <div className="rvpb-user__name">{accountDisplayName}</div>
          <div className="rvpb-user__meta">
            <span className="rvpb-user__badge">{tierLabel}</span>
            <span className="rvpb-user__meta-item">
              <SvgV2Icon className="rvpb-user__meta-icon" name="save-01.svg" size={14} />
              <span>{headerMetaLabel}</span>
            </span>
          </div>
        </div>
      </div>

      <button type="button" className="rvpb-logout-button" onClick={() => void onSignOut()}>
        <SvgV2Icon name="log-out-03.svg" size={20} />
        <span>{isSigningOut ? t('Déconnexion...') : t('Se déconnecter')}</span>
      </button>
    </header>
  );
}