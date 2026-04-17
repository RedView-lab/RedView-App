import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: 'ghost' | 'chip' | 'chipActive';
}

/** Small square utility button. */
export function IconButton({
  children,
  variant = 'ghost',
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={`rvc-icon-btn rvc-icon-btn--${variant}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </button>
  );
}
