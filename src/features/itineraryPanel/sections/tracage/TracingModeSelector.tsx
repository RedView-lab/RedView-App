import { useRef, useState } from 'react';
import { useAppI18n } from '@/shared/i18n';
import {
  IconComfort,
  IconFigmaChevronDown,
  IconFlash,
  IconTelescope,
} from '../../components/iconsFigma';
import { PortalDropdown } from '../../components/controls/PortalDropdown';
import type { TracingModeType } from '../../lib/project/syncTracageParams';

interface TracingModeSelectorProps {
  currentTracingMode: TracingModeType;
  onSelect: (mode: TracingModeType) => void;
}

/** Sélecteur « Mode de traçage » : Vitesse, Aventure, Comfort. */
export function TracingModeSelector({ currentTracingMode, onSelect }: TracingModeSelectorProps) {
  const { t } = useAppI18n();
  const [tracingOpen, setTracingOpen] = useState(false);
  const tracingBtnRef = useRef<HTMLButtonElement>(null);

  const handleTracingModeSelect = (mode: TracingModeType) => {
    onSelect(mode);
    setTracingOpen(false);
  };

  return (
    <div className="rvi-tracage__mode-col">
      <span className="rvi-tracage__label">{t('Mode de traçage ')}</span>
      <button
        ref={tracingBtnRef}
        type="button"
        className="rvi-tracage__mode-btn rvi-tracage__mode-btn--tracing"
        onClick={() => setTracingOpen((prev) => !prev)}
        aria-expanded={tracingOpen}
        aria-haspopup="listbox"
      >
        <span className="rvi-tracage__mode-btn-icon">
          {currentTracingMode === 'vitesse' && <IconFlash size={16} />}
          {currentTracingMode === 'aventure' && <IconTelescope size={16} />}
          {currentTracingMode === 'comfort' && <IconComfort size={16} />}
        </span>
        <span className="rvi-tracage__mode-btn-text">
          {currentTracingMode === 'vitesse' && t('Vitesse')}
          {currentTracingMode === 'aventure' && t('Aventure')}
          {currentTracingMode === 'comfort' && t('Comfort')}
        </span>
        <span className={`rvi-tracage__mode-btn-chevron${tracingOpen ? ' is-open' : ''}`}>
          <IconFigmaChevronDown size={14} />
        </span>
      </button>

      <PortalDropdown
        open={tracingOpen}
        anchorRef={tracingBtnRef}
        onClose={() => setTracingOpen(false)}
        minWidth={140}
        align="right"
      >
        <button
          type="button"
          className={`rv-dropdown__item${currentTracingMode === 'vitesse' ? ' is-selected' : ''}`}
          onClick={() => handleTracingModeSelect('vitesse')}
        >
          <IconFlash size={15} />
          <span>{t('Vitesse')}</span>
        </button>
        <button
          type="button"
          className={`rv-dropdown__item${currentTracingMode === 'aventure' ? ' is-selected' : ''}`}
          onClick={() => handleTracingModeSelect('aventure')}
        >
          <IconTelescope size={15} />
          <span>{t('Aventure')}</span>
        </button>
        <button
          type="button"
          className={`rv-dropdown__item${currentTracingMode === 'comfort' ? ' is-selected' : ''}`}
          onClick={() => handleTracingModeSelect('comfort')}
        >
          <IconComfort size={15} />
          <span>{t('Comfort')}</span>
        </button>
      </PortalDropdown>
    </div>
  );
}
