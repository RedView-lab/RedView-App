import { useRef, useState } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { IconFigmaChevronDown } from '../../components/iconsFigma';
import { PortalDropdown } from '../../components/controls/PortalDropdown';
import { TOLERANCE_OPTIONS } from './activity';

interface ToleranceSelectProps {
  currentTolerance: number;
  onSelect: (value: number) => void;
}

/** Part du parcours autorisée hors de la plage de surfaces (« Hors plage »). */
export function ToleranceSelect({ currentTolerance, onSelect }: ToleranceSelectProps) {
  const { t } = useAppI18n();
  const [toleranceOpen, setToleranceOpen] = useState(false);
  const toleranceBtnRef = useRef<HTMLButtonElement>(null);

  const handleToleranceSelect = (val: number) => {
    onSelect(val);
    setToleranceOpen(false);
  };

  return (
      <div className="rvi-tracage__tolerance-col">
        <button
          ref={toleranceBtnRef}
          type="button"
          className={`rvi-tracage__tolerance-btn${toleranceOpen ? ' is-open' : ''}`}
          onClick={() => setToleranceOpen((prev) => !prev)}
          aria-expanded={toleranceOpen}
          aria-label={t('Hors plage')}
          title={t('Part du parcours autorisée hors de la plage de surfaces choisie (0 % = strict)')}
        >
          <span>{`${currentTolerance}%`}</span>
          <IconFigmaChevronDown size={12} />
        </button>
        <span className="rvi-tracage__tolerance-sublabel">{t('Hors plage')}</span>

        <PortalDropdown
          open={toleranceOpen}
          anchorRef={toleranceBtnRef}
          onClose={() => setToleranceOpen(false)}
          align="right"
          estimatedHeight={260}
        >
          {TOLERANCE_OPTIONS.map((val) => (
            <button
              key={val}
              type="button"
              className={`rv-dropdown__item${val === currentTolerance ? ' is-selected' : ''}`}
              onClick={() => handleToleranceSelect(val)}
            >
              <span>{`${val}%`}</span>
            </button>
          ))}
        </PortalDropdown>
      </div>
  );
}
