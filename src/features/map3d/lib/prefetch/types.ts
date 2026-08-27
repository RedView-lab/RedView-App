export interface ViewportPrefetchOptions {
  /** Returns true when the IGN ortho overlay is engaged on the map. */
  isOrthoActive?: () => boolean;
  /** Returns true when the slope overlay layer is visible on the map. */
  isSlopeActive?: () => boolean;
  /** Returns true when the altitude overlay layer is visible on the map. */
  isAltitudeActive?: () => boolean;
}

export interface PrewarmDestinationOptions {
  /** Override ortho-overlay state for the destination (defaults to current). */
  withOrtho?: boolean;
  /** Optional radius (tiles) around the destination to warm. Default 1 (3×3). */
  radius?: number;
  /** Set false to skip z+1 children warming (default true). */
  includeChildren?: boolean;
}

export interface ViewportPrefetchHandle {
  dispose: () => void;
  /** Force a prefetch cycle (useful after style switch). */
  trigger: () => void;
  /**
   * Eagerly warm the SW cache for a known future viewport (search bar
   * teleport, programmatic easeTo, etc.). Runs in parallel with the
   * camera animation so by the time the camera arrives, the foreground
   * tiles are already in CacheStorage.
   */
  prewarmDestination: (
    lng: number,
    lat: number,
    zoom: number,
    opts?: PrewarmDestinationOptions,
  ) => void;
}
