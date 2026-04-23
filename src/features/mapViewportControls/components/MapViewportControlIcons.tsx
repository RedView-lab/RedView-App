import type { CSSProperties, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const baseIcon = (size = 18): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
});

export function IconMaximize({ size = 18, ...rest }: IconProps) {
  return (
    <svg {...baseIcon(size)} {...rest}>
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="m21 3-7 7" />
      <path d="m3 21 7-7" />
    </svg>
  );
}

export function IconZoomIn({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...baseIcon(size)} {...rest}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-3.5-3.5" />
      <path d="M11 8v6" />
      <path d="M8 11h6" />
    </svg>
  );
}

export function IconZoomOut({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...baseIcon(size)} {...rest}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-3.5-3.5" />
      <path d="M8 11h6" />
    </svg>
  );
}

export function IconCompass({ size = 20, rotation = 0, ...rest }: IconProps & { rotation?: number }) {
  return (
    <svg {...baseIcon(size)} {...rest}>
      <circle cx="12" cy="12" r="8" opacity="0.36" />
      <g style={{ transform: `rotate(${rotation}deg)`, transformOrigin: '12px 12px' } as CSSProperties}>
        <path d="m12 5.2 3.15 6.1L12 13.1l-3.15-1.8L12 5.2Z" fill="currentColor" stroke="none" />
        <path d="m12 18.8-3.15-6.1L12 10.9l3.15 1.8L12 18.8Z" fill="currentColor" opacity="0.35" stroke="none" />
      </g>
    </svg>
  );
}