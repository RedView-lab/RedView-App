import { useState, useEffect, type ReactNode } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { IconChevronDown } from '../icons';
import { Toggle } from './Toggle';

interface SectionProps {
  title: string;
  icon?: ReactNode;
  /** If provided, renders an inline toggle switch in the header. */
  toggle?: { checked: boolean; onChange?: (v: boolean) => void; disabled?: boolean };
  /** Initial collapsed/expanded state. */
  defaultOpen?: boolean;
  /** Controlled open state. Omit for uncontrolled. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
  /** Removes the top border (used for first section). */
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

  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => setFullyOpen(true), 280); // matches CSS transition duration
      return () => clearTimeout(timer);
    } else {
      setFullyOpen(false);
    }
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
