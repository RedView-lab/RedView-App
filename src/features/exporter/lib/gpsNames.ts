import type { PoiCategory as PanelPoiCategory } from '@/features/itineraryPanel/types';
import type { OpeningInterval } from '@/features/poi/lib/autoSort/openingHours';
import type { PoiCategory as FeaturePoiCategory } from '@/features/poi/types';

/**
 * Nom d'un POI sur un GPS, convention des ultra-cyclistes :
 *
 *   `CAT_CDD[_horaires][_nom]`
 *
 *  - `CAT` : trois lettres de la catégorie (EAU, SUP, BOU, HOT, RES…) ;
 *  - `C` : côté du tracé dans le sens de la marche (G / D, L / R en anglais),
 *    `DD` : distance au tracé en mètres (deux chiffres au moins ; `00` sur le
 *    tracé, `12k` au-delà de 10 km) ;
 *  - horaires du jour de passage (`9-22`, `8.30-17.30`, `8-12,14-19`, `24h`,
 *    « fermé ») quand ils sont connus ;
 *  - le nom : celui d'un commerce, ou celui saisi dans la colonne « Nom » de
 *    la feuille de route (toujours repris tel quel).
 *
 * Exemples : `EAU_G10`, `SUP_D20_Carrefour`, `HOT_G11_Hôtel de la Poste`,
 * `BOU_D03_7-19_La Mie Câline`. Garmin n'affiche que les 15 premiers
 * caractères : le plus utile vient en premier, le reste est coupé à l'écran.
 */

export type GpsNameLocale = 'fr' | 'en';
export type RouteSide = 'left' | 'right';

interface CategoryCode {
  fr: string;
  en: string;
  /** Commerce, hébergement, lieu nommé : son nom suit le code. Non : eau, toilettes, gonflage… */
  named: boolean;
}

const code = (fr: string, en: string, named: boolean): CategoryCode => ({ fr, en, named });

/**
 * Codes par catégorie OSM (taxonomie du serveur POI). Les trois premières
 * lettres du libellé, sauf quand elles seraient ambiguës : « Boucherie »
 * (BCH, BOU est la boulangerie), « Restauration rapide » (FAS, RES est le
 * restaurant), « Point d'eau » (EAU).
 */
const FEATURE_CODES: Record<FeaturePoiCategory, CategoryCode> = {
  drinking_water: code('EAU', 'WAT', false),
  water_point: code('EAU', 'WAT', false),
  water_tap: code('EAU', 'WAT', false),
  spring: code('EAU', 'WAT', false),
  fountain: code('EAU', 'WAT', false),
  cemetery: code('CIM', 'CEM', false),
  supermarket: code('SUP', 'SUP', true),
  convenience: code('EPI', 'CON', true),
  bakery: code('BOU', 'BAK', true),
  butcher: code('BCH', 'BUT', true),
  marketplace: code('MAR', 'MAR', true),
  restaurant: code('RES', 'RES', true),
  fast_food: code('FAS', 'FAS', true),
  cafe: code('CAF', 'CAF', true),
  bar: code('BAR', 'BAR', true),
  pub: code('PUB', 'PUB', true),
  ice_cream: code('GLA', 'ICE', true),
  vending_machine: code('DIS', 'VEN', false),
  hotel: code('HOT', 'HOT', true),
  alpine_hut: code('REF', 'HUT', true),
  wilderness_hut: code('CAB', 'HUT', true),
  shelter: code('ABR', 'SHE', false),
  camp_site: code('CAM', 'CAM', true),
  caravan_site: code('CCR', 'CAR', false),
  bicycle: code('VEL', 'BIK', true),
  bicycle_repair: code('REP', 'REP', false),
  compressed_air: code('AIR', 'AIR', false),
  charging_station: code('REC', 'CHA', false),
  outdoor_shop: code('SPO', 'OUT', true),
  pharmacy: code('PHA', 'PHA', true),
  hospital: code('HOP', 'HOS', true),
  clinic: code('CLI', 'CLI', true),
  doctors: code('MED', 'DOC', true),
  defibrillator: code('DEF', 'AED', false),
  police: code('POL', 'POL', false),
  train_station: code('GAR', 'TRN', true),
  bus_station: code('BUS', 'BUS', true),
  ferry_terminal: code('FER', 'FER', true),
  toilets: code('TOI', 'TOI', false),
  shower: code('DOU', 'SHO', false),
  fuel: code('STA', 'GAS', true),
  atm: code('DAB', 'ATM', false),
  post_office: code('POS', 'POS', false),
  laundry: code('LAV', 'LAU', true),
  pass: code('COL', 'PAS', true),
  viewpoint: code('VUE', 'VIE', true),
  picnic_site: code('PIQ', 'PIC', false),
};

