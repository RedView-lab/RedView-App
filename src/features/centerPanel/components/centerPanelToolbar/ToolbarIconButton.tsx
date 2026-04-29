import type { ReactNode } from 'react';

export function ToolbarIconButton({
  label,
  children,
  onClick,
  disabled,
  active,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      className={
        active
          ? 'rvc-center-toolbar__button rvc-center-toolbar__button--active'
          : 'rvc-center-toolbar__button'
      }
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}