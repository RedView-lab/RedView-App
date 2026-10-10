/**
 * Badge de type — conforme au pixel près au nœud Figma 1694:18364
 * (panneau d'itinéraire · volet de résultats « Feuille de route »).
 *
 * Chaque `TimelineItemKind` donne un SVG de 20×20 composé exactement comme
 * Figma l'exporte :
 *   - start       → IconCheckpointStart     (cercle noir plein + lecture ▶)
 *   - end         → IconCheckpointEndMarker (carré arrondi avec damier)
 *   - waypoint    → IconWaypointDot         (point rouge dans un anneau sombre)
 *   - water       → IconTeardropPin bleue + goutte
 *   - supermarket → IconTeardropPin orange + chariot
 *   - pause       → IconPauseBadge          (cercle sombre + icône pause)
 *
 * La maquette montre aussi des badges de POI (motif eau/supermarché réutilisé
 * avec d'autres couleurs + icônes). Quand le branchement backend arrivera et que
 * les lignes pourront porter une vraie `PoiCategory`, l'outil `<PoiBadge>`
 * exporté plus bas affichera l'épingle en goutte correspondante.
 */
import React from 'react';
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
import { translateAppText } from '@/shared/i18n';
import type { PoiCategory, TimelineItemKind } from '../../types';
import { PROVIDED_POI_SVG } from '@/features/poi/lib/providedPoiSvg';

interface KindBadgeProps {
  kind: TimelineItemKind | 'favorite';
  /** Taille en pixels — 20px par défaut, la valeur de Figma. */
  size?: number;
  /** Requis quand `kind === 'poi'` — choisit la couleur/l'icône de l'épingle en goutte. */
  poiCategory?: PoiCategory;
  favorite?: boolean;
  pauseDurationMin?: number | null;
}

/* ----------- Registre des catégories de POI (pour le futur branchement backend) ---------- */

interface PoiBadgeSpec {
  /** Couleur hexadécimale de remplissage de la tête + de la pointe de l'épingle. */
  color: string;
  /** Glyphe blanc centré dans la tête de l'épingle. */
  Icon: React.ComponentType<{ size?: number }>;
}

/**
 * Registre des badges en goutte dessinés, par catégorie de panneau.
 *
 * Volontairement partiel : `PoiBadge` résout d'abord un asset fourni
 * (`PROVIDED_TIMELINE_BADGE_URLS`), et les catégories santé / transport
 * n'ont pas encore de pictogramme dédié côté design.
 */
