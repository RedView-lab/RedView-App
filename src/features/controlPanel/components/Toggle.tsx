interface ToggleProps {
  checked: boolean;
  onChange?: (next: boolean) => void;
  ariaLabel?: string;
}

/** _Toggle base — red track, white knob, slides to the right when on. */
export function Toggle({ checked, onChange, ariaLabel }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`rvc-toggle${checked ? ' is-on' : ''}`}
      onClick={() => onChange?.(!checked)}
    >
      <span className="rvc-toggle__knob" />
    </button>
  );
}