/** Repli sur la ligne du panneau quand la catégorie OSM n'est plus connue. */
const PANEL_CODES: Record<PanelPoiCategory, CategoryCode> = {
  fountains: FEATURE_CODES.drinking_water,
  cemeteries: FEATURE_CODES.cemetery,
  toilets: FEATURE_CODES.toilets,
  supermarkets: FEATURE_CODES.supermarket,
  gasStations: FEATURE_CODES.fuel,
  bakeries: FEATURE_CODES.bakery,
  fastFood: FEATURE_CODES.fast_food,
  cafes: FEATURE_CODES.cafe,
  bars: FEATURE_CODES.bar,
  restaurants: FEATURE_CODES.restaurant,
  bikeShops: FEATURE_CODES.bicycle,
  hotels: FEATURE_CODES.hotel,
  refuges: FEATURE_CODES.alpine_hut,
  passes: FEATURE_CODES.pass,
  health: code('SAN', 'MED', true),
  transport: code('TRA', 'TRA', true),
};

const UNKNOWN_CODE = code('POI', 'POI', true);

function resolveCategoryCode(
  featureCategory: FeaturePoiCategory | undefined,
  panelCategory: PanelPoiCategory | undefined,
): CategoryCode {
  return (featureCategory && FEATURE_CODES[featureCategory])
    || (panelCategory && PANEL_CODES[panelCategory])
    || UNKNOWN_CODE;
}

/** Code de catégorie d'un POI (trois lettres, majuscules, sans accent). */
export function gpsCategoryCode(
  featureCategory: FeaturePoiCategory | undefined,
  panelCategory: PanelPoiCategory | undefined,
  locale: GpsNameLocale,
): string {
  return resolveCategoryCode(featureCategory, panelCategory)[locale];
}

/** `G10`, `D03`, `L250`, `R12k` ; `00` quand le POI est sur le tracé. */
export function formatRouteOffset(lateralM: number, side: RouteSide | null, locale: GpsNameLocale): string {
  const meters = Number.isFinite(lateralM) ? Math.round(Math.max(0, lateralM)) : 0;
  if (meters < 1) return '00';
  const letter = side == null ? '' : side === 'left' ? (locale === 'fr' ? 'G' : 'L') : (locale === 'fr' ? 'D' : 'R');
  const value = meters >= 10_000 ? `${Math.round(meters / 1000)}k` : String(meters).padStart(2, '0');
  return `${letter}${value}`;
}

const MINUTES_PER_DAY = 24 * 60;

/** 480 → `8`, 510 → `8.30`, 1440 → `24`, 1560 (2 h le lendemain) → `2`. */
function formatClockMinutes(minutes: number, isEnd: boolean): string {
  let value = Math.round(minutes);
  if (value > MINUTES_PER_DAY || (!isEnd && value >= MINUTES_PER_DAY)) value -= MINUTES_PER_DAY;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest === 0 ? String(hours) : `${hours}.${String(rest).padStart(2, '0')}`;
}

