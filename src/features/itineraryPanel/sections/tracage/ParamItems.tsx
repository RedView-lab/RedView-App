import { useRef, useState } from 'react';
import { useAppI18n } from '@/shared/i18n';
import type { RoadPreference } from '../../types';
import { IconFigmaChevronDown } from '../../components/iconsFigma';
import { PortalDropdown } from '../../components/controls/PortalDropdown';
import { ROAD_PREF_OPTIONS } from './activity';

/**
 * 88px Dropdown Item with red border & unclipped Portal positioning.
 */
export function ParamDropdownItem({
  label,
  value,
  onChange,
}: {
  label: string;
  value: RoadPreference;
  onChange: (val: RoadPreference) => void;
}) {
  const { t } = useAppI18n();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const selectedOption = ROAD_PREF_OPTIONS.find((o) => o.value === value) ?? ROAD_PREF_OPTIONS[1];

  return (
    <div className="rvi-tracage__param-item">
      <span className="rvi-tracage__param-label" title={label}>
        {label}
      </span>
      <button
        ref={btnRef}
        type="button"
        className={`rvi-tracage__param-btn${open ? ' is-open' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-label={label}
      >
        <span className="rvi-tracage__param-btn-text">{t(selectedOption.label)}</span>
        <IconFigmaChevronDown size={12} />
      </button>

      <PortalDropdown
        open={open}
        anchorRef={btnRef}
        onClose={() => setOpen(false)}
        align="right"
        estimatedHeight={138}
      >
        {ROAD_PREF_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`rv-dropdown__item${opt.value === value ? ' is-selected' : ''}`}
            onClick={() => {
              onChange(opt.value);
              setOpen(false);
            }}
          >
            <span>{t(opt.label)}</span>
          </button>
        ))}
      </PortalDropdown>
    </div>
  );
}

/**
 * Slope (Pente max) Picker with red border & unclipped Portal positioning.
 */
export function SlopeParamItem({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: number[];
  onChange: (val: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="rvi-tracage__param-item">
      <span className="rvi-tracage__param-label" title={label}>
        {label}
      </span>
      <button
        ref={btnRef}
        type="button"
        className={`rvi-tracage__param-btn${open ? ' is-open' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-label={label}
      >
        <span className="rvi-tracage__param-btn-text">{`${value}%`}</span>
        <IconFigmaChevronDown size={12} />
      </button>

      <PortalDropdown
        open={open}
        anchorRef={btnRef}
        onClose={() => setOpen(false)}
        align="right"
        estimatedHeight={180}
      >
        {options.map((val) => (
          <button
            key={val}
            type="button"
            className={`rv-dropdown__item${val === value ? ' is-selected' : ''}`}
            onClick={() => {
              onChange(val);
              setOpen(false);
            }}
          >
            <span>{`${val}%`}</span>
          </button>
        ))}
      </PortalDropdown>
    </div>
  );
}
