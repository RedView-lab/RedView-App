import type { PoiCategory as PanelPoiCategory } from '@/features/itineraryPanel/types';
import type { PoiCategory as FeaturePoiCategory } from '@/features/poi/types';
import type { ExportAnchor } from './exportHelpers';

/**
 * Type de point de parcours Garmin (icône du compteur, alertes « À venir »)
 * par catégorie OSM : libellés du profil FIT du SDK (`firstAid`, pas
 * `first_aid`). Hébergement → `shelter`, aire de pique-nique → `restArea`,
 * point de vue → `overlook`, comme la synchronisation Garmin de Plotaroute.
 */
const FEATURE_COURSE_POINT_TYPE: Record<FeaturePoiCategory, string> = {
  drinking_water: 'water',
  water_point: 'water',
  water_tap: 'water',
  spring: 'water',
  fountain: 'water',
  // Le robinet du cimetière : le compteur l'annonce comme un point d'eau.
  cemetery: 'water',
  supermarket: 'store',
  convenience: 'store',
  bakery: 'food',
  butcher: 'store',
  marketplace: 'store',
  restaurant: 'food',
  fast_food: 'food',
  cafe: 'food',
  bar: 'food',
  pub: 'food',
  ice_cream: 'food',
  vending_machine: 'food',
  hotel: 'shelter',
  alpine_hut: 'shelter',
  wilderness_hut: 'shelter',
  shelter: 'shelter',
  camp_site: 'campsite',
  caravan_site: 'campsite',
  bicycle: 'service',
  bicycle_repair: 'service',
  compressed_air: 'service',
  charging_station: 'service',
  outdoor_shop: 'gear',
  pharmacy: 'firstAid',
  hospital: 'firstAid',
  clinic: 'firstAid',
  doctors: 'firstAid',
  defibrillator: 'firstAid',
  police: 'info',
  train_station: 'transport',
  bus_station: 'transport',
  ferry_terminal: 'transport',
  toilets: 'toilet',
  shower: 'shower',
  // Station-service : la boutique de nuit des ultras.
  fuel: 'store',
  atm: 'service',
  post_office: 'info',
  laundry: 'service',
  pass: 'summit',
  viewpoint: 'overlook',
  picnic_site: 'restArea',
};

/** Repli par ligne du panneau quand la catégorie OSM n'est plus connue. */
const PANEL_COURSE_POINT_TYPE: Record<PanelPoiCategory, string> = {
  fountains: 'water',
  cemeteries: 'water',
  toilets: 'toilet',
  supermarkets: 'store',
  gasStations: 'store',
  bakeries: 'food',
  fastFood: 'food',
  cafes: 'food',
  bars: 'food',
  restaurants: 'food',
  bikeShops: 'service',
  hotels: 'shelter',
  refuges: 'shelter',
  passes: 'summit',
  health: 'firstAid',
  transport: 'transport',
};

/** Type FIT d'une étape (`checkpoint`) ou d'un POI (selon sa catégorie, sinon `generic`). */
export function coursePointType(anchor: Pick<ExportAnchor, 'kind' | 'featureCategory' | 'poiCategory'>): string {
  if (anchor.kind === 'waypoint') return 'checkpoint';
  return (anchor.featureCategory && FEATURE_COURSE_POINT_TYPE[anchor.featureCategory])
    || (anchor.poiCategory && PANEL_COURSE_POINT_TYPE[anchor.poiCategory])
    || 'generic';
}

/**
 * Même type, écrit dans le `<type>` d'un point GPX : Garmin Connect en fait le
 * type du point de parcours à l'import (`checkpoint` donnait déjà l'icône ✓,
 * une catégorie RedView comme `fountains` un simple drapeau). Nom du profil
 * FIT en minuscules (`first_aid`, `rest_area`).
 */
export function gpxCoursePointType(anchor: Pick<ExportAnchor, 'kind' | 'featureCategory' | 'poiCategory'>): string {
  return coursePointType(anchor).replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
