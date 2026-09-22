import './MobileBlockScreen.css';

interface MobileBlockScreenProps {
  landingUrl?: string;
}

export function MobileBlockScreen({ landingUrl = 'https://redview.tech' }: MobileBlockScreenProps) {
  return (
    <div className="rv-mobile-block-overlay rv-fixed-viewport">
      <div className="rv-mobile-block-container">
        <img
          src="/landing/icons/redview-logo.svg"
          alt="RedView"
          className="rv-mobile-block-logo"
        />

        <h1 className="rv-mobile-block-title">
          Uniquement disponible sur desktop
        </h1>

        <p className="rv-mobile-block-desc">
          Veuillez ouvrir RedView sur un ordinateur pour accéder à l'application et à la cartographie 3D.
        </p>

        <a href={landingUrl} className="rv-mobile-block-link">
          Retour au site
        </a>
      </div>
    </div>
  );
}
