import { useState, useEffect, type ReactNode } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { IconChevronDown } from '../icons';
import { Toggle } from './Toggle';

interface SectionProps {
  title: string;
  icon?: ReactNode;
  /** Si fourni, affiche un interrupteur dans l'en-tête. */
  toggle?: { checked: boolean; onChange?: (v: boolean) => void; disabled?: boolean };
  /** État initial replié / déplié. */
  defaultOpen?: boolean;
  /** État ouvert contrôlé. À omettre pour un composant non contrôlé. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
  /** Retire la bordure du haut (pour la première section). */
  noTopBorder?: boolean;
}

export function Section({
  title,
  icon,
  toggle,
  defaultOpen = true,
  open,
  onOpenChange,
  children,
  noTopBorder,
}: SectionProps) {
  const { t } = useAppI18n();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = open ?? uncontrolledOpen;
  const [fullyOpen, setFullyOpen] = useState(isOpen);
  const translatedTitle = t(title);

  // Fermeture : plus « entièrement ouverte » dès ce rendu ; ouverture : après
  // la transition CSS.
  if (!isOpen && fullyOpen) setFullyOpen(false);
  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => setFullyOpen(true), 280); // correspond à la durée de transition CSS
    return () => clearTimeout(timer);
  }, [isOpen]);

  const toggleOpen = () => {
    const next = !isOpen;
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  return (
    <section className={`rvc-section${noTopBorder ? ' rvc-section--no-top' : ''}`}>
      <header className="rvc-section__header">
        {icon ? <span className="rvc-section__icon">{icon}</span> : null}
        <button
          type="button"
          className="rvc-section__title-btn"
          onClick={toggleOpen}
          aria-expanded={isOpen}
        >
          {translatedTitle}
        </button>
        <div className="rvc-section__actions">
          {toggle ? (
            <Toggle
              checked={toggle.checked}
              onChange={toggle.onChange}
              disabled={toggle.disabled}
              ariaLabel={t('Activer {{title}}', { title: translatedTitle })}
            />
          ) : null}
          <button
            type="button"
            className={`rvc-section__chevron${isOpen ? ' is-open' : ''}`}
            onClick={toggleOpen}
            aria-label={isOpen ? t('Réduire') : t('Développer')}
          >
            <IconChevronDown size={16} />
          </button>
        </div>
      </header>
      <div
        className={`rvc-section__body-wrap${isOpen ? ' is-open' : ''}`}
        aria-hidden={!isOpen}
      >
        <div className={`rvc-section__body-inner${fullyOpen ? ' is-fully-open' : ''}`}>
          <div className="rvc-section__body">{children}</div>
        </div>
      </div>
    </section>
  );
}
