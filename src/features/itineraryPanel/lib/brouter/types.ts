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
   * Optional `polygons` parameter — list of inclusion polygons
   * ("must stay inside"). Format already encoded for the URL.
   * @see formatPolygonsParam in ./geo
   */
  polygons?: string;
  /**
   * Optional `nogos` parameter — list of forbidden circles.
   * Format: `lon,lat,radiusM[,weight]|...`.
   */
  nogos?: string;
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

/** Logical preset that maps to either a server profile or a tweaked one. */
export type RedviewProfileId =
  | 'gravel-default'
  | 'road'
  | 'mtb'
  | 'touring'
  | 'custom';

export const DEFAULT_PROFILE = 'trekking';
