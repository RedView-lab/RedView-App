import { PanelSelect } from './PanelSelect';
import type { RoadPreference } from '../../types';

const ROAD_PREF_OPTIONS: { value: RoadPreference; label: string }[] = [
  { value: 'prefer', label: 'Prioriser' },
  { value: 'tolerate', label: 'Tolérer' },
  { value: 'avoid', label: 'Éviter' },
  { value: 'forbid', label: 'Interdire' },
];

interface LabeledSelectProps {
  label: string;
  value: RoadPreference;
  onChange?: (v: RoadPreference) => void;
}

/** Two-column row: label on the left, narrow dropdown on the right. */
export function LabeledSelect({ label, value, onChange }: LabeledSelectProps) {
  return (
    <div className="rvi-lfield">
      <span className="rvi-lfield__label" title={label}>
        {label}
      </span>
      <PanelSelect<RoadPreference>
        value={value}
        options={ROAD_PREF_OPTIONS}
        onChange={onChange}
        ariaLabel={label}
      />
    </div>
  );
}

interface LabeledInputProps {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'number';
  suffix?: string;
}

/** Two-column row with a read-only-ish text input on the right. */
export function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  suffix,
}: LabeledInputProps) {
  return (
    <div className="rvi-lfield">
      <span className="rvi-lfield__label" title={label}>
        {label}
      </span>
      <div className="rvi-input">
        <input
          className="rvi-input__native"
          type={type}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          aria-label={label}
        />
        {suffix ? <span style={{ fontSize: 12, opacity: 0.64 }}>{suffix}</span> : null}
      </div>
    </div>
  );
}