const POI_BADGE_REGISTRY: Partial<Record<PoiCategory, PoiBadgeSpec>> = {
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

/**
 * Disque du waypoint (`IconWaypointDot`, r 7 + trait 2,5 sur 20) : 82,5 % de
 * son emplacement. Les badges POI ronds visent le même diamètre visible.
 */
const WAYPOINT_DISC_RATIO = 16.5 / 20;
/**
 * Les SVG ronds `dropdown-maps/*` (33 × 33) réservent la marge de leur ombre :
 * le disque n'en occupe que 19,6 / 33. On agrandit l'image dans un emplacement
 * inchangé (colonnes alignées) pour que le disque égale celui du waypoint.
 */
const ROUND_BADGE_ART_SCALE = WAYPOINT_DISC_RATIO / (19.6 / 33);

const PROVIDED_TIMELINE_ROUND_BADGE_URLS: Partial<Record<PoiCategory, string>> = {
  fountains: '/icons/poi/dropdown-maps/water.svg',
  cemeteries: '/icons/poi/dropdown-maps/cemetery.svg',
  toilets: '/icons/poi/dropdown-maps/toilets.svg',
  supermarkets: '/icons/poi/dropdown-maps/supermarket.svg',
  gasStations: '/icons/poi/dropdown-maps/fuel.svg',
  bakeries: '/icons/poi/dropdown-maps/bakery.svg',
  fastFood: '/icons/poi/dropdown-maps/fast-food.svg',
  cafes: '/icons/poi/dropdown-maps/cafe.svg',
  bars: '/icons/poi/dropdown-maps/bar.svg',
  restaurants: '/icons/poi/dropdown-maps/restaurant.svg',
  bikeShops: '/icons/poi/dropdown-maps/bicycle.svg',
  hotels: '/icons/poi/dropdown-maps/hotel.svg',
  refuges: '/icons/poi/dropdown-maps/refuge.svg',
  passes: '/icons/poi/dropdown-maps/refuge.svg',
};

const PROVIDED_TIMELINE_FAVORITE_BADGE_URLS: Partial<Record<PoiCategory, string>> = {
  fountains: PROVIDED_POI_SVG.favoriteWater,
  cemeteries: PROVIDED_POI_SVG.favoriteCemetery,
  toilets: PROVIDED_POI_SVG.favoriteToilet,
  supermarkets: PROVIDED_POI_SVG.favoriteSupermarket,
  gasStations: PROVIDED_POI_SVG.favoriteFuel,
  bakeries: PROVIDED_POI_SVG.favoriteBakery,
  fastFood: PROVIDED_POI_SVG.favoriteFastFood,
  cafes: PROVIDED_POI_SVG.favoriteCafe,
  bars: PROVIDED_POI_SVG.favoriteBar,
  restaurants: PROVIDED_POI_SVG.favoriteRestaurant,
  hotels: PROVIDED_POI_SVG.favoriteHotelPin,
  refuges: PROVIDED_POI_SVG.favoriteRefugePin,
  passes: PROVIDED_POI_SVG.favoriteRefugePin,
};

/**
 * Badge de POI :
 * - cercle rond pour les POI standard (non favoris)
 * - épingle pointue (« le truc avec la pointe ») pour les POI favoris
 * - symbole pause avec sa durée quand il est associé à des pauses
 */
function PoiBadge({
  category,
  size = 20,
  hideGlyph = false,
  favorite = false,
  pauseDurationMin,
}: {
  category: PoiCategory;
  size?: number;
  hideGlyph?: boolean;
  favorite?: boolean;
  pauseDurationMin?: number | null;
}) {
  const favoriteUrl = favorite ? PROVIDED_TIMELINE_FAVORITE_BADGE_URLS[category] : undefined;
  const providedUrl = favoriteUrl ?? PROVIDED_TIMELINE_ROUND_BADGE_URLS[category];
  const hasPause = Boolean(pauseDurationMin && pauseDurationMin > 0);

  const badgeContent = providedUrl ? (
    <ProvidedPoiSvgBadge
      url={providedUrl}
      size={size}
      className={favorite ? 'rvi-kind--pin' : 'rvi-kind--round'}
      showStarBadge={favorite && !favoriteUrl}
    />
  ) : favorite ? (
    <span
      className="rvi-kind rvi-kind--pin"
      style={{ width: size, height: size, position: 'relative', display: 'inline-flex' }}
      aria-hidden
    >
      <IconTeardropPin size={size} color={POI_BADGE_REGISTRY[category]?.color ?? '#5a5a5a'} />
      {!hideGlyph && POI_BADGE_REGISTRY[category] ? (
        <span className="rvi-kind__pin-icon" style={{ width: Math.round(size * 0.5), height: Math.round(size * 0.5) }}>
          {React.createElement(POI_BADGE_REGISTRY[category]!.Icon, { size: Math.round(size * 0.5) })}
        </span>
      ) : null}
      <img
        src="/icons/ui/star-01.svg"
        alt=""
        style={{
          position: 'absolute',
          top: -2,
          right: -2,
          width: Math.round(size * 0.45),
          height: Math.round(size * 0.45),
          pointerEvents: 'none',
          filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6))',
        }}
        draggable={false}
      />
    </span>
  ) : (
    <span
      className="rvi-kind rvi-kind--round"
      style={{ width: size, height: size, position: 'relative', display: 'inline-flex' }}
      aria-hidden
    >
      <span
        style={{
          width: Math.round(size * WAYPOINT_DISC_RATIO),
          height: Math.round(size * WAYPOINT_DISC_RATIO),
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '50%',
          backgroundColor: POI_BADGE_REGISTRY[category]?.color ?? '#5a5a5a',
          border: '1.5px solid rgba(255, 255, 255, 0.9)',
          boxShadow: '0 2px 4px rgba(0, 0, 0, 0.25)',
          boxSizing: 'border-box',
        }}
      >
        {!hideGlyph && POI_BADGE_REGISTRY[category] ? (
          <span style={{ width: Math.round(size * 0.45), height: Math.round(size * 0.45), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {React.createElement(POI_BADGE_REGISTRY[category]!.Icon, { size: Math.round(size * 0.45) })}
          </span>
        ) : null}
      </span>
    </span>
  );

  if (!hasPause) {
    return badgeContent;
  }

  return (
    <span className="rvi-poi-pause-wrap" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {badgeContent}
      <span className="rvi-poi-pause-badge" title={translateAppText('Pause {{min}} min', { min: pauseDurationMin ?? 0 })}>
        <span className="rvi-poi-pause-badge__icon">❚❚</span>
        <span className="rvi-poi-pause-badge__text">{pauseDurationMin} min</span>
      </span>
    </span>
  );
}

function ProvidedPoiSvgBadge({
  url,
  size,
  className,
  showStarBadge = false,
}: {
  url: string;
  size: number;
  className?: string;
  showStarBadge?: boolean;
}) {
  const isPin = className?.includes('rvi-kind--pin');
  const height = isPin ? Math.round(size * (48 / 44)) : size;
  // Rond : image agrandie autour du centre, la marge d'ombre déborde de
  // l'emplacement (voir ROUND_BADGE_ART_SCALE).
  const artSize = isPin ? size : Math.round(size * ROUND_BADGE_ART_SCALE);
  const artHeight = isPin ? height : artSize;
  return (
    <span
      className={`rvi-kind ${className ?? ''}`.trim()}
      style={{ width: size, height, position: 'relative', display: 'inline-flex' }}
      aria-hidden
    >
      <img
        src={url}
        alt=""
        width={artSize}
        height={artHeight}
        style={isPin
          ? { width: artSize, height: artHeight, display: 'block', objectFit: 'contain' }
          : {
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: artSize,
            height: artHeight,
            maxWidth: 'none',
            transform: 'translate(-50%, -50%)',
            display: 'block',
            objectFit: 'contain',
          }}
        draggable={false}
      />
      {showStarBadge && (
        <img
          src="/icons/ui/star-01.svg"
          alt=""
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            width: Math.round(size * 0.45),
            height: Math.round(size * 0.45),
            pointerEvents: 'none',
            filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6))',
          }}
          draggable={false}
        />
      )}
    </span>
  );
}

