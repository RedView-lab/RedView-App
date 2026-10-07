/**
 * BRouter HTTP client — public types.
 *
 * `BrouterRequest` is what callers build; `BrouterRoute` is the
 * normalised result they receive after the GeoJSON is parsed.
 *
 * `BrouterParamOverrides` is a free-form bag of `profile:xxx` overrides
 * that the panel (or the Expert Mode) appends to the URL. Each value
 * must already be stringified using BRouter's syntax (`true` / `false`
 * for booleans, `1.5` for floats, etc.).
 */

export interface BrouterPoint {
  lat: number;
  lon: number;
}

export interface BrouterRoute {
  /** Decoded GeoJSON LineString coordinates ([lon, lat] pairs). */
  coordinates: [number, number][];
  /** Total length in metres. */
  distanceM: number;
  /** Total duration in seconds. */
  durationS: number;
  /** Cumulative ascent in metres (filtered, BRouter convention). */
  ascentM: number;
  /** Cumulative descent in metres (filtered). */
  descentM: number;
  /** Raw FeatureCollection — handy for debugging or richer rendering. */
  raw: GeoJSON.FeatureCollection;
}

/** Map of `profile:xxx` overrides → stringified values. */
export type BrouterParamOverrides = Record<string, string>;

export interface BrouterRequest {
  start: BrouterPoint;
  end: BrouterPoint;
  /** Optional intermediate via-points. */
  via?: BrouterPoint[];
  /** BRouter profile id. Must exist in `profiles2/` on the server,
   *  OR be a `custom_<id>` returned from `uploadCustomProfile()`. */
  profile?: string;
  /** Alternative index (0..3). Defaults to 0. */
  alternativeIdx?: 0 | 1 | 2 | 3;
  /** Free-form `profile:xxx` overrides applied on top of the base profile. */
  overrides?: BrouterParamOverrides;
  /**
    * Optional `polygons` parameter — list of closed polygons encoded for
    * the URL. In practice RedView uses it for absolute no-go areas.
   */
  polygons?: string;
  /**
   * Optional `nogos` parameter — list of forbidden circles.
   * Format: `lon,lat,radiusM[,weight]|...`.
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
   * Appelé dès réception des en-têtes : BRouter ne répond qu'une fois le tracé
   * calculé, le reste n'est que du téléchargement.
   */
  onResponseHeaders?: () => void;
  signal?: AbortSignal;
}

/** Result returned by the profile upload endpoint. */
export interface UploadedProfile {
  /** "custom_<timestamp>" — pass back as `profile` param on routing GETs. */
  profileId: string;
  /** Server-side validation error (if any). Truthy → upload technically
   *  succeeded but the profile won't compile. */
  error?: string;
}

export const DEFAULT_PROFILE = 'trekking';

/** Stock pedestrian profile shipped with BRouter (present on the VPS). */
export const FOOT_FALLBACK_PROFILE = 'hiking-mountain';
