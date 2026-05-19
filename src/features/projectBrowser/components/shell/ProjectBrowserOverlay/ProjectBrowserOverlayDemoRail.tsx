import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';

type ProjectBrowserOverlayDemoRailProps = {
  offersUrl: string;
};

export function ProjectBrowserOverlayDemoRail({
  offersUrl,
}: ProjectBrowserOverlayDemoRailProps) {
  const { t } = useAppI18n();

  return (
    <aside className="rvpb-demo-rail" aria-label={t('Informations du plan Demo')}>
      <div className="rvpb-demo-rail__brand" aria-label="RedView">
        <img
          className="rvpb-demo-rail__brand-image"
          src="/landing/icons/redview-logo.svg"
          alt="RedView"
          width={125}
          height={24}
        />
      </div>

      <div className="rvpb-demo-rail__panel-wrap">
        <aside className="rvpb-demo-upsell" aria-label={t('Découvrir les offres payantes')}>
          <p>
            {t(
              'Vous êtes sur une démo réduite de RedView. Pour activer l’interface, choisissez votre abonnement:',
            )}
          </p>
          <a className="rvpb-demo-upsell__cta" href={offersUrl}>
            <SvgV2Icon name="feedback-play.svg" size={20} />
            <span>{t('Découvrir les offres')}</span>
          </a>
        </aside>
      </div>
    </aside>
  );
}