/* ------------------------------ Badge principal ------------------------------ */

export function KindBadge({
  kind,
  size = 20,
  poiCategory,
  favorite = false,
  pauseDurationMin,
}: KindBadgeProps) {
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

  // La durée d'une pause est déjà la colonne nom : le badge reste une icône
  // seule, un peu plus petite que les autres, centrée dans le même emplacement
  // pour garder les colonnes alignées.
  if (kind === 'pause') {
    return (
      <span
        className="rvi-kind rvi-kind--pause"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <IconPauseBadge size={Math.round(size * 0.8)} />
      </span>
    );
  }

  if (kind === 'favorite') {
    return (
      <span
        className="rvi-kind rvi-kind--pin rvi-kind--favorite"
        style={{ width: size, height: size, position: 'relative', display: 'inline-flex' }}
        aria-hidden
      >
        <IconTeardropPin size={size} color="#FDB022" />
        <img
          src="/icons/ui/star-01.svg"
          alt=""
          style={{
            position: 'absolute',
            top: 2,
            left: '50%',
            transform: 'translateX(-50%)',
            width: Math.round(size * 0.55),
            height: Math.round(size * 0.55),
            pointerEvents: 'none',
          }}
          draggable={false}
        />
      </span>
    );
  }

  // Ligne de POI générique injectée par la recherche dans le couloir → utiliser le badge typé
  if (kind === 'poi' && poiCategory) {
    return <PoiBadge category={poiCategory} size={size} favorite={favorite} pauseDurationMin={pauseDurationMin} />;
  }

  if (kind === 'poi' || kind === 'water') {
    const url = favorite ? PROVIDED_POI_SVG.favoriteWater : '/icons/poi/dropdown-maps/water.svg';
    return (
      <span className="rvi-poi-pause-wrap" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <ProvidedPoiSvgBadge
          url={url}
          size={size}
          className={favorite ? 'rvi-kind--pin rvi-kind--water' : 'rvi-kind--round rvi-kind--water'}
        />
        {pauseDurationMin && pauseDurationMin > 0 ? (
          <span className="rvi-poi-pause-badge" title={translateAppText('Pause {{min}} min', { min: pauseDurationMin })}>
            <span className="rvi-poi-pause-badge__icon">❚❚</span>
            <span className="rvi-poi-pause-badge__text">{pauseDurationMin} min</span>
          </span>
        ) : null}
      </span>
    );
  }

  if (kind === 'supermarket') {
    const url = favorite ? PROVIDED_POI_SVG.favoriteSupermarket : '/icons/poi/dropdown-maps/supermarket.svg';
    return (
      <span className="rvi-poi-pause-wrap" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <ProvidedPoiSvgBadge
          url={url}
          size={size}
          className={favorite ? 'rvi-kind--pin rvi-kind--supermarket' : 'rvi-kind--round rvi-kind--supermarket'}
        />
        {pauseDurationMin && pauseDurationMin > 0 ? (
          <span className="rvi-poi-pause-badge" title={translateAppText('Pause {{min}} min', { min: pauseDurationMin })}>
            <span className="rvi-poi-pause-badge__icon">❚❚</span>
            <span className="rvi-poi-pause-badge__text">{pauseDurationMin} min</span>
          </span>
        ) : null}
      </span>
    );
  }

  return null;
}
