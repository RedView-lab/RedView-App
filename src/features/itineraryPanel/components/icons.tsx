/**
 * Icons used by the Itinerary Panel.
 *
 * We re-export shared primitives from the right-dock icon set so the visual
 * language stays consistent across panels.
 */
import type { SVGProps } from 'react';
import { AssetIcon, type AssetIconProps } from '@/components/AssetIcon';
import { PROVIDED_POI_SVG } from '@/features/poi/lib/providedPoiSvg';

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
type AssetGlyphProps = Omit<AssetIconProps, 'src'>;

const ITINERARY_ICON_ASSETS = {
  save: '/svgv2/icone/save-01.svg',
  settingsCog: '/svgv2/icone/settings-01.svg',
  settingsSliders: '/svgv2/icone/sliders-03.svg',
  download: '/svgv2/icone/download-01.svg',
  downloadCircle: '/svgv2/icone/download-03.svg',
  share: '/svgv2/icone/share-07.svg',
  upload: '/svgv2/icone/upload-01.svg',
  uploadCloud: '/svgv2/icone/upload-03.svg',
  route: '/svgv2/icone/route.svg',
  stopwatch: '/svgv2/icone/speedometer-03.svg',
  mapPin: '/svgv2/icone/marker-pin-02.svg',
  search: '/svgv2/icone/search-sm.svg',
  uploadCircle: '/svgv2/icone/upload-03.svg',
  copy: '/svgv2/icone/copy-04.svg',
  close: '/svgv2/icone/x-close.svg',
  layoutGrid: '/svgv2/icone/layers-three-02.svg',
  list: '/svgv2/icone/list.svg',
  star: '/svgv2/icone/star-01.svg',
  info: '/svgv2/icone/info-circle.svg',
  plus: '/svgv2/icone/plus.svg',
  repeat: '/svgv2/icone/refresh-cw-05.svg',
  pauseCircle: '/svgv2/icone/pause-circle.svg',
  checkpointFlag: '/svgv2/icone/flag-02.svg',
  magnifyingGlass: '/svgv2/icone/search-sm.svg',
  settings04: '/svgv2/icone/settings-04.svg',
  plusCircle: '/svgv2/icone/plus-circle.svg',
  bed: PROVIDED_POI_SVG.hotelGlyph,
  tent: PROVIDED_POI_SVG.refugeGlyph,
} as const;

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

export const IconSave = ({ size = 14, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.save} size={size} {...p} />
);

export const IconSettingsCog = ({ size = 16, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.settingsCog} size={size} {...p} />
);

export const IconSettingsSliders = ({ size = 16, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.settingsSliders} size={size} {...p} />
);

export const IconDownload = ({ size = 16, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.download} size={size} {...p} />
);

export const IconDownloadCircle = ({ size = 16, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.downloadCircle} size={size} {...p} />
);

export const IconShare = ({ size = 16, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.share} size={size} {...p} />
);

export const IconUpload = ({ size = 12, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.upload} size={size} {...p} />
);

export const IconRoute = ({ size = 16, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.route} size={size} {...p} />
);

export const IconStopwatch = ({ size = 16, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.stopwatch} size={size} {...p} />
);

export const IconMapPin = ({ size = 16, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.mapPin} size={size} {...p} />
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

export const IconSearch = ({ size = 14, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.search} size={size} {...p} />
);

export const IconUploadCloud = ({ size = 24, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.uploadCloud} size={size} {...p} />
);

export const IconUploadCircle = ({ size = 20, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.uploadCircle} size={size} {...p} />
);

export const IconCopy04 = ({ size = 20, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.copy} size={size} {...p} />
);

export const IconSparkles = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
    <path d="M19 14l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
  </svg>
);

export const IconClose = ({ size = 16, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.close} size={size} {...p} />
);

export const IconLayoutGrid = ({ size = 12, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.layoutGrid} size={size} {...p} />
);

export const IconList = ({ size = 16, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.list} size={size} {...p} />
);

export const IconClockFastForward = ({ size = 12, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <circle cx="12" cy="12" r="9" />
    <polyline points="12 7 12 12 15 14" />
  </svg>
);

export const IconStar = ({ size = 12, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.star} size={size} {...p} />
);

export const IconInfo = ({ size = 14, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.info} size={size} {...p} />
);

export const IconPlus = ({ size = 14, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.plus} size={size} {...p} />
);

// Matches Figma node 853:19503 (minus) — horizontal line inset 20.83% of a 20x20 square.
export const IconMinus = ({ size = 20, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export const IconRepeat = ({ size = 14, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.repeat} size={size} {...p} />
);

export const IconCheckpointFlag = ({ size = 20, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.checkpointFlag} size={size} {...p} />
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

export const IconPauseCircle = ({ size = 12, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.pauseCircle} size={size} {...p} />
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
export const IconMagnifyingGlass = ({ size = 14, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.magnifyingGlass} size={size} {...p} />
);

/**
 * Untitled-UI "settings-04" — matches Figma node 170:4952. Two horizontal
 * sliders with knobs (top knob right, bottom knob left).
 */
export const IconSettings04 = ({ size = 16, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.settings04} size={size} {...p} />
);

/**
 * Untitled-UI "plus-circle" filled — matches Figma node 855:22703.
 * White plus inside a transparent ring; used by the red split-button.
 */
export const IconPlusCircleFilled = ({ size = 16, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.plusCircle} size={size} {...p} />
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

export const IconBed = ({ size = 10, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.bed} size={size} {...p} />
);

export const IconTent = ({ size = 10, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.tent} size={size} {...p} />
);

export const IconMountain = ({ size = 10, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" {...p}>
    <path d="M1 13l4.5-7 3 4.5 1.5-2 5 4.5z" />
  </svg>
);
