import { IconCheck } from '../icons';
import { useAppI18n } from '@/shared/i18n';

interface CheckboxProps {
  checked: boolean;
  onChange?: (next: boolean) => void;
  label?: string;
  id?: string;
}

export function Checkbox({ checked, onChange, label, id }: CheckboxProps) {
  const { t } = useAppI18n();

  return (
    <label className="rvc-cp-checkbox" htmlFor={id}>
      <span className={`rvc-cp-checkbox__box${checked ? ' is-checked' : ''}`}>
        {checked ? <IconCheck size={10} /> : null}
      </span>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange?.(e.target.checked)}
        className="rvc-cp-checkbox__input"
      />
      {label ? <span className="rvc-cp-checkbox__label">{t(label)}</span> : null}
    </label>
  );
}
