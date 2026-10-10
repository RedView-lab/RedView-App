// ─────────────────────────────────────────────────────────────────────
// Tri automatique des POI — règles
// ─────────────────────────────────────────────────────────────────────
//
// Toutes les constantes du tri auto vivent ici, dans un seul objet, pour
// pouvoir itérer sur les réglages (bench `bench:poi-autosort`) sans toucher
// à l'algorithme. Les durées sont en heures, les heures d'horloge en
// minutes depuis minuit (une plage qui passe minuit a `end > 1440`).

import type { PoiCategory } from '../../types';
import type { AutoSortKind } from './types';

export interface ClockWindow {
  startMin: number;
  endMin: number;
}

export interface AutoSortRules {
  water: {
    /** Écart maximal entre deux recharges d'eau (heures de trajet, pauses incluses). */
    maxGapH: number;
    /** En dessous de cet écart on ne cherche pas encore de recharge. */
    minGapH: number;
    /** « Proximité immédiate » : distance latérale max d'un point d'eau. */
    maxLateralM: number;
    /** En deçà, le POI est considéré sur la trace (pas de côté). */
    onRouteM: number;
    /** Côté gauche (il faut traverser) : toléré seulement très près. */
    leftSideMaxLateralM: number;
    /** Pente moyenne autour du point en dessous de laquelle on est « en descente ». */
    descentGradePct: number;
    gradeWindowBeforeM: number;
    gradeWindowAfterM: number;
  };
  resupply: {
    targetGapH: number;
    maxGapH: number;
    minGapH: number;
    /** Écart minimal quand on force un arrêt dans un créneau repas. */
    mealMinGapH: number;
    /** Dépassement toléré de l'échéance pour atteindre un commerce probablement ouvert. */
    likelyOpenOverrunH: number;
  };
  hotel: {
    /** Plage d'horloge où un hôtel peut être retenu (18h → 6h). */
    window: ClockWindow;
    /**
     * Répartition dans la nuit : la soirée (18h–22h) est le moment où l'on
     * s'arrête vraiment, elle reçoit donc le plus d'options.
     */
    slots: Array<ClockWindow & { max: number }>;
    /** Écart minimal entre deux hôtels retenus dans une même tranche. */
    minSpacingMin: number;
    /** Pas d'hôtel juste après le départ (départ de nuit ou très matinal). */
    minElapsedH: number;
  };
  gap: {
    /** « Désert » : au-delà, le dernier POI de la famille avant le trou est ajouté d'office. */
    desertH: number;
    /** Tolérance pour préférer un POI ouvert juste avant le dernier. */
    preferOpenWithinMin: number;
  };
  cluster: {
    radiusM: number;
    maxLateralM: number;
  };
  timeOfDay: {
    bakeryMorning: ClockWindow & { boost: number };
    lunch: ClockWindow & { boost: number };
    evening: ClockWindow & { boost: number };
    deepNight: ClockWindow & { nightKindBoost: number; open247Boost: number };
    /** Au moins un arrêt ravito garanti dans chacun de ces créneaux. */
    mealGuarantees: ClockWindow[];
  };
  opening: {
    /** Il faut arriver au moins N minutes avant la fermeture. */
    closingMarginMin: number;
    /** Horaires inconnus, mais passage dans les horaires habituels de la catégorie. */
    unknownLikelyOpenFactor: number;
    /** Horaires inconnus et passage hors des horaires habituels (nuit, sieste…). */
    unknownLikelyClosedFactor: number;
    /** Hôtel dont l'accueil est fermé à l'heure d'arrivée. */
    hotelClosedFactor: number;
  };
  /** Deux passages de la trace près d'un même POI sont distincts au-delà de cet écart. */
  multiPassSeparationM: number;
}

const h = (hours: number) => hours * 60;

export const DEFAULT_AUTO_SORT_RULES: AutoSortRules = {
  water: {
    maxGapH: 3,
    minGapH: 1.5,
    maxLateralM: 40,
    onRouteM: 8,
    leftSideMaxLateralM: 12,
    descentGradePct: -4,
    gradeWindowBeforeM: 200,
    gradeWindowAfterM: 100,
  },
  resupply: {
    targetGapH: 3,
    maxGapH: 4,
    minGapH: 2,
    mealMinGapH: 1,
    likelyOpenOverrunH: 1.5,
  },
  hotel: {
    window: { startMin: h(18), endMin: h(30) },
    slots: [
      { startMin: h(18), endMin: h(22), max: 3 },
      { startMin: h(22), endMin: h(26), max: 1 },
      { startMin: h(26), endMin: h(30), max: 1 },
    ],
    minSpacingMin: 30,
    minElapsedH: 3,
  },
  gap: {
    desertH: 6,
    preferOpenWithinMin: 30,
  },
  cluster: {
    radiusM: 300,
    maxLateralM: 200,
  },
  timeOfDay: {
    bakeryMorning: { startMin: h(4), endMin: h(11), boost: 1.8 },
    lunch: { startMin: h(11), endMin: h(14), boost: 1.5 },
    evening: { startMin: h(18), endMin: h(28), boost: 1.5 },
    deepNight: {
      startMin: h(22),
      endMin: h(29),
      nightKindBoost: 1.6,
      open247Boost: 1.4,
    },
    mealGuarantees: [
      { startMin: h(11), endMin: h(14) },
      { startMin: h(18), endMin: h(22) },
    ],
  },
  opening: {
    closingMarginMin: 15,
    unknownLikelyOpenFactor: 0.8,
    unknownLikelyClosedFactor: 0.15,
    hotelClosedFactor: 0.3,
  },
  multiPassSeparationM: 1000,
};

