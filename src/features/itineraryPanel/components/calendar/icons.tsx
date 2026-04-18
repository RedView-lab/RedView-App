import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const base = (size: number): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
});

/** Figma I1710:47397;1710:47194 — chevron-left, 20×20 viewBox bounds. */
export const IconChevronLeft = ({ size = 20, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

/** Figma I1710:47397;1710:47196 — chevron-right. */
export const IconChevronRight = ({ size = 20, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <polyline points="9 18 15 12 9 6" />
  </svg>
);