/**
 * Horaires d'un jour au format court des feuilles de route : `9-22`,
 * `8.30-17.30`, `8-12,14-19`, `18-2` (fermeture après minuit), `24h`.
 * Liste vide : fermé ce jour-là.
 */
export function formatOpeningIntervals(intervals: readonly OpeningInterval[], locale: GpsNameLocale): string {
  if (intervals.length === 0) return locale === 'fr' ? 'fermé' : 'closed';
  const merged: OpeningInterval[] = [];
  for (const interval of [...intervals].sort((l, r) => l.start - r.start)) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  if (merged.length === 1 && merged[0]!.start <= 0 && merged[0]!.end >= MINUTES_PER_DAY) return '24h';
  return merged
    .map((interval) => `${formatClockMinutes(interval.start, false)}-${formatClockMinutes(interval.end, true)}`)
    .join(',');
}

/** Horaires déjà écrits à la main dans un nom (`7-19`, `8h30-12h`, `24h`, « fermé »). */
const HANDWRITTEN_HOURS = /(?:^|[^\d])\d{1,2}(?:[.:h]\d{2}|h)?\s*[-–]\s*\d{1,2}(?:[.:h]\d{2}|h)?(?!\d)|\b24\s*h\b|\b24\/7\b|ferm[ée]|closed/i;

export function hasHandwrittenHours(name: string): boolean {
  return HANDWRITTEN_HOURS.test(name);
}

function cleanName(name: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  return (name ?? '').replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface GpsPoiNameInput {
  featureCategory?: FeaturePoiCategory;
  panelCategory?: PanelPoiCategory;
  /** Distance au tracé (m) et côté dans le sens de la marche. */
  lateralM: number;
  side: RouteSide | null;
  /** Plages du jour de passage : `[]` fermé, null inconnues. */
  openingIntervals: readonly OpeningInterval[] | null;
  /** Nom du commerce (OSM, marque) ; null pour un POI sans nom propre. */
  placeName: string | null;
  /** Nom saisi dans la colonne « Nom » : prioritaire, toujours repris. */
  editedName: string | null;
}

/** Nom GPS d'un POI selon la convention (voir l'en-tête du module). */
export function buildGpsPoiName(input: GpsPoiNameInput, locale: GpsNameLocale): string {
  const category = resolveCategoryCode(input.featureCategory, input.panelCategory);
  const editedName = cleanName(input.editedName);
  const name = editedName || (category.named ? cleanName(input.placeName) : '');

  const parts = [category[locale], formatRouteOffset(input.lateralM, input.side, locale)];
  if (input.openingIntervals && !(editedName && hasHandwrittenHours(editedName))) {
    const hours = formatOpeningIntervals(input.openingIntervals, locale);
    // « Ouvert 24 h » n'apprend rien sur une fontaine ou des toilettes.
    if (hours !== '24h' || category.named) parts.push(hours);
  }
  if (name) parts.push(name);
  return parts.join('_');
}

/** Ce que la plupart des Garmin Edge affichent d'un nom de point de parcours. */
export const GARMIN_VISIBLE_NAME_CHARS = 15;

/**
 * Au-delà, de nombreux Garmin Edge n'annoncent plus les derniers points de
 * parcours (« 200 course point max exceeded ») : le panneau Exporter prévient.
 */
export const GARMIN_COURSE_POINT_LIMIT = 200;

/** Deux noms d'exemple (point d'eau, boulangerie ouverte de 7 h à 19 h) dans la langue donnée. */
export function gpsNameExamples(locale: GpsNameLocale): string[] {
  return [
    buildGpsPoiName({ featureCategory: 'drinking_water', lateralM: 10, side: 'left', openingIntervals: null, placeName: null, editedName: null }, locale),
    buildGpsPoiName({
      featureCategory: 'bakery',
      lateralM: 3,
      side: 'right',
      openingIntervals: [{ start: 7 * 60, end: 19 * 60 }],
      placeName: locale === 'fr' ? 'Nom' : 'Name',
      editedName: null,
    }, locale),
  ];
}
