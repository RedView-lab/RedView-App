import { memo } from 'react';

export interface FreeCamViewportButtonProps {
  isActive: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export const FreeCamViewportButton = memo(function FreeCamViewportButton({
  isActive,
  onToggle,
  disabled = false,
}: FreeCamViewportButtonProps) {
  return (
    <button
      type="button"
      className={`rvmvc-map-tools__button rvmvc-map-tools__button--label${isActive ? ' is-active' : ' is-inactive'}`}
      aria-label={isActive ? 'Quitter le mode Free Cam' : 'Activer le mode Free Cam (Alt + Espace)'}
      aria-pressed={isActive}
      title={isActive ? 'Quitter Free Cam (Alt + Espace)' : 'Caméra Libre (Alt + Espace)'}
      onClick={onToggle}
      disabled={disabled}
      style={{
        fontWeight: 700,
        fontSize: '11px',
        letterSpacing: '0.04em',
      }}
    >
      <span>{isActive ? 'FLY' : 'CAM'}</span>
    </button>
  );
});
