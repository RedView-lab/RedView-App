import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { MIN_VIEWPORT_HEIGHT, MIN_VIEWPORT_WIDTH } from '@/shared/hooks/useIsMobileDevice';
import { useAppI18n } from '@/shared/i18n';
import { RedViewLogo } from '@/shared/components/RedViewLogo';
import './MobileBlockScreen.css';

interface MobileBlockScreenProps {
  landingUrl?: string;
}

/** Écran bloquant pour un vrai appareil mobile : l'application n'est pas montée. */
export function MobileBlockScreen({ landingUrl = 'https://redview.tech' }: MobileBlockScreenProps) {
  const { t } = useAppI18n();

  return (
    <div className="rv-mobile-block-overlay rv-fixed-viewport">
      <div className="rv-mobile-block-container">
        <RedViewLogo className="rv-mobile-block-logo" />

        <h1 className="rv-mobile-block-title">
          {t('Uniquement disponible sur desktop')}
        </h1>

        <p className="rv-mobile-block-desc">
          {t("Veuillez ouvrir RedView sur un ordinateur pour accéder à l'application et à la cartographie 3D.")}
        </p>

        <a href={landingUrl} className="rv-mobile-block-link">
          {t('Retour au site')}
        </a>
      </div>
    </div>
  );
}

interface NarrowViewportOverlayProps {
  onContinue: () => void;
}

/**
 * Superposition affichée quand une fenêtre de bureau devient trop étroite.
 * L'application reste montée dessous ; « Continuer quand même » masque l'avertissement.
 */
export function NarrowViewportOverlay({ onContinue }: NarrowViewportOverlayProps) {
  const { t } = useAppI18n();
  const titleId = useId();
  const descId = useId();
  const continueButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    continueButtonRef.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onContinue();
      return;
    }
    // Seul élément focalisable du dialogue : on y garde le focus.
    if (event.key === 'Tab') {
      event.preventDefault();
      continueButtonRef.current?.focus();
    }
  };

  return (
    <div
      className="rv-mobile-block-overlay rv-mobile-block-overlay--dismissible rv-fixed-viewport"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onKeyDown={handleKeyDown}
    >
      <div className="rv-mobile-block-container">
        <RedViewLogo className="rv-mobile-block-logo" />

        <h1 id={titleId} className="rv-mobile-block-title">
          {t('Fenêtre trop petite')}
        </h1>

        <p id={descId} className="rv-mobile-block-desc">
          {t("RedView est conçu pour une fenêtre d'au moins {{width}} × {{height}} px. Agrandissez-la pour retrouver l'interface complète.", {
            width: MIN_VIEWPORT_WIDTH,
            height: MIN_VIEWPORT_HEIGHT,
          })}
        </p>

        <button
          ref={continueButtonRef}
          type="button"
          className="rv-mobile-block-link rv-mobile-block-button"
          onClick={onContinue}
        >
          {t('Continuer quand même')}
        </button>
      </div>
    </div>
  );
}
