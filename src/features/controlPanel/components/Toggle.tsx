interface ToggleProps {
  checked: boolean;
  onChange?: (next: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
}

/** _Toggle base — interrupteur rouge Figma : piste translucide (OFF), #890000 (ON), bouton blanc avec bordure de 1 px. */
export function Toggle({ checked, onChange, ariaLabel, disabled = false }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-disabled={disabled}
      disabled={disabled}
      className={`rvc-toggle${checked ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`}
      onClick={() => {
        if (disabled) return;
        onChange?.(!checked);
      }}
    >
      <span className="rvc-toggle__knob" />
    </button>
  );
}
