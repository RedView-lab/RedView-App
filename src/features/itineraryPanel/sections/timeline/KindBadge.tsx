/**
 * Kind badge — pixel-perfect match for Figma node 1694:18364
 * (Itinerary panel · "Feuille de route" results pane).
 *
 * Each `TimelineItemKind` resolves to a 20×20 SVG composed exactly the
 * way Figma exports it:
 *   - start       → IconCheckpointStart    (filled black circle + play ▶)
 *   - end         → IconCheckpointEndMarker (rounded square w/ checker grid)
 *   - waypoint    → IconWaypointDot         (red dot inside dark ring)
 *   - water       → blue   IconTeardropPin + droplet
 *   - supermarket → orange IconTeardropPin + cart
 *   - pause       → IconPauseBadge          (dark circle + pause icon)
 *
 * The design also shows POI badges (water/supermarket pattern reused with
 * different colors + icons). When backend wiring lands and rows can carry a
 * concrete `PoiCategory`, the `<PoiBadge>` helper exported below renders
 * the matching teardrop pin.
 */
import {
  IconBakery,
  IconBeer,
  IconBicycle,
  IconBed,
  IconBurger,
  IconCheckpointEndMarker,
  IconCheckpointStart,
  IconCoffee,
  IconDroplet,
  IconFuel,
  IconMountain,
  IconPauseBadge,
  IconShoppingCart,
  IconTeardropPin,
  IconTent,
  IconToilet,
  IconUtensils,
  IconWaypointDot,
} from '../../components/icons';
import type { PoiCategory, TimelineItemKind } from '../../types';
import { PROVIDED_POI_SVG } from '@/features/poi/lib/providedPoiSvg';

interface KindBadgeProps {
  kind: TimelineItemKind;
  /** Pixel size — defaults to the 20px Figma value. */
  size?: number;
  /** Required when `kind === 'poi'` — selects the teardrop pin color/icon. */
  poiCategory?: PoiCategory;
}

/** French labels for the timeline type column. */
export function kindLabel(kind: TimelineItemKind, poiCategory?: PoiCategory): string {
  switch (kind) {
    case 'start':       return 'Départ';
    case 'end':         return 'Arrivée';
    case 'waypoint':    return 'Waypoint';
    case 'water':       return 'POI';
    case 'supermarket': return 'POI';
    case 'poi':         return poiCategory ? poiLabel(poiCategory) : 'POI';
    case 'pause':       return 'Pause';
    default:            return '';
  }
}

/** Brand colour driving each badge fill. */
export const kindColor: Record<TimelineItemKind, string> = {
  start:       '#0e0e0e',
  end:         '#0e0e0e',
  waypoint:    '#c50000',
  water:       '#1e5fc7',
  supermarket: '#a85a1a',
  poi:         '#3a3a3a',
  pause:       '#3a3a3a',
};

/* ----------- POI category registry (for future backend wiring) ---------- */

interface PoiBadgeSpec {
  /** Hex color used to fill the teardrop pin head + tip. */
  color: string;
  /** White glyph rendered centred in the pin head. */
  Icon: React.ComponentType<{ size?: number }>;
}

export const POI_BADGE_REGISTRY: Record<PoiCategory, PoiBadgeSpec> = {
  fountains:    { color: '#1e5fc7', Icon: IconDroplet },
  toilets:      { color: '#5a8fc7', Icon: IconToilet },
  supermarkets: { color: '#a85a1a', Icon: IconShoppingCart },
  gasStations:  { color: '#3a3a3a', Icon: IconFuel },
  bakeries:     { color: '#c79a3a', Icon: IconBakery },
  fastFood:     { color: '#c75a1a', Icon: IconBurger },
  cafes:        { color: '#7a4a2a', Icon: IconCoffee },
  bars:         { color: '#9b59ff', Icon: IconBeer },
  restaurants:  { color: '#c52a4a', Icon: IconUtensils },
  bikeShops:    { color: '#2a8b6a', Icon: IconBicycle },
  hotels:       { color: '#3a5aa8', Icon: IconBed },
  refuges:      { color: '#5a7a3a', Icon: IconTent },
  passes:       { color: '#5a5a5a', Icon: IconMountain },
};

