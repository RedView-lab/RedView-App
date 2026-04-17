/**
 * Icons used by the Itinerary Panel.
 *
 * We re-export shared primitives from the right-dock icon set so the visual
 * language stays consistent across panels.
 */
import type { SVGProps } from 'react';

export {
  IconChevronDown,
  IconCheck,
  IconPlusCircle,
  IconCalendar,
  IconClock,
  IconEye,
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

export const IconArrowLeft = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <line x1="19" y1="12" x2="5" y2="12" />
    <polyline points="12 19 5 12 12 5" />
  </svg>
);

export const IconSave = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </svg>
);

export const IconSettingsCog = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export const IconSettingsSliders = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <line x1="4" y1="21" x2="4" y2="14" />
    <line x1="4" y1="10" x2="4" y2="3" />
    <line x1="12" y1="21" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12" y2="3" />
    <line x1="20" y1="21" x2="20" y2="16" />
    <line x1="20" y1="12" x2="20" y2="3" />
    <line x1="1" y1="14" x2="7" y2="14" />
    <line x1="9" y1="8" x2="15" y2="8" />
    <line x1="17" y1="16" x2="23" y2="16" />
  </svg>
);

export const IconDownload = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

export const IconDownloadCircle = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="8 12 12 16 16 12" />
    <line x1="12" y1="8" x2="12" y2="16" />
  </svg>
);

export const IconShare = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
    <polyline points="16 6 12 2 8 6" />
    <line x1="12" y1="2" x2="12" y2="15" />
  </svg>
);

export const IconUpload = ({ size = 12, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

export const IconRoute = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <circle cx="6" cy="19" r="3" />
    <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
    <circle cx="18" cy="5" r="3" />
  </svg>
);

export const IconStopwatch = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <line x1="10" y1="2" x2="14" y2="2" />
    <line x1="12" y1="14" x2="15" y2="11" />
    <circle cx="12" cy="14" r="8" />
  </svg>
);

export const IconMapPin = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
    <circle cx="12" cy="10" r="3" />
  </svg>
);

export const IconNutrition = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M12 3c-1 3-4 4-4 8 0 4 2 7 4 10 2-3 4-6 4-10 0-4-3-5-4-8z" />
    <path d="M8 14c1-1 3-1 4 0" />
  </svg>
);

export const IconCornerUpLeft = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <polyline points="9 14 4 9 9 4" />
    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
  </svg>
);

export const IconCornerUpRight = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <polyline points="15 14 20 9 15 4" />
    <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
  </svg>
);

export const IconSearch = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

export const IconUploadCloud = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M16 16l-4-4-4 4" />
    <path d="M12 12v9" />
    <path d="M20.4 14.5A5 5 0 0 0 18 5h-1.3A8 8 0 1 0 4 12.7" />
    <path d="M16 16l-4-4-4 4" />
  </svg>
);

export const IconSparkles = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
    <path d="M19 14l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
  </svg>
);

export const IconClose = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export const IconLayoutGrid = ({ size = 12, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <rect x="3" y="3" width="7" height="7" />
    <rect x="14" y="3" width="7" height="7" />
    <rect x="3" y="14" width="7" height="7" />
    <rect x="14" y="14" width="7" height="7" />
  </svg>
);

export const IconClockFastForward = ({ size = 12, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <circle cx="12" cy="12" r="9" />
    <polyline points="12 7 12 12 15 14" />
  </svg>
);

export const IconStar = ({ size = 12, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

export const IconInfo = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>
);

export const IconPlus = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export const IconRepeat = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <polyline points="17 1 21 5 17 9" />
    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <polyline points="7 23 3 19 7 15" />
    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </svg>
);

export const IconCheckpointFlag = ({ size = 20, ...p }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 20 20"
    fill="currentColor"
    {...p}
  >
    <rect x="9.25" y="3" width="1.5" height="14" rx="0.3" />
    <path d="M10.5 3.8l6 1.6-6 1.6z" />
  </svg>
);

export const IconCheckpointEnd = ({ size = 20, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" {...p}>
    <rect x="4" y="5" width="3" height="3" />
    <rect x="10" y="5" width="3" height="3" />
    <rect x="7" y="8" width="3" height="3" />
    <rect x="13" y="8" width="3" height="3" />
    <rect x="4" y="11" width="3" height="3" />
    <rect x="10" y="11" width="3" height="3" />
    <rect x="5.5" y="3" width="2" height="14" />
    <rect x="11.5" y="3" width="2" height="14" />
  </svg>
);

export const IconDroplet = ({ size = 12, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M12 2.5c-.4 0-.78.2-1 .55C9.4 5.6 5 9.6 5 14a7 7 0 0 0 14 0c0-4.4-4.4-8.4-6-10.95-.22-.34-.6-.55-1-.55z" />
  </svg>
);

export const IconShoppingCart = ({ size = 12, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <circle cx="9" cy="20" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="17" cy="20" r="1.6" fill="currentColor" stroke="none" />
    <path d="M3 4h2.2l2.4 10.2a2 2 0 0 0 2 1.55h7.6a2 2 0 0 0 1.95-1.6L20.5 7H6.4" />
  </svg>
);

export const IconPauseCircle = ({ size = 12, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" {...p}>
    <circle cx="12" cy="12" r="10" />
    <line x1="10" y1="8.5" x2="10" y2="15.5" />
    <line x1="14" y1="8.5" x2="14" y2="15.5" />
  </svg>
);

/**
 * Teardrop pin shape — rounded top + pointed bottom, designed to be filled
 * with the kind color. Used as the background of the Eau / Supermarché / Fin
 * badges in the Feuille de route.
 */
export const IconPinShape = ({ size = 22, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none" {...p}>
    <path d="M12 1.5a8.5 8.5 0 0 0-8.5 8.5c0 2.4 1 4.4 2.5 6.2 1.4 1.7 3.2 3.1 4.6 4.4.7.6 1.8.6 2.5 0 1.4-1.3 3.2-2.7 4.6-4.4 1.6-1.8 2.8-3.8 2.8-6.2A8.5 8.5 0 0 0 12 1.5z" />
  </svg>
);

/** Tiny checkered flag used inside the "Fin" pin. */
export const IconFlagCheckered = ({ size = 10, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" {...p}>
    <rect x="1" y="2" width="3" height="3" />
    <rect x="7" y="2" width="3" height="3" />
    <rect x="4" y="5" width="3" height="3" />
    <rect x="10" y="5" width="3" height="3" />
    <rect x="1" y="8" width="3" height="3" />
    <rect x="7" y="8" width="3" height="3" />
  </svg>
);
