/** Internes de Mapbox GL dont la carte vidéo dépend (non publics : tous gardés, voir videoMap.ts). */

export interface TileIdLike {
  key: number;
  canonical: { z: number; x: number; y: number; url(urls: string[], scheme?: string): string };
}

export interface TileSourceLike {
  type?: string;
  id?: string;
  tiles?: string[];
  scheme?: string;
  tileSize?: number;
  minzoom?: number;
  maxzoom?: number;
  roundZoom?: boolean;
  reparseOverscaled?: boolean;
}

export interface TileLike {
  tileID: TileIdLike;
  state?: string;
  dem?: unknown;
  getExpiryTimeout?: () => number | undefined;
}

export interface SourceCacheLike {
  _source?: TileSourceLike;
  _sourceLoaded?: boolean;
  _tiles?: Record<string, TileLike | undefined>;
  _cache?: { add(id: TileIdLike, tile: TileLike, expiryTimeout?: number): unknown; has(id: TileIdLike): boolean };
  _preloadTiles?: (transforms: unknown[], callback: () => void) => void;
  _loadTile?: (tile: TileLike, callback: (error?: unknown) => void) => void;
  _unloadTile?: (tile: TileLike) => void;
  _addTile?: (id: TileIdLike) => TileLike | undefined;
  _backfillDEM?: (tile: TileLike) => void;
  usedForTerrain?: boolean;
  reload?: () => void;
}

interface RequestManagerLike {
  normalizeTileURL(url: string, use2x?: boolean, rasterTileSize?: number): string;
  transformRequest(url: string, type: string): { url: string; headers?: Record<string, string>; credentials?: RequestCredentials };
}

export interface TransformLike {
  clone(): TransformLike;
  coveringTiles(options: unknown): TileIdLike[];
  setFreeCameraOptions(options: unknown): void;
  zoom: number;
  center: unknown;
  pitch: number;
  bearing: number;
  fov?: number;
}

interface StyleImageLike {
  data?: { width: number; height: number; data: Uint8Array | Uint8ClampedArray };
  pixelRatio?: number;
  sdf?: boolean;
  stretchX?: Array<[number, number]>;
  stretchY?: Array<[number, number]>;
  content?: [number, number, number, number];
}

export interface MapInternals {
  _render: (timestamp: number) => void;
  _triggerFrame: (render: boolean) => void;
  _renderNextFrame?: boolean | null;
  _updateAverageElevation?: (timeStamp: number, ignoreTimeout?: boolean) => boolean;
  _update?: (updateStyle?: boolean) => unknown;
  _isInitialLoad?: boolean;
  _requestManager?: RequestManagerLike;
  painter?: { terrain?: { getScaledDemTileSize(): number } | null };
  transform: TransformLike;
  style?: {
    _mergedSourceCaches?: Record<string, SourceCacheLike>;
    _sourceCaches?: Record<string, SourceCacheLike>;
    getImage?: (id: string) => StyleImageLike | null | undefined;
  };
}
