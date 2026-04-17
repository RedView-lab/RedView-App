import { IconEye, IconEyeOff } from '../icons';

interface VisibilityButtonProps {
  visible: boolean;
  onChange?: (visible: boolean) => void;
  size?: 'sm' | 'md';
  /** Style variant: filled chip (active item) or transparent chip. */
  variant?: 'chip' | 'chipActive';
}

/** 20x20 chip-style visibility toggle, used in list rows (basemaps, LIDAR tiles, etc.). */
export function VisibilityButton({
  visible,
  onChange,
  size = 'md',
  variant = 'chipActive',
}: VisibilityButtonProps) {
  return (
    <button
      type="button"
      className={`rvc-visibility rvc-visibility--${size} rvc-visibility--${variant}${
        visible ? ' is-visible' : ''
      }`}
      onClick={() => onChange?.(!visible)}
      aria-pressed={visible}
      aria-label={visible ? 'Masquer' : 'Afficher'}
    >
      {visible ? <IconEye size={10} /> : <IconEyeOff size={10} />}
    </button>
  );
}
