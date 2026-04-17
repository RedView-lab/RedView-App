import { IconCheck } from '../icons';

interface CheckboxProps {
  checked: boolean;
  onChange?: (next: boolean) => void;
  label?: string;
  id?: string;
}

export function Checkbox({ checked, onChange, label, id }: CheckboxProps) {
  return (
    <label className="rvc-checkbox" htmlFor={id}>
      <span className={`rvc-checkbox__box${checked ? ' is-checked' : ''}`}>
        {checked ? <IconCheck size={10} /> : null}
      </span>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange?.(e.target.checked)}
        className="rvc-checkbox__input"
      />
      {label ? <span className="rvc-checkbox__label">{label}</span> : null}
    </label>
  );
}
