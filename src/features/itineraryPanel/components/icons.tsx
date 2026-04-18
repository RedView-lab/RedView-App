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

// Matches Figma node 853:19503 (minus) — horizontal line inset 20.83% of a 20x20 square.
export const IconMinus = ({ size = 20, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
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

/**
 * Untitled-UI "magnifying glass" — matches Figma node 855:22699
 * (`Icon / magnifyingglass`). 14×14, 1.6 stroke.
 */
export const IconMagnifyingGlass = ({ size = 14, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <circle cx="6.2" cy="6.2" r="4.4" />
    <line x1="12.2" y1="12.2" x2="9.4" y2="9.4" />
  </svg>
);

/**
 * Untitled-UI "settings-04" — matches Figma node 170:4952. Two horizontal
 * sliders with knobs (top knob right, bottom knob left).
 */
export const IconSettings04 = ({ size = 16, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <line x1="2" y1="5" x2="14" y2="5" />
    <line x1="2" y1="11" x2="14" y2="11" />
    <circle cx="10.5" cy="5" r="1.6" fill="#000" />
    <circle cx="5.5" cy="11" r="1.6" fill="#000" />
  </svg>
);

/**
 * Untitled-UI "plus-circle" filled — matches Figma node 855:22703.
 * White plus inside a transparent ring; used by the red split-button.
 */
export const IconPlusCircleFilled = ({ size = 16, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <circle cx="8" cy="8" r="6.5" />
    <line x1="8" y1="5" x2="8" y2="11" />
    <line x1="5" y1="8" x2="11" y2="8" />
  </svg>
);

/**
 * "Mobile_Ios_Map_Checkpoint" — Figma node 855:20895. Black filled circle
 * with a white play-triangle inside, used as the "Départ" marker.
 */
export const IconCheckpointStart = ({ size = 20, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" {...p}>
    <circle cx="10" cy="10" r="9" fill="#0e0e0e" stroke="rgba(255,255,255,0.18)" strokeWidth="0.6" />
    <path d="M8 6.6 L13.6 10 L8 13.4 Z" fill="#fff" />
  </svg>
);

/**
 * "Fin" iOS-style checkered flag map marker — Figma node 855:20564.
 * White/black grid pattern on a flag pole in a rounded square.
 */
export const IconCheckpointEndMarker = ({ size = 20, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" {...p}>
    <rect x="1.6" y="1.6" width="16.8" height="16.8" rx="4.4" fill="#0e0e0e" stroke="rgba(255,255,255,0.18)" strokeWidth="0.6" />
    {/* 4×4 checker pattern centred. Cells 2×2 starting at (5,5) */}
    <g fill="#fff">
      <rect x="5"  y="5"  width="2" height="2" />
      <rect x="9"  y="5"  width="2" height="2" />
      <rect x="13" y="5"  width="2" height="2" />
      <rect x="7"  y="7"  width="2" height="2" />
      <rect x="11" y="7"  width="2" height="2" />
      <rect x="5"  y="9"  width="2" height="2" />
      <rect x="9"  y="9"  width="2" height="2" />
      <rect x="13" y="9"  width="2" height="2" />
      <rect x="7"  y="11" width="2" height="2" />
      <rect x="11" y="11" width="2" height="2" />
      <rect x="5"  y="13" width="2" height="2" />
      <rect x="9"  y="13" width="2" height="2" />
      <rect x="13" y="13" width="2" height="2" />
    </g>
  </svg>
);

/**
 * Waypoint dot — Figma node 855:20775. Red filled circle with a
 * darker red ring (Group12635). Used for the generic "Point de passage".
 */
export const IconWaypointDot = ({ size = 20, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" {...p}>
    <circle cx="10" cy="10" r="8.2" fill="#fff" />
    <circle cx="10" cy="10" r="5.4" fill="#c50000" />
    <circle cx="10" cy="10" r="2.2" fill="#fff" fillOpacity="0.92" />
  </svg>
);

/**
 * Teardrop pin (Ellipse + tooltip-shape composite from Figma — nodes
 * 855:20633 + 855:20635). A circular head with a small downward tip,
 * filled with `color`. Renders the white icon centred in the head.
 *
 * The tip points downward at ~42° from the bottom of the head.
 */
export const IconTeardropPin = ({
  size = 20,
  color = '#1e5fc7',
  ...p
}: IconProps & { color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" {...p}>
    {/* Soft drop shadow under the pin head */}
    <ellipse cx="10" cy="17.5" rx="3.4" ry="0.7" fill="#000" fillOpacity="0.35" />
    {/* Tip — slim triangle tucked under the circle (Figma rotated rect with -4° skew) */}
    <path
      d={`M ${10 - 1.7} ${10 + 5}
          L ${10 + 1.7} ${10 + 5}
          L 10 ${10 + 8.2}
          Z`}
      fill={color}
    />
    {/* Head */}
    <circle cx="10" cy="10" r="6.7" fill={color} />
    {/* Subtle inner ring (matches Figma's translucent stroke on the ellipse) */}
    <circle cx="10" cy="10" r="6.7" fill="none" stroke="rgba(0,0,0,0.18)" strokeWidth="0.7" />
  </svg>
);

/**
 * "Pause" badge — Figma node 855:20798. Filled dark circle with the
 * pause-circle icon centred. Smaller than the teardrop pins.
 */
export const IconPauseBadge = ({ size = 20, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" {...p}>
    <circle cx="10" cy="10" r="8.2" fill="#3a3a3a" stroke="rgba(255,255,255,0.22)" strokeWidth="0.7" />
    <circle cx="10" cy="10" r="4.6" fill="none" stroke="#fff" strokeWidth="1.4" />
    <line x1="8.6" y1="8.4" x2="8.6" y2="11.6" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
    <line x1="11.4" y1="8.4" x2="11.4" y2="11.6" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

/* -- POI category icons (white glyphs sized for the teardrop pin head) -- */

export const IconToilet = ({ size = 10, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" {...p}>
    <circle cx="4.5" cy="2.5" r="1.5" />
    <path d="M3 5h3l1 5H5l-.5 4h-2L2 10H1z" />
    <circle cx="11.5" cy="2.5" r="1.5" />
    <path d="M9.5 5h4l1 4h-1.5v5h-3V9H8.5z" />
  </svg>
);

export const IconFuel = ({ size = 10, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <rect x="2" y="2" width="7" height="12" rx="1" />
    <line x1="2" y1="6" x2="9" y2="6" />
    <path d="M9 7l3 1v4a1.5 1.5 0 0 0 1.5 1.5" />
    <path d="M11 4l1.5 2" />
  </svg>
);

export const IconBakery = ({ size = 10, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" {...p}>
    <ellipse cx="8" cy="8.5" rx="6" ry="3.5" />
    <path d="M5 6l1 5M8 5l0 6M11 6l-1 5" stroke="#000" strokeOpacity="0.25" strokeWidth="1" fill="none" strokeLinecap="round" />
  </svg>
);

export const IconBurger = ({ size = 10, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" {...p}>
    <path d="M2 5a6 6 0 0 1 12 0z" />
    <rect x="1.5" y="6.5" width="13" height="2" rx="1" />
    <path d="M2 10h12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z" />
  </svg>
);

export const IconCoffee = ({ size = 10, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M2 5h9v5a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z" />
    <path d="M11 6h1.5a1.5 1.5 0 0 1 0 3H11" />
    <path d="M4 2v1.5M7 2v1.5" />
  </svg>
);

export const IconBeer = ({ size = 10, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M3.5 3.5h7v9.5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1z" />
    <path d="M10.5 5.5h1.5a1.5 1.5 0 0 1 1.5 1.5v3.5a1.5 1.5 0 0 1-1.5 1.5h-1.5" />
    <line x1="5.5" y1="6" x2="5.5" y2="11" />
    <line x1="8.5" y1="6" x2="8.5" y2="11" />
  </svg>
);

export const IconUtensils = ({ size = 10, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M4 2v5a2 2 0 0 0 2 2v5" />
    <line x1="4" y1="2" x2="4" y2="9" />
    <path d="M10 14V8c0-2 2-3 2-5V2h-2v6" />
  </svg>
);

export const IconBicycle = ({ size = 10, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <circle cx="3.5" cy="11" r="2.5" />
    <circle cx="12.5" cy="11" r="2.5" />
    <path d="M3.5 11l3-5h3.5l2.5 5" />
    <path d="M6.5 6h2" />
  </svg>
);

export const IconBed = ({ size = 10, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M2 12V5" />
    <path d="M2 9h12v3" />
    <path d="M14 12V8a2 2 0 0 0-2-2H7v3" />
    <circle cx="5" cy="7.5" r="1.2" />
  </svg>
);

export const IconTent = ({ size = 10, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M8 2L2 13h12z" />
    <path d="M8 2v11" />
    <path d="M5 13l3-4 3 4" />
  </svg>
);

export const IconMountain = ({ size = 10, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" {...p}>
    <path d="M1 13l4.5-7 3 4.5 1.5-2 5 4.5z" />
  </svg>
);
