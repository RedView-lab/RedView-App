/**
 * Inline SVG icons used by the Control Panel.
 * Sizes are driven via the `size` prop and CSS (currentColor).
 */
import type { SVGProps } from 'react';
import { AssetIcon, type AssetIconProps } from '@/components/AssetIcon';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const CONTROL_PANEL_ICON_ASSETS = {
  map: '/svgv2/icone/map-02.svg',
  eye: '/svgv2/icone/eye.svg',
  eyeOff: '/svgv2/icone/eye-off.svg',
  cube: '/svgv2/icone/cube-outline.svg',
  trash: '/svgv2/icone/trash-03.svg',
  externalLink: '/svgv2/icone/link-external-02.svg',
  share: '/svgv2/icone/share-07.svg',
  download: '/svgv2/icone/download-01.svg',
  expand: '/svgv2/icone/scale-01.svg',
  check: '/svgv2/icone/check.svg',
  plusCircle: '/svgv2/icone/plus-circle.svg',
  calendar: '/svgv2/icone/calendar.svg',
  info: '/svgv2/icone/info-circle.svg',
} as const;

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

export const IconMap = ({ size = 12, ...rest }: AssetIconProps) => (
  <AssetIcon src={CONTROL_PANEL_ICON_ASSETS.map} size={size} {...rest} />
);

export const IconChevronDown = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

export const IconEye = ({ size = 10, ...rest }: AssetIconProps) => (
  <AssetIcon src={CONTROL_PANEL_ICON_ASSETS.eye} size={size} {...rest} />
);

export const IconEyeOff = ({ size = 10, ...rest }: AssetIconProps) => (
  <AssetIcon src={CONTROL_PANEL_ICON_ASSETS.eyeOff} size={size} {...rest} />
);

export const IconCube = ({ size = 12, ...rest }: AssetIconProps) => (
  <AssetIcon src={CONTROL_PANEL_ICON_ASSETS.cube} size={size} {...rest} />
);

export const IconTrash = ({ size = 10, ...rest }: AssetIconProps) => (
  <AssetIcon src={CONTROL_PANEL_ICON_ASSETS.trash} size={size} {...rest} />
);

export const IconExternalLink = ({ size = 14, ...rest }: AssetIconProps) => (
  <AssetIcon src={CONTROL_PANEL_ICON_ASSETS.externalLink} size={size} {...rest} />
);

export const IconShare01 = ({ size = 12, ...rest }: AssetIconProps) => (
  <AssetIcon src={CONTROL_PANEL_ICON_ASSETS.share} size={size} {...rest} />
);

export const IconDownload01 = ({ size = 20, ...rest }: AssetIconProps) => (
  <AssetIcon src={CONTROL_PANEL_ICON_ASSETS.download} size={size} {...rest} />
);

export const IconExpand = ({ size = 18, ...rest }: AssetIconProps) => (
  <AssetIcon src={CONTROL_PANEL_ICON_ASSETS.expand} size={size} {...rest} />
);

export const IconCheck = ({ size = 10, ...rest }: AssetIconProps) => (
  <AssetIcon src={CONTROL_PANEL_ICON_ASSETS.check} size={size} {...rest} />
);

export const IconPlusCircle = ({ size = 12, ...rest }: AssetIconProps) => (
  <AssetIcon src={CONTROL_PANEL_ICON_ASSETS.plusCircle} size={size} {...rest} />
);

export const IconCalendar = ({ size = 12, ...rest }: AssetIconProps) => (
  <AssetIcon src={CONTROL_PANEL_ICON_ASSETS.calendar} size={size} {...rest} />
);

export const IconClock = ({ size = 12, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

export const IconInfo = ({ size = 16, ...rest }: AssetIconProps) => (
  <AssetIcon src={CONTROL_PANEL_ICON_ASSETS.info} size={size} {...rest} />
);
export const IconSunrise = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M17 18a5 5 0 0 0-10 0" />
    <line x1="12" y1="2" x2="12" y2="9" />
    <line x1="4.22" y1="10.22" x2="5.64" y2="11.64" />
    <line x1="1" y1="18" x2="3" y2="18" />
    <line x1="21" y1="18" x2="23" y2="18" />
    <line x1="18.36" y1="11.64" x2="19.78" y2="10.22" />
    <line x1="23" y1="22" x2="1" y2="22" />
    <polyline points="8 6 12 2 16 6" />
  </svg>
);

export const IconSunset = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M17 18a5 5 0 0 0-10 0" />
    <line x1="12" y1="9" x2="12" y2="2" />
    <line x1="4.22" y1="10.22" x2="5.64" y2="11.64" />
    <line x1="1" y1="18" x2="3" y2="18" />
    <line x1="21" y1="18" x2="23" y2="18" />
    <line x1="18.36" y1="11.64" x2="19.78" y2="10.22" />
    <line x1="23" y1="22" x2="1" y2="22" />
    <polyline points="16 5 12 9 8 5" />
  </svg>
);
