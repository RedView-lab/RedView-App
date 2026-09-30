import { useAppI18n } from '@/shared/i18n';
import { ColorPalettePicker } from '@/features/controlPanel/components/ColorPalettePicker';
import { IconChevronDown } from '../CenterPanelIcons';

export interface AxisOption {
  value: string;
  label: string;
  tone: 'primary' | 'secondary';
}

interface AxisDropdownProps {
  axisLabel: string;
  axisColor: string;
  value: string | null;
  isOpen: boolean;
  options: AxisOption[];
  onToggle: () => void;
  onColorChange: (color: string) => void;
  onSelect: (value: string) => void;
  isDashed?: boolean;
}

export function AxisDropdown({
  axisLabel,
  axisColor,
  value,
  isOpen,
  options,
  onToggle,
  onColorChange,
  onSelect,
  isDashed = false,
}: AxisDropdownProps) {
  const { t } = useAppI18n();
  const translatedAxisLabel = t(axisLabel);
  const isDisabled = !value || value === 'none';

  const selectedOption = options.find((opt) => (isDisabled ? opt.value === 'none' : opt.value === value));
  const displayLabel = selectedOption ? t(selectedOption.label) : (value ? t(value) : t('Désactivé'));

  return (
    <div className={`rvc-center-analysis__axis${isDisabled ? ' rvc-center-analysis__axis--disabled' : ''}`}>
      <ColorPalettePicker
        color={axisColor}
        onChange={onColorChange}
        className="rvc-center-analysis__axis-picker"
        ariaLabel={t('Choisir la couleur de {{name}}', { name: translatedAxisLabel })}
      >
        <span className="rvc-center-analysis__axis-meta" aria-hidden="true">
          <span className="rvc-center-analysis__axis-label">{translatedAxisLabel}</span>
          <span
            className={`rvc-center-analysis__axis-line${isDashed ? ' rvc-center-analysis__axis-line--dashed' : ''}`}
            style={isDashed ? { borderColor: axisColor } : { backgroundColor: axisColor }}
          />
        </span>
      </ColorPalettePicker>

      <div className="rvc-center-analysis__axis-wrap">
        <button
          className="rvc-center-analysis__select"
          type="button"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          onClick={onToggle}
          title={displayLabel}
        >
          <span className="rvc-center-analysis__select-value">{displayLabel}</span>
          <IconChevronDown size={14} className="rvc-center-analysis__select-icon" />
        </button>

        {isOpen ? (
          <div className="rv-dropdown rvc-center-analysis__dropdown" role="listbox" aria-label={translatedAxisLabel}>
            {options.map((option) => {
              const selected = value === option.value;
              return (
                <button
                  key={option.value}
                  className={`rv-dropdown__item${selected ? ' is-selected' : ''}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => onSelect(option.value)}
                >
                  <span className="rv-dropdown__label">{t(option.label)}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
