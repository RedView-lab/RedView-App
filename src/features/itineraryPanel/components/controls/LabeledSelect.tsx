import { useAppI18n } from '@/shared/i18n';
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
  const { t } = useAppI18n();

  return (
    <div className="rvi-lfield">
      <span className="rvi-lfield__label" title={t(label)}>
        {t(label)}
      </span>
      <PanelSelect<RoadPreference>
        value={value}
        options={ROAD_PREF_OPTIONS}
        onChange={onChange}
        ariaLabel={t(label)}
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
  const { t } = useAppI18n();

  return (
    <div className="rvi-lfield">
      <span className="rvi-lfield__label" title={t(label)}>
        {t(label)}
      </span>
      <div className="rvi-input">
        <input
          className="rvi-input__native"
          type={type}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder ? t(placeholder) : undefined}
          aria-label={t(label)}
        />
        {suffix ? <span style={{ fontSize: 12, opacity: 0.64 }}>{suffix}</span> : null}
      </div>
    </div>
  );
}
