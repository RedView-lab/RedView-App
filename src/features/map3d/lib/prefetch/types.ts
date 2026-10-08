export interface ViewportPrefetchOptions {
  /** Renvoie true quand l'overlay d'ortho IGN est engagé sur la carte. */
  isOrthoActive?: () => boolean;
  /** Renvoie true quand le calque d'overlay des pentes est visible sur la carte. */
  isSlopeActive?: () => boolean;
}

export interface PrewarmDestinationOptions {
  /** Force l'état de l'overlay d'ortho pour la destination (par défaut : l'état courant). */
  withOrtho?: boolean;
  /** Rayon optionnel (en tuiles) autour de la destination à préchauffer. 1 par défaut (3×3). */
  radius?: number;
  /** false pour sauter le préchauffage des enfants z+1 (true par défaut). */
  includeChildren?: boolean;
}

export interface ViewportPrefetchHandle {
  dispose: () => void;
  /** Force un cycle de préchargement (utile après un changement de style). */
  trigger: () => void;
  /**
   * Préchauffe tout de suite le cache du SW pour une vue future connue
   * (téléportation par la barre de recherche, easeTo programmé, etc.). Tourne
   * en parallèle de l'animation de la caméra : quand la caméra arrive, les
   * tuiles de premier plan sont déjà dans CacheStorage.
   */
  prewarmDestination: (
    lng: number,
    lat: number,
    zoom: number,
    opts?: PrewarmDestinationOptions,
  ) => void;
}
