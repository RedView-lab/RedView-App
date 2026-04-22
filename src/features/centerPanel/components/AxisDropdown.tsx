import { MapCanvasGlassBackdrop } from '@/components/MapCanvasGlassBackdrop';
import { IconCheck, IconChevronDown } from './CenterPanelIcons';

export interface AxisOption {
  value: string;
  label: string;
  tone: 'primary' | 'secondary';
}

interface AxisDropdownProps {
  axisLabel: string;
  value: string;
  isOpen: boolean;
  options: AxisOption[];
  onToggle: () => void;
  onSelect: (value: string) => void;
}

export function AxisDropdown({
  axisLabel,
  value,
  isOpen,
  options,
  onToggle,
  onSelect,
}: AxisDropdownProps) {
  return (
    <div className="rvc-center-analysis__axis-wrap">
      <div className="rvc-center-analysis__axis-label">
        {axisLabel}
        <span className="rvc-center-analysis__axis-underline" />
      </div>

      <button
        className="rvc-center-analysis__select"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={onToggle}
        title={value || '-'}
      >
        <span className="rvc-center-analysis__select-value">{value || '-'}</span>
        <IconChevronDown size={18} />
      </button>

      {isOpen ? (
        <div className="rvc-center-analysis__dropdown" role="listbox" aria-label={axisLabel}>
          <MapCanvasGlassBackdrop blur={30} saturate={1.8} />
          {options.map((option) => {
            const selected = value === option.value;
            return (
              <button
                key={option.value}
                className="rvc-center-analysis__dropdown-option"
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => onSelect(option.value)}
              >
                <span
                  className={
                    option.tone === 'primary'
                      ? 'rvc-center-analysis__dropdown-text rvc-center-analysis__dropdown-text--primary'
                      : 'rvc-center-analysis__dropdown-text rvc-center-analysis__dropdown-text--secondary'
                  }
                >
                  {option.label}
                </span>
                {selected ? <IconCheck size={16} className="rvc-center-analysis__dropdown-check" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