/** Catégories OSM que le tri auto sait traiter ; les autres ne sont jamais auto-favorisées. */
export const AUTO_SORT_KIND_BY_CATEGORY: Partial<Record<PoiCategory, AutoSortKind>> = {
  drinking_water: 'water',
  water_point: 'water',
  water_tap: 'water',
  spring: 'water',
  fountain: 'water',
  cemetery: 'water',
  supermarket: 'shop',
  convenience: 'shop',
  bakery: 'shop',
  marketplace: 'shop',
  butcher: 'shop',
  restaurant: 'meal',
  fast_food: 'meal',
  cafe: 'meal',
  bar: 'meal',
  pub: 'meal',
  ice_cream: 'meal',
  fuel: 'night',
  vending_machine: 'night',
  hotel: 'hotel',
};

/**
 * Points d'eau de secours : retenus seulement faute d'un vrai point d'eau
 * (le robinet d'un cimetière existe presque toujours en France, mais n'est
 * ni signalé ni garanti potable).
 */
export const AUTO_SORT_FALLBACK_WATER: ReadonlySet<PoiCategory> = new Set<PoiCategory>(['cemetery']);

/**
 * Distance latérale max. propre à une catégorie d'eau, à la place de la
 * « proximité immédiate » (`water.maxLateralM`) : un cimetière est un centroïde
 * de surface, à plusieurs dizaines de mètres de son portail sur la route.
 */
export const AUTO_SORT_WATER_MAX_LATERAL_M: Partial<Record<PoiCategory, number>> = {
  cemetery: 120,
};

/** Intérêt intrinsèque d'une catégorie pour un cycliste qui se ravitaille. */
export const AUTO_SORT_BASE_QUALITY: Partial<Record<PoiCategory, number>> = {
  drinking_water: 1,
  water_point: 0.95,
  water_tap: 0.9,
  fountain: 0.6,
  cemetery: 0.5,
  spring: 0.45,
  supermarket: 1,
  convenience: 0.9,
  bakery: 0.95,
  marketplace: 0.45,
  butcher: 0.45,
  restaurant: 0.85,
  fast_food: 0.9,
  cafe: 0.65,
  bar: 0.5,
  pub: 0.45,
  ice_cream: 0.35,
  fuel: 0.65,
  vending_machine: 0.4,
  hotel: 1,
};

/**
 * Horaires « habituels » par catégorie (France), utilisés quand le POI n'a
 * pas de tag `opening_hours` — soit ~90 % des cas. Une boulangerie à 2h du
 * matin ou un restaurant à 16h sont très probablement fermés.
 */
export const AUTO_SORT_TYPICAL_HOURS: Partial<Record<PoiCategory, ClockWindow[]>> = {
  bakery: [{ startMin: h(6.5), endMin: h(13) }, { startMin: h(15.5), endMin: h(19.5) }],
  supermarket: [{ startMin: h(8.5), endMin: h(20) }],
  convenience: [{ startMin: h(8), endMin: h(12.5) }, { startMin: h(15), endMin: h(19.5) }],
  marketplace: [{ startMin: h(7), endMin: h(13) }],
  butcher: [{ startMin: h(8), endMin: h(12.5) }, { startMin: h(15.5), endMin: h(19) }],
  restaurant: [{ startMin: h(12), endMin: h(14) }, { startMin: h(19), endMin: h(22) }],
  fast_food: [{ startMin: h(11), endMin: h(14.5) }, { startMin: h(18), endMin: h(23) }],
  cafe: [{ startMin: h(7), endMin: h(20) }],
  bar: [{ startMin: h(8), endMin: h(24) }],
  pub: [{ startMin: h(17), endMin: h(26) }],
  ice_cream: [{ startMin: h(11), endMin: h(19) }],
  fuel: [{ startMin: h(7), endMin: h(20) }],
  vending_machine: [{ startMin: 0, endMin: h(24) }],
  hotel: [{ startMin: 0, endMin: h(24) }],
  // Grilles fermées la nuit (horaires municipaux : ~8 h → 17 h l'hiver, 19 h l'été).
  cemetery: [{ startMin: h(8), endMin: h(18) }],
};

/**
 * Familles de la règle des 6h (« même catégorie »), calquées sur les
 * catégories du panneau POI : Fontaines, Supermarchés, Boulangerie,
 * Restaurant, Fast-food, Café, Station service.
 */
export type AutoSortGapFamily =
  | 'water'
  | 'grocery'
  | 'bakery'
  | 'restaurant'
  | 'fastFood'
  | 'cafe'
  | 'fuel';

export const AUTO_SORT_GAP_FAMILY: Partial<Record<PoiCategory, AutoSortGapFamily>> = {
  drinking_water: 'water',
  water_point: 'water',
  water_tap: 'water',
  spring: 'water',
  fountain: 'water',
  cemetery: 'water',
  supermarket: 'grocery',
  convenience: 'grocery',
  marketplace: 'grocery',
  bakery: 'bakery',
  restaurant: 'restaurant',
  fast_food: 'fastFood',
  cafe: 'cafe',
  fuel: 'fuel',
};
