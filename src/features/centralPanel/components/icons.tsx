/**
 * Icons used by the Central Panel. Re-exports the shared right-dock set
 * for visual consistency, plus a few panel-specific glyphs.
 */
import type { SVGProps } from 'react';

export {
  IconChevronDown,
  IconCheck,
  IconPlusCircle,
  IconEye,
  IconEyeOff,
  IconTrash,
} from '@/features/controlPanel/icons';

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

export const IconSettings = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <line x1="4" y1="6" x2="14" y2="6" />
    <circle cx="17" cy="6" r="2.2" />
    <line x1="20" y1="6" x2="20" y2="6" />
    <line x1="4" y1="12" x2="8" y2="12" />
    <circle cx="11" cy="12" r="2.2" />
    <line x1="14" y1="12" x2="20" y2="12" />
    <line x1="4" y1="18" x2="14" y2="18" />
    <circle cx="17" cy="18" r="2.2" />
    <line x1="20" y1="18" x2="20" y2="18" />
  </svg>
);

export const IconDots = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <circle cx="12" cy="5" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="12" cy="19" r="1" />
  </svg>
);

export const IconSun = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <circle cx="12" cy="12" r="4" />
    <line x1="12" y1="2" x2="12" y2="4" />
    <line x1="12" y1="20" x2="12" y2="22" />
    <line x1="4" y1="12" x2="2" y2="12" />
    <line x1="22" y1="12" x2="20" y2="12" />
    <line x1="5" y1="5" x2="6.5" y2="6.5" />
    <line x1="17.5" y1="17.5" x2="19" y2="19" />
    <line x1="5" y1="19" x2="6.5" y2="17.5" />
    <line x1="17.5" y1="6.5" x2="19" y2="5" />
  </svg>
);

export const IconMoon = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

export const IconWaypointMarker = ({ size = 12, ...p }: IconProps) => (
  <svg {...p} width={size} height={size} viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="6" fill="#E10600" />
    <circle cx="8" cy="8" r="2.4" fill="#0a0a0c" />
  </svg>
);

export const IconPoiPin = ({ size = 12, ...p }: IconProps) => (
  <svg {...p} width={size} height={size} viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth={1.5} />
  </svg>
);

export const IconPause = ({ size = 12, ...p }: IconProps) => (
  <svg {...p} width={size} height={size} viewBox="0 0 16 16" fill="none">
    <rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor" />
    <rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor" />
  </svg>
);

export const IconAlertTriangle = ({ size = 12, ...p }: IconProps) => (
  <svg {...p} width={size} height={size} viewBox="0 0 16 16" fill="none">
    <path
      d="M8 2L14.5 13H1.5L8 2Z"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinejoin="round"
    />
    <line x1="8" y1="6.5" x2="8" y2="9.5" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    <circle cx="8" cy="11.5" r="0.6" fill="currentColor" />
  </svg>
);

export const IconSlope = ({ size = 12, ...p }: IconProps) => (
  <svg {...p} width={size} height={size} viewBox="0 0 16 16" fill="none">
    <path d="M2 13L14 4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    <path d="M2 13H14" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
  </svg>
);

export const IconDayNight = ({ size = 12, ...p }: IconProps) => (
  <svg {...p} width={size} height={size} viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth={1.4} />
    <path d="M8 3 A5 5 0 0 1 8 13Z" fill="currentColor" />
  </svg>
);

export const IconWaterDrop = ({ size = 12, ...p }: IconProps) => (
  <svg {...p} width={size} height={size} viewBox="0 0 16 16" fill="none">
    <path
      d="M8 2C8 2 3 7.5 3 10.5C3 13.5 5.24 15 8 15C10.76 15 13 13.5 13 10.5C13 7.5 8 2 8 2Z"
      fill="currentColor"
    />
  </svg>
);
