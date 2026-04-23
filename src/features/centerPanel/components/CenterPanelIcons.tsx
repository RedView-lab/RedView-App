import type { SVGProps } from 'react';
import { AssetIcon, type AssetIconProps } from '@/components/AssetIcon';
import {
  IconCheck,
  IconChevronDown,
  IconEye,
} from '@/features/controlPanel/icons';
import { IconSettingsSliders } from '@/features/itineraryPanel/components/icons';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const base = (size = 16): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
});

export { IconCheck, IconChevronDown, IconEye, IconSettingsSliders };

export const IconDotsVertical = ({ size = 16, ...rest }: AssetIconProps) => (
  <AssetIcon src="/svgv2/icone/dots-vertical.svg" size={size} {...rest} />
);

export const IconSun = ({ size = 14, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="12" cy="12" r="3.5" />
    <line x1="12" y1="1.75" x2="12" y2="5" />
    <line x1="12" y1="19" x2="12" y2="22.25" />
    <line x1="1.75" y1="12" x2="5" y2="12" />
    <line x1="19" y1="12" x2="22.25" y2="12" />
    <line x1="4.3" y1="4.3" x2="6.75" y2="6.75" />
    <line x1="17.25" y1="17.25" x2="19.7" y2="19.7" />
    <line x1="17.25" y1="6.75" x2="19.7" y2="4.3" />
    <line x1="4.3" y1="19.7" x2="6.75" y2="17.25" />
  </svg>
);

export const IconMoon = ({ size = 14, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M18 15.2A7.2 7.2 0 0 1 8.8 6a7.8 7.8 0 1 0 9.2 9.2Z" />
  </svg>
);
