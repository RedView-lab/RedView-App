/**
 * Client HTTP BRouter — types publics.
 *
 * `BrouterRequest` est ce que construisent les appelants ; `BrouterRoute` est
 * le résultat normalisé qu'ils reçoivent après le parse du GeoJSON.
 *
 * `BrouterParamOverrides` est un sac libre de surcharges `profile:xxx` que le
 * panneau (ou le mode expert) ajoute à l'URL. Chaque valeur doit déjà être
 * convertie en texte avec la syntaxe de BRouter (`true` / `false` pour les
 * booléens, `1.5` pour les flottants, etc.).
 */

export interface BrouterPoint {
  lat: number;
  lon: number;
}

export interface BrouterRoute {
  /** Coordonnées décodées de la LineString GeoJSON (paires [lon, lat]). */
  coordinates: [number, number][];
  /** Longueur totale en mètres. */
  distanceM: number;
  /** Durée totale en secondes. */
  durationS: number;
  /** Dénivelé positif cumulé en mètres (filtré, convention BRouter). */
  ascentM: number;
  /** Dénivelé négatif cumulé en mètres (filtré). */
  descentM: number;
  /** FeatureCollection brute — pratique pour le débogage ou un rendu plus riche. */
  raw: GeoJSON.FeatureCollection;
}

/** Table des surcharges `profile:xxx` → valeurs converties en texte. */
export type BrouterParamOverrides = Record<string, string>;

export interface BrouterRequest {
  start: BrouterPoint;
  end: BrouterPoint;
  /** Points de passage intermédiaires optionnels. */
  via?: BrouterPoint[];
  /** Id de profil BRouter. Doit exister dans `profiles2/` sur le serveur,
   *  OU être un `custom_<id>` renvoyé par `uploadCustomProfile()`. */
  profile?: string;
  /** Indice de variante (0..3). 0 par défaut. */
  alternativeIdx?: 0 | 1 | 2 | 3;
  /** Surcharges libres `profile:xxx` appliquées par-dessus le profil de base. */
  overrides?: BrouterParamOverrides;
  /**
   * Paramètre `polygons` optionnel — liste de polygones fermés encodés pour
   * l'URL. En pratique, RedView s'en sert pour les zones absolument interdites.
   */
  polygons?: string;
  /**
   * Paramètre `nogos` optionnel — liste de cercles interdits.
   * Format : `lon,lat,radiusM[,weight]|...`.
   */
  nogos?: string;
  /**
   * Échelle de coût au mètre du profil (voir api/searchCoefficient.ts) : fixe
   * le coefficient de la recherche A*. Absente → échelle des profils stock.
   */
  searchCostScale?: number;
  /** Poids imposé de l'heuristique (tracé grossier) au lieu du poids selon la distance. */
  searchWeight?: number;
  /**
   * Délai de calcul voulu (ms), appliqué par le proxy APRÈS l'attente dans sa
   * file (`budgetMs`) : au-delà, 504 + `X-Brouter-Timeout: compute`. Ignoré
   * par un ancien proxy.
   */
  budgetMs?: number;
  /**
   * Recherche de secours (customProfileFetch.ts) : le proxy ne la met jamais
   * en file (503 immédiat sans place libre), et elle n'est pas réessayée.
   */
  hedge?: boolean;
  /**
   * Appelé dès réception des en-têtes : BRouter ne répond qu'une fois le tracé
   * calculé, le reste n'est que du téléchargement.
   */
  onResponseHeaders?: () => void;
  signal?: AbortSignal;
}

/** Résultat renvoyé par le point d'accès d'envoi de profil. */
export interface UploadedProfile {
  /** "custom_<timestamp>" — à repasser comme paramètre `profile` dans les GET de routage. */
  profileId: string;
  /** Erreur de validation côté serveur (s'il y en a une). Vraie → l'envoi a
   *  techniquement réussi mais le profil ne compilera pas. */
  error?: string;
}

export const DEFAULT_PROFILE = 'trekking';

/** Profil piéton d'origine livré avec BRouter (présent sur le VPS). */
export const FOOT_FALLBACK_PROFILE = 'hiking-mountain';