const PROVIDED_TIMELINE_BADGE_URLS: Partial<Record<PoiCategory, string>> = {
  fountains: PROVIDED_POI_SVG.water,
  toilets: PROVIDED_POI_SVG.toilet,
  supermarkets: PROVIDED_POI_SVG.shop,
  gasStations: PROVIDED_POI_SVG.fuel,
  bakeries: PROVIDED_POI_SVG.bakery,
  fastFood: PROVIDED_POI_SVG.fastFood,
  cafes: PROVIDED_POI_SVG.cafe,
  bars: PROVIDED_POI_SVG.bar,
  restaurants: PROVIDED_POI_SVG.restaurant,
  bikeShops: PROVIDED_POI_SVG.bikeShop,
  hotels: PROVIDED_POI_SVG.hotelBadge,
  refuges: PROVIDED_POI_SVG.refugeBadge,
};

/** POI label (FR). */
export function poiLabel(category: PoiCategory): string {
  switch (category) {
    case 'fountains':    return 'Eau';
    case 'toilets':      return 'Toilettes';
    case 'supermarkets': return 'Supermarché';
    case 'gasStations':  return 'Carburant';
    case 'bakeries':     return 'Boulangerie';
    case 'fastFood':     return 'Fast-food';
    case 'cafes':        return 'Café';
    case 'bars':         return 'Bar';
    case 'restaurants':  return 'Restaurant';
    case 'bikeShops':    return 'Vélo';
    case 'hotels':       return 'Hôtel';
    case 'refuges':      return 'Refuge';
    case 'passes':       return 'Col';
  }
}

/**
 * Teardrop POI pin with a centred white glyph — composed by overlaying the
 * white icon on top of the colored teardrop SVG.
 */
export function PoiBadge({
  category,
  size = 20,
  hideGlyph = false,
}: {
  category: PoiCategory;
  size?: number;
  hideGlyph?: boolean;
}) {
  const providedUrl = PROVIDED_TIMELINE_BADGE_URLS[category];
  if (providedUrl) {
    return <ProvidedPoiSvgBadge url={providedUrl} size={size} className="rvi-kind--pin" />;
  }

  const spec = POI_BADGE_REGISTRY[category];
  const glyph = Math.round(size * 0.5);
  return (
    <span
      className="rvi-kind rvi-kind--pin"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <IconTeardropPin size={size} color={spec.color} />
      {!hideGlyph ? (
        <span className="rvi-kind__pin-icon" style={{ width: glyph, height: glyph }}>
          <spec.Icon size={glyph} />
        </span>
      ) : null}
    </span>
  );
}

function ProvidedPoiSvgBadge({
  url,
  size,
  className,
}: {
  url: string;
  size: number;
  className?: string;
}) {
  return (
    <span
      className={`rvi-kind ${className ?? ''}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <img
        src={url}
        alt=""
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </span>
  );
}

/* ------------------------------ Main badge ------------------------------ */

export function KindBadge({ kind, size = 20, poiCategory }: KindBadgeProps) {
  if (kind === 'start') {
    return (
      <span
        className="rvi-kind rvi-kind--start"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <IconCheckpointStart size={size} />
      </span>
    );
  }

  if (kind === 'end') {
    return (
      <span
        className="rvi-kind rvi-kind--end"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <IconCheckpointEndMarker size={size} />
      </span>
    );
  }

  if (kind === 'waypoint') {
    return (
      <span
        className="rvi-kind rvi-kind--waypoint"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <IconWaypointDot size={size} />
      </span>
    );
  }

  if (kind === 'pause') {
    return (
      <span
        className="rvi-kind rvi-kind--pause"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <IconPauseBadge size={size} />
      </span>
    );
  }

  // Generic POI row injected by corridor search → use the typed teardrop pin.
  if (kind === 'poi' && poiCategory) {
    return <PoiBadge category={poiCategory} size={size} />;
  }

  if (kind === 'poi') {
    return <ProvidedPoiSvgBadge url={PROVIDED_POI_SVG.water} size={size} className="rvi-kind--pin rvi-kind--water" />;
  }

  if (kind === 'water') {
    return <ProvidedPoiSvgBadge url={PROVIDED_POI_SVG.water} size={size} className="rvi-kind--pin rvi-kind--water" />;
  }

  if (kind === 'supermarket') {
    return <ProvidedPoiSvgBadge url={PROVIDED_POI_SVG.shop} size={size} className="rvi-kind--pin rvi-kind--supermarket" />;
  }

  return null;
}
