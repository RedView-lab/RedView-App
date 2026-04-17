import { useState, type ReactNode } from 'react';
import { IconChevronDown } from '../icons';
import { Toggle } from './Toggle';

interface SectionProps {
  title: string;
  icon?: ReactNode;
  /** If provided, renders an inline toggle switch in the header. */
  toggle?: { checked: boolean; onChange?: (v: boolean) => void };
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
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = open ?? uncontrolledOpen;

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
          {title}
        </button>
        {toggle ? (
          <Toggle
            checked={toggle.checked}
            onChange={toggle.onChange}
            ariaLabel={`Activer ${title}`}
          />
        ) : null}
        <button
          type="button"
          className={`rvc-section__chevron${isOpen ? ' is-open' : ''}`}
          onClick={toggleOpen}
          aria-label={isOpen ? 'Réduire' : 'Développer'}
        >
          <IconChevronDown size={16} />
        </button>
      </header>
      {isOpen && children ? <div className="rvc-section__body">{children}</div> : null}
    </section>
  );
}
