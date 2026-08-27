/**
 * Icons used by the Itinerary Panel.
 *
 * We re-export shared primitives from the right-dock icon set so the visual
 * language stays consistent across panels.
 */
import { AssetIcon, type AssetIconProps } from '@/shared/components/AssetIcon';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
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

type AssetGlyphProps = Omit<AssetIconProps, 'src'>;

function FullColorSvgIcon({
  src,
  size = 20,
  className,
  style,
  ...rest
}: AssetGlyphProps & { src: string }) {
  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        flex: '0 0 auto',
        ...style,
      }}
      {...rest}
    >
      <img src={src} alt="" aria-hidden style={{ width: '100%', height: '100%', display: 'block' }} />
    </span>
  );
}

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

export const IconArrowLeft = ({ size = 16, ...p }: AssetGlyphProps) => (
  <SvgV2Icon name="arrow-left.svg" size={size} {...p} />
);

export const IconFolder = ({ size = 20, className, style, ...rest }: AssetGlyphProps) => (
  <SvgV2Icon name="folder.svg" size={size} className={className} style={style} {...rest} />
);

export const IconFolderPlus = ({ size = 20, className, style, ...rest }: AssetGlyphProps) => (
  <SvgV2Icon name="folder-plus.svg" size={size} className={className} style={style} {...rest} />
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

export const IconNutrition = ({ size = 16, ...p }: AssetGlyphProps) => (
  <SvgV2Icon name="nutrition.svg" size={size} {...p} />
);

export const IconCornerUpLeft = ({ size = 16, ...p }: AssetGlyphProps) => (
  <SvgV2Icon name="corner-up-left.svg" size={size} {...p} />
);

export const IconCornerUpRight = ({ size = 16, ...p }: AssetGlyphProps) => (
  <SvgV2Icon name="corner-up-right.svg" size={size} {...p} />
);

export const IconSearch = ({ size = 14, ...p }: AssetGlyphProps) => (
  <SvgV2Icon name="magnifyingglass.svg" size={size} {...p} />
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

export const IconSparkles = ({ size = 24, ...p }: AssetGlyphProps) => (
  <SvgV2Icon name="sparkles.svg" size={size} {...p} />
);

export const IconClose = ({ size = 16, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.close} size={size} {...p} />
);

export const IconLayoutGrid = ({ size = 12, ...p }: AssetGlyphProps) => (
  <SvgV2Icon name="layout-grid-02.svg" size={size} {...p} />
);

export const IconList = ({ size = 16, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.list} size={size} {...p} />
);

export const IconClockFastForward = ({ size = 12, ...p }: AssetGlyphProps) => (
  <SvgV2Icon name="clock-fast-forward.svg" size={size} {...p} />
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

export const IconMinus = ({ size = 14, className, style, ...rest }: AssetGlyphProps) => (
  <span
    className={className}
    style={{
      width: size,
      height: size,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 auto',
      ...style,
    }}
    {...rest}
  >
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  </span>
);

export const IconRepeat = ({ size = 14, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.repeat} size={size} {...p} />
);

export const IconCheckpointFlag = ({ size = 20, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.checkpointFlag} size={size} {...p} />
);

export const IconCheckpointEnd = ({ size = 20, ...p }: AssetGlyphProps) => (
  <FullColorSvgIcon src="/svgv2/icone/checkpoint-end.svg" size={size} {...p} />
);

export const IconDroplet = ({ size = 12, ...p }: AssetGlyphProps) => (
  <AssetIcon src={PROVIDED_POI_SVG.water} size={size} {...p} />
);

export const IconShoppingCart = ({ size = 12, ...p }: AssetGlyphProps) => (
  <AssetIcon src={PROVIDED_POI_SVG.shop} size={size} {...p} />
);

export const IconPauseCircle = ({ size = 12, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.pauseCircle} size={size} {...p} />
);

/**
 * Teardrop pin shape — rounded top + pointed bottom, designed to be filled
 * with the kind color. Used as the background of the Eau / Supermarché / Fin
 * badges in the Feuille de route.
 */
export const IconPinShape = ({ size = 22, ...p }: AssetGlyphProps) => (
  <SvgV2Icon name="marker-pin-02.svg" size={size} {...p} />
);

/** Tiny checkered flag used inside the "Fin" pin. */
export const IconFlagCheckered = ({ size = 10, ...p }: AssetGlyphProps) => (
  <SvgV2Icon name="flag-02.svg" size={size} {...p} />
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
export const IconCheckpointStart = ({ size = 20, ...p }: AssetGlyphProps) => (
  <FullColorSvgIcon src="/svgv2/icone/checkpoint-start.svg" size={size} {...p} />
);

/**
 * "Fin" iOS-style checkered flag map marker — Figma node 855:20564.
 * White/black grid pattern on a flag pole in a rounded square.
 */
export const IconCheckpointEndMarker = ({ size = 20, ...p }: AssetGlyphProps) => (
  <FullColorSvgIcon src="/svgv2/icone/checkpoint-end.svg" size={size} {...p} />
);

/**
 * Waypoint dot — Figma node 855:20775. Red filled circle with a
 * darker red ring (Group12635). Used for the generic "Point de passage".
 */
export const IconWaypointDot = ({ size = 20, ...p }: AssetGlyphProps) => (
  <SvgV2Icon name="marker-pin-04.svg" size={size} {...p} />
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
  style,
  ...p
}: AssetGlyphProps & { color?: string }) => (
  <SvgV2Icon name="marker-pin-02.svg" size={size} style={{ color, ...style }} {...p} />
);

/**
 * "Pause" badge — Figma node 855:20798. Filled dark circle with the
 * pause-circle icon centred. Smaller than the teardrop pins.
 */
export const IconPauseBadge = ({ size = 20, ...p }: AssetGlyphProps) => (
  <SvgV2Icon name="pause-circle.svg" size={size} {...p} />
);

/* -- POI category icons (white glyphs sized for the teardrop pin head) -- */

export const IconToilet = ({ size = 10, ...p }: AssetGlyphProps) => (
  <AssetIcon src={PROVIDED_POI_SVG.toilet} size={size} {...p} />
);

export const IconFuel = ({ size = 10, ...p }: AssetGlyphProps) => (
  <AssetIcon src={PROVIDED_POI_SVG.fuel} size={size} {...p} />
);

export const IconBakery = ({ size = 10, ...p }: AssetGlyphProps) => (
  <AssetIcon src={PROVIDED_POI_SVG.bakery} size={size} {...p} />
);

export const IconBurger = ({ size = 10, ...p }: AssetGlyphProps) => (
  <AssetIcon src={PROVIDED_POI_SVG.fastFood} size={size} {...p} />
);

export const IconCoffee = ({ size = 10, ...p }: AssetGlyphProps) => (
  <AssetIcon src={PROVIDED_POI_SVG.cafe} size={size} {...p} />
);

export const IconBeer = ({ size = 10, ...p }: AssetGlyphProps) => (
  <AssetIcon src={PROVIDED_POI_SVG.bar} size={size} {...p} />
);

export const IconUtensils = ({ size = 10, ...p }: AssetGlyphProps) => (
  <AssetIcon src={PROVIDED_POI_SVG.restaurant} size={size} {...p} />
);

export const IconBicycle = ({ size = 10, ...p }: AssetGlyphProps) => (
  <AssetIcon src={PROVIDED_POI_SVG.bikeShop} size={size} {...p} />
);

export const IconBed = ({ size = 10, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.bed} size={size} {...p} />
);

export const IconTent = ({ size = 10, ...p }: AssetGlyphProps) => (
  <AssetIcon src={ITINERARY_ICON_ASSETS.tent} size={size} {...p} />
);

export const IconMountain = ({ size = 10, ...p }: AssetGlyphProps) => (
  <SvgV2Icon name="mountain.svg" size={size} {...p} />
);

export const IconExpand04 = ({ size = 16, ...p }: AssetGlyphProps) => (
  <span
    style={{ width: size, height: size, display: 'inline-flex', flex: '0 0 auto' }}
    {...p}
  >
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      focusable="false"
    >
      <path
        d="M9 3H3V9M15 3H21V9M21 15V21H15M9 21H3V15"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  </span>
);

export const IconMinimize04 = ({ size = 16, ...p }: AssetGlyphProps) => (
  <span
    style={{ width: size, height: size, display: 'inline-flex', flex: '0 0 auto' }}
    {...p}
  >
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      focusable="false"
    >
      <path
        d="M9 9H3V3M15 9H21V3M21 15V21H15M9 15H3V21"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  </span>
);

export const IconNiceManYellow = ({ size = 15, className, style, ...p }: AssetGlyphProps) => {
  const width = Math.round(size * (8 / 14));
  return (
    <span
      className={className}
      style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', ...style }}
      {...p}
    >
      <svg
        width={width}
        height={size}
        viewBox="0 0 8 14"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
        focusable="false"
      >
        <circle cx="3.92259" cy="2.22935" r="2.22935" fill="#FEC02C" />
        <path
          d="M4.15039 13.2742L3.86059 9.97044L3.57084 13.2742C3.55961 13.4021 3.45249 13.5003 3.32408 13.5003H2.18862C2.05182 13.5003 1.94092 13.3893 1.94092 13.2525V8.07042C1.94092 7.93697 1.75889 7.8979 1.70412 8.0196L0.938684 9.72057C0.878502 9.8543 0.715949 9.90676 0.588942 9.83344L0.123877 9.56493C0.0267838 9.50887 -0.0205524 9.39459 0.00846459 9.2863L1.13904 5.06695C1.15814 4.99566 1.20803 4.9366 1.27513 4.90586L1.81868 4.65684C2.09672 4.52946 2.41166 4.51117 2.70828 4.58564C3.04901 4.67119 3.51323 4.76862 3.86059 4.76862C4.20795 4.76862 4.67221 4.6712 5.01294 4.58564C5.30956 4.51117 5.62454 4.52947 5.90257 4.65685L6.44602 4.90583C6.51311 4.93657 6.56309 4.99566 6.58219 5.06695L7.71276 9.2863C7.74178 9.39459 7.69444 9.50887 7.59735 9.56493L7.13228 9.83344C7.00528 9.90676 6.84272 9.85431 6.78254 9.72057L6.0171 8.0196C5.96234 7.8979 5.78031 7.93697 5.78031 8.07042V13.2525C5.78031 13.3893 5.66941 13.5003 5.5326 13.5003H4.39715C4.26873 13.5003 4.16161 13.4021 4.15039 13.2742Z"
          fill="#FEC02C"
        />
      </svg>
    </span>
  );
};
