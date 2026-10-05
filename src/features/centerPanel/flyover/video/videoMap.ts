import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap } from 'mapbox-gl';
import { transformMapboxRequest, withDevicePixelRatio } from '@/features/map3d';
import {
  ANALYSIS_HOVER_SOURCE_ID,
  getRouteElevationContext,
  ROUTE_HOVER_PREVIEW_SOURCE_ID,
  setAnalysisFlyoverOpacity,
  setAnalysisFlyoverProgress,
  setAnalysisFlyoverRoute,
  setRouteLayerVisibility,
} from '@/features/itineraryPanel/lib/route-layer';
import { POI_GPU_SOURCE_ID } from '@/features/poi/lib/poi-markers';
import { OVERVIEW_PADDING_RATIO, OVERVIEW_PITCH_DEG } from '../config';
import type { CameraPose } from '../engine/cameraPose';
import { latFromMercatorY, lngFromMercatorX, mercatorXFromLng, mercatorYFromLat, metersPerMercatorUnitAtY } from '../engine/geo';
import { applyCameraPose, readCameraPose } from '../map/cameraDriver';
import { createGroundSampler, readTerrainExaggeration } from '../map/terrain';
import type { FlyoverRouteInput } from '../types';
import { FRAME_RETRY_TIMEOUT_MS, FRAME_SETTLE_TIMEOUT_MS, MAP_LOAD_TIMEOUT_MS } from './config';
import type { DirectorMap, VideoCamera, VideoShot } from './director';
import type { MapView } from './flight';

/* ── Internes Mapbox utilisés (tous gardés) ───────────────────────────── */

interface TileIdLike {
  key: number;
  canonical: { z: number; x: number; y: number; url(urls: string[], scheme?: string): string };
}

interface TileSourceLike {
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

interface TileLike {
  tileID: TileIdLike;
  state?: string;
  dem?: unknown;
  getExpiryTimeout?: () => number | undefined;
}

interface SourceCacheLike {
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

interface TransformLike {
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

interface MapInternals {
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

type StyleSpec = mapboxgl.StyleSpecification;
type LayerSpec = mapboxgl.LayerSpecification;
type SourceSpec = mapboxgl.SourceSpecification;

/** Sources custom de la carte vivante à recréer sur la carte vidéo (`cloneForMap`). */
interface CustomSourceClone {
  id: string;
  create: () => unknown;
  layers: Array<{ layer: LayerSpec; beforeId: string | undefined }>;
}

interface ClonedStyle {
  style: StyleSpec;
  customSources: CustomSourceClone[];
  /** Calques de ligne surélevés : leur décalage d'origine, pour suivre plat ↔ relief. */
  elevatedLineLayers: Map<string, number>;
}

/** Sources de la carte vivante sans place dans la vidéo : POI masqués, survols. */
const DROPPED_SOURCE_IDS = new Set([POI_GPU_SOURCE_ID, ANALYSIS_HOVER_SOURCE_ID, ROUTE_HOVER_PREVIEW_SOURCE_ID]);
/** Sources tuilées dont les tuiles à venir sont demandées d'avance (cache HTTP / Service Worker). */
const PRELOADED_SOURCE_TYPES = new Set(['raster', 'raster-dem', 'vector']);
/** Requêtes de préchargement simultanées : la carte garde la priorité sur ses propres tuiles. */
const PRELOAD_CONCURRENCY = 8;
const PRELOAD_QUEUE_MAX = 2000;
/** Mise en route : toutes les tuiles des premières secondes (approche : du parcours entier à la rue). */
const WARMUP_CONCURRENCY = 16;
/**
 * Tuiles neuves préchargées au plus par source et par appel (les plus proches
 * d'abord) : la file d'images de Mapbox est FIFO, l'image en cours ne doit
 * pas attendre derrière des tuiles lointaines.
 */
const PRELOAD_TILES_PER_CALL = 16;

function abortError(): DOMException {
  return new DOMException('Export annulé', 'AbortError');
}

/**
 * Contexte WebGL de la carte vidéo perdu (mémoire graphique réclamée par le
 * système ou le navigateur — Safari le fait sous pression mémoire) : les
 * images suivantes seraient noires, l'export s'arrête.
 */
export class FlyoverVideoContextLostError extends Error {
  constructor() {
    super("La mémoire graphique a manqué pendant le rendu de la vidéo. Fermez d'autres onglets ou applications, puis relancez l'export.");
    this.name = 'FlyoverVideoContextLostError';
  }
}

/**
 * Rend la main à la page sans minuterie : un onglet en arrière-plan plafonne
 * `setTimeout` à une fois par seconde, pas les messages.
 */
function yieldToPage(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

function cloneJson<T>(value: T): T {
  return value == null ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Style de la carte vivante, tel qu'à l'instant de l'export, pour une carte
 * qui tourne image par image : sources custom recréées à part, POI et survols
 * retirés, fondus de tuiles et transitions de style à zéro (une image n'est
 * prise qu'une fois tout chargé), tuiles du relief hors de l'arbitrage du
 * Service Worker (`rv-src=map` : la carte vivante y annonce les seules tuiles
 * qu'elle attend, celles de la vidéo seraient abandonnées).
 */
function cloneLiveStyle(liveMap: MapboxMap): ClonedStyle {
  const live = liveMap.getStyle() as StyleSpec;
  const customSources = new Map<string, CustomSourceClone>();
  const dropped = new Set<string>();
  const sources: Record<string, SourceSpec> = {};
  for (const [id, raw] of Object.entries(live.sources ?? {})) {
    const source = raw as SourceSpec;
    if (DROPPED_SOURCE_IDS.has(id)) {
      dropped.add(id);
      continue;
    }
    // Source JS (`addSource` d'un objet) : sérialisée telle quelle, sans ses méthodes.
    if ((source as { type: string }).type === 'custom') {
      dropped.add(id);
      const implementation = (liveMap.getSource(id) as unknown as { _implementation?: { cloneForMap?: () => unknown } } | undefined)
        ?._implementation;
      if (typeof implementation?.cloneForMap === 'function') {
        customSources.set(id, { id, create: () => implementation.cloneForMap?.(), layers: [] });
      }
      continue;
    }
    if (source.type === 'geojson') {
      // Les données GeoJSON sont celles de la carte vivante (même objet) : la carte vidéo n'en écrit aucune.
      sources[id] = source;
      continue;
    }
    const copy = cloneJson(source) as SourceSpec & { tiles?: string[] };
    if (copy.type === 'raster-dem' && Array.isArray(copy.tiles)) {
      copy.tiles = copy.tiles.map((url) => url.replace('rv-src=map', 'rv-src=video'));
    }
    sources[id] = copy;
  }

  const layers: LayerSpec[] = [];
  const elevatedLineLayers = new Map<string, number>();
  const liveLayers = (live.layers ?? []) as LayerSpec[];
  liveLayers.forEach((original, index) => {
    const sourceId = (original as { source?: unknown }).source;
    if (typeof sourceId === 'string' && dropped.has(sourceId)) {
      const custom = customSources.get(sourceId);
      if (custom) {
        const next = liveLayers.slice(index + 1).find((candidate) => {
          const candidateSource = (candidate as { source?: unknown }).source;
          return !(typeof candidateSource === 'string' && dropped.has(candidateSource));
        });
        custom.layers.push({ layer: cloneJson(original), beforeId: next?.id });
      }
      return;
    }
    const layer = cloneJson(original) as LayerSpec & {
      paint?: Record<string, unknown>;
      layout?: Record<string, unknown>;
    };
    if (layer.type === 'raster') layer.paint = { ...(layer.paint ?? {}), 'raster-fade-duration': 0 };
    if (layer.type === 'line' && layer.layout && 'line-elevation-reference' in layer.layout) {
      const offset = Number(layer.layout['line-z-offset']);
      elevatedLineLayers.set(layer.id, Number.isFinite(offset) && offset > 0 ? offset : 0);
    }
    layers.push(layer);
  });

  const style: StyleSpec = {
    ...live,
    sources,
    layers,
    transition: { duration: 0, delay: 0 },
  };
  return { style, customSources: [...customSources.values()], elevatedLineLayers };
}

/** `@2x` pour le sprite : chargé hors rendu, il suivrait le ratio de l'écran et non celui de la vidéo. */
function videoTransformRequest(pixelRatio: number) {
  return (url: string, resourceType?: string) => {
    if (pixelRatio >= 2 && (resourceType === 'SpriteImage' || resourceType === 'SpriteJSON')) {
      return { url: url.replace(/\/sprite(?!@2x)(?=(\.png|\.json)?(\?|$))(\.png|\.json)?/, '/sprite@2x$3') };
    }
    return transformMapboxRequest(url, resourceType);
  };
}

export interface VideoMapOptions {
  liveMap: MapboxMap;
  /** Taille de la vidéo (px) = taille de la carte en px CSS. */
  width: number;
  height: number;
  /** Rapport rendu / vidéo (suréchantillonnage). */
  pixelRatio: number;
  fovDeg: number;
  route: FlyoverRouteInput;
  signal: AbortSignal;
}

/**
 * Carte Mapbox hors écran qui rend la vidéo : copie du style de la carte
 * vivante (fond, relief et sa qualité, pente, altitude, couleurs, tracés),
 * dans un conteneur à la taille de la vidéo, rendue à `pixelRatio` sans
 * toucher la carte de l'écran. Aucun rendu n'est laissé à
 * requestAnimationFrame : la boucle d'export rend chaque image quand elle le
 * décide (pas d'attente de vsync, rendu poursuivi dans un onglet en
 * arrière-plan) et ne la prend qu'une fois toutes ses tuiles chargées.
 */
export class VideoMap {
  readonly map: MapboxMap;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;

  private readonly container: HTMLDivElement;
  private readonly internals: MapInternals;
  private readonly route: FlyoverRouteInput;
  private readonly elevatedLineLayers: Map<string, number>;
  private readonly liveMap: MapboxMap;
  private readonly preloaded = new Set<string>();
  private readonly preloadQueue: Array<{ url: string; credentials?: RequestCredentials; headers?: Record<string, string> }> = [];
  private preloadInFlight = 0;
  private readonly pendingReloads = new Set<string>();
  private reloadTimer = 0;
  private wakeUp: (() => void) | null = null;
  private clockBiasMs = 0;
  private elevationSignature = '';
  private trailProgress = -1;
  private trailOpacity = -1;
  private destroyed = false;
  private contextLost = false;
  private lastFrameTimedOut = false;
  /** Mesures du rendu (journal de fin d'export). */
  readonly stats = { renders: 0, renderMs: 0, waitMs: 0, waitBySource: new Map<string, number>() };

  private constructor(options: VideoMapOptions, cloned: ClonedStyle) {
    this.liveMap = options.liveMap;
    this.width = options.width;
    this.height = options.height;
    this.pixelRatio = options.pixelRatio;
    this.route = options.route;
    this.elevatedLineLayers = cloned.elevatedLineLayers;

    const container = document.createElement('div');
    container.setAttribute('aria-hidden', 'true');
    container.dataset.rvFlyoverVideo = '';
    Object.assign(container.style, {
      position: 'fixed',
      left: '-100000px',
      top: '0',
      width: `${options.width}px`,
      height: `${options.height}px`,
      pointerEvents: 'none',
      overflow: 'hidden',
      contain: 'strict',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(container);
    this.container = container;

    const live = options.liveMap;
    const center = live.getCenter();
    this.map = withDevicePixelRatio(options.pixelRatio, () =>
      new mapboxgl.Map({
        container,
        style: cloned.style,
        center: [center.lng, center.lat],
        zoom: live.getZoom(),
        pitch: live.getPitch(),
        bearing: live.getBearing(),
        projection: live.getProjection?.()?.name ?? 'globe',
        interactive: false,
        attributionControl: true,
        antialias: false,
        // L'image est lue juste après son rendu, dans la même tâche ; gardé
        // quand même : la lecture ne dépend plus du moment où le navigateur
        // présente le canevas (WebGL dans le processus GPU de Safari).
        preserveDrawingBuffer: true,
        fadeDuration: 0,
        trackResize: false,
        refreshExpiredTiles: false,
        performanceMetricsCollection: false,
        respectPrefersReducedMotion: false,
        maxTileCacheSize: 1200,
        localIdeographFontFamily: 'sans-serif',
        transformRequest: videoTransformRequest(options.pixelRatio),
      } as mapboxgl.MapOptions),
    );
    this.internals = this.map as unknown as MapInternals;
    this.installRenderControl();
    this.map.on('styleimagemissing', this.copyMissingImage);
    this.map.on('webglcontextlost', this.handleContextLost);
    navigator.serviceWorker?.addEventListener('message', this.handleWorkerMessage);
  }

  private readonly handleContextLost = () => {
    this.contextLost = true;
    console.warn('[flyover-video] contexte WebGL perdu');
    this.wake();
  };

  private assertRenderable(signal: AbortSignal): void {
    if (signal.aborted) throw abortError();
    if (this.contextLost) throw new FlyoverVideoContextLostError();
  }

  /** Crée la carte, attend son chargement complet et y monte la trace du flyover. */
  static async create(options: VideoMapOptions): Promise<VideoMap> {
    const cloned = cloneLiveStyle(options.liveMap);
    const video = new VideoMap(options, cloned);
    try {
      await video.waitForLoad(options.signal);
      video.setFov(options.fovDeg);
      for (const custom of cloned.customSources) video.addCustomSource(custom);
      setRouteLayerVisibility(video.map, options.route.itineraryId, false);
      video.syncRouteElevation(true);
      const canvas = video.map.getCanvas();
      console.info(`[flyover-video] carte ${canvas.width}×${canvas.height} pour une vidéo ${options.width}×${options.height}`);
      return video;
    } catch (error) {
      video.destroy();
      throw error;
    }
  }

  /* ── Boucle de rendu ─────────────────────────────────────────────── */

  /**
   * Plus de requestAnimationFrame : Mapbox ne fait que noter qu'une image est
   * due, la boucle d'export rend. Chaque rendu se fait au ratio de la vidéo,
   * horloge Mapbox figée pendant le rendu (placement des étiquettes jamais
   * interrompu) et avancée d'une seconde à chaque rendu : toujours devant les
   * horodatages réels des tuiles, fondus et lissages terminés à l'image
   * suivante.
   */
  private installRenderControl(): void {
    const internals = this.internals;
    const render = internals._render;
    const pixelRatio = this.pixelRatio;
    internals._render = (timestamp: number) => {
      void timestamp;
      const now = performance.now() + this.clockBiasMs;
      this.clockBiasMs += 1000;
      withDevicePixelRatio(pixelRatio, () => {
        mapboxgl.setNow(now);
        try {
          render.call(internals, now);
        } finally {
          mapboxgl.restoreNow();
        }
      });
    };
    internals._triggerFrame = (renderFrame: boolean) => {
      internals._renderNextFrame = Boolean(internals._renderNextFrame) || renderFrame;
      this.wake();
    };
    // Altitude moyenne du relief vu (brouillard, horizon) : Mapbox la lisse sur
    // 300 ms et redemande un rendu complet à chaque changement — deux rendus 4K
    // par image en mouvement. Ici elle est échantillonnée à chaque rendu et
    // appliquée d'un coup, avant la mise à jour des sources de ce même rendu.
    const updateAverageElevation = internals._updateAverageElevation;
    if (typeof updateAverageElevation === 'function') {
      internals._updateAverageElevation = (timeStamp: number) => {
        const ownUpdate = Object.prototype.hasOwnProperty.call(internals, '_update');
        const update = internals._update;
        const initialLoad = internals._isInitialLoad;
        internals._update = () => internals;
        internals._isInitialLoad = true;
        try {
          updateAverageElevation.call(internals, timeStamp, true);
        } finally {
          if (ownUpdate) internals._update = update;
          else delete internals._update;
          internals._isInitialLoad = initialLoad;
        }
        return false;
      };
    }
  }

  private wake(): void {
    const wake = this.wakeUp;
    this.wakeUp = null;
    wake?.();
  }

  /** Attend un signe de la carte (tuile arrivée, style modifié) ou `timeoutMs`. */
  private waitForActivity(timeoutMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(done, timeoutMs);
      const onAbort = () => {
        cleanup();
        reject(abortError());
      };
      function cleanup() {
        window.clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
      function done() {
        cleanup();
        resolve();
      }
      this.wakeUp = done;
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Un rendu ; vrai si la carte était entièrement chargée (événement `idle` émis pendant ce rendu). */
  private renderOnce(): boolean {
    if (this.destroyed) return false;
    let idle = false;
    const onIdle = () => {
      idle = true;
    };
    this.map.on('idle', onIdle);
    const start = performance.now();
    try {
      this.internals._renderNextFrame = null;
      this.internals._render(0);
    } finally {
      this.map.off('idle', onIdle);
      this.stats.renders += 1;
      this.stats.renderMs += performance.now() - start;
    }
    return idle;
  }

  /**
   * Rend jusqu'à ce que l'image soit complète (toutes les tuiles, sources et
   * étiquettes), puis appelle `capture` dans la même tâche — le tampon WebGL
   * est encore celui de ce rendu. Rend `false` si le délai est écoulé (image
   * prise quand même).
   */
  async renderSettled(capture: (canvas: HTMLCanvasElement) => void, signal: AbortSignal): Promise<boolean> {
    const deadline = performance.now() + (this.lastFrameTimedOut ? FRAME_RETRY_TIMEOUT_MS : FRAME_SETTLE_TIMEOUT_MS);
    let immediate = 0;
    for (;;) {
      this.assertRenderable(signal);
      if (this.renderOnce()) {
        capture(this.map.getCanvas());
        this.lastFrameTimedOut = false;
        return true;
      }
      if (performance.now() > deadline) {
        capture(this.map.getCanvas());
        if (!this.lastFrameTimedOut) {
          console.warn('[flyover-video] image prise sans attendre la fin du chargement', this.describePending());
        }
        this.lastFrameTimedOut = true;
        return false;
      }
      const waitStart = performance.now();
      // Un rendu est encore dû (sources, placement) : on le refait sans attendre, en laissant respirer la page.
      if (this.internals._renderNextFrame && immediate < 8 && this.map.areTilesLoaded()) {
        immediate += 1;
        await yieldToPage();
      } else if (this.map.areTilesLoaded()) {
        immediate = 0;
        await this.waitForActivity(30, signal);
      } else {
        immediate = 0;
        // Sources arrivées les dernières : celles qui ont fait attendre l'image.
        let blockers = this.pendingSourceIds();
        // Aucun rendu tant que des tuiles manquent : un rendu 4K par tuile arrivée serait perdu.
        do {
          await this.waitForActivity(250, signal);
          const pending = this.pendingSourceIds();
          if (pending.length) blockers = pending;
        } while (!this.map.areTilesLoaded() && performance.now() < deadline);
        const waited = performance.now() - waitStart;
        for (const id of blockers) this.stats.waitBySource.set(id, (this.stats.waitBySource.get(id) ?? 0) + waited);
      }
      this.stats.waitMs += performance.now() - waitStart;
    }
  }

  /** Sources dont des tuiles sont en cours de chargement. */
  private pendingSourceIds(): string[] {
    return Object.entries(this.sourceCaches() ?? {})
      .filter(([, cache]) => cache && this.hasPendingTiles(cache))
      .map(([id]) => id);
  }

  private hasPendingTiles(cache: SourceCacheLike): boolean {
    for (const tile of Object.values(cache._tiles ?? {})) {
      if (tile?.state && tile.state !== 'loaded' && tile.state !== 'errored') return true;
    }
    return false;
  }

  /** Ce qui empêche l'image d'être complète (journal d'un délai dépassé). */
  private describePending(): string {
    const internals = this.internals as MapInternals & { _styleDirty?: boolean; _sourcesDirty?: boolean; _placementDirty?: boolean };
    const pending: string[] = [];
    for (const [id, cache] of Object.entries(this.sourceCaches() ?? {})) {
      const states = new Map<string, number>();
      for (const tile of Object.values(cache?._tiles ?? {})) {
        const state = tile?.state ?? '?';
        if (state === 'loaded' || state === 'errored') continue;
        states.set(state, (states.get(state) ?? 0) + 1);
      }
      if (states.size) pending.push(`${id}: ${[...states].map(([state, n]) => `${n} ${state}`).join(', ')}`);
    }
    const flags = (['_styleDirty', '_sourcesDirty', '_placementDirty'] as const).filter((flag) => internals[flag]);
    return [...pending, flags.length ? `flags ${flags.join(' ')}` : '', `style ${this.map.isStyleLoaded() ? 'chargé' : 'en cours'}`]
      .filter(Boolean)
      .join(' · ');
  }

  private async waitForLoad(signal: AbortSignal): Promise<void> {
    let loaded = false;
    let failure: unknown = null;
    const onLoad = () => {
      loaded = true;
    };
    const onError = (event: { error?: unknown; sourceId?: unknown; tile?: unknown }) => {
      // Une tuile en erreur ne bloque pas ; un style refusé (validation, sprite) l'est.
      if (event.sourceId == null && event.tile == null && !this.map.isStyleLoaded()) failure = event.error ?? event;
    };
    this.map.once('load', onLoad);
    this.map.on('error', onError);
    const deadline = performance.now() + MAP_LOAD_TIMEOUT_MS;
    try {
      while (!loaded) {
        this.assertRenderable(signal);
        if (failure) throw failure;
        if (performance.now() > deadline) throw new Error('La carte de la vidéo ne se charge pas.');
        this.renderOnce();
        if (loaded) break;
        await this.waitForActivity(100, signal);
      }
    } finally {
      this.map.off('load', onLoad);
      this.map.off('error', onError);
    }
  }

  /* ── Mise en place ────────────────────────────────────────────────── */

  private setFov(fovDeg: number): void {
    const transform = this.internals.transform;
    if (typeof transform.fov === 'number') transform.fov = fovDeg;
  }

  private addCustomSource(custom: CustomSourceClone): void {
    try {
      const implementation = custom.create();
      if (!implementation) return;
      this.map.addSource(custom.id, implementation as SourceSpec);
      for (const { layer, beforeId } of custom.layers) {
        this.map.addLayer(layer, beforeId && this.map.getLayer(beforeId) ? beforeId : undefined);
      }
    } catch (error) {
      console.warn(`[flyover-video] source ${custom.id} not cloned`, error);
    }
  }

  /** Image (motif, icône) ajoutée à l'exécution sur la carte vivante : copiée telle quelle. */
  private readonly copyMissingImage = (event: { id?: string }) => {
    const id = event.id;
    if (!id || this.map.hasImage(id)) return;
    try {
      const image = (this.liveMap as unknown as MapInternals).style?.getImage?.(id);
      const data = image?.data;
      if (!data || !data.width || !data.height) return;
      this.map.addImage(
        id,
        { width: data.width, height: data.height, data: new Uint8Array(data.data) },
        {
          pixelRatio: image.pixelRatio ?? 1,
          sdf: image.sdf ?? false,
          ...(image.stretchX ? { stretchX: image.stretchX } : {}),
          ...(image.stretchY ? { stretchY: image.stretchY } : {}),
          ...(image.content ? { content: image.content } : {}),
        },
      );
    } catch {
      /* image absente aussi de la carte vivante */
    }
  };

  /* ── Image par image ─────────────────────────────────────────────── */

  /** Pose la caméra, la trace et son opacité d'une image. */
  applyShot(shot: VideoShot): void {
    this.applyCamera(shot.camera);
    this.syncRouteElevation(false);
    if (shot.trailProgress !== this.trailProgress) {
      this.trailProgress = shot.trailProgress;
      setAnalysisFlyoverProgress(this.map, shot.trailProgress);
    }
    if (shot.trailOpacity !== this.trailOpacity) {
      this.trailOpacity = shot.trailOpacity;
      setAnalysisFlyoverOpacity(this.map, shot.trailOpacity);
    }
  }

  applyView(view: MapView): void {
    this.map.jumpTo({
      center: [lngFromMercatorX(view.x), latFromMercatorY(view.y)],
      zoom: view.zoom,
      pitch: view.pitchDeg,
      bearing: view.bearingDeg,
    });
  }

  private applyCamera(camera: VideoCamera): void {
    if (camera.kind === 'view') this.applyView(camera.view);
    else applyCameraPose(this.map, camera.pose);
  }

  /**
   * Trace et tracés en relief au-dessus du zoom 6,5, drapés en dessous (le
   * globe ignore les lignes surélevées) : même bascule que la carte vivante,
   * suivie image par image.
   */
  private syncRouteElevation(force: boolean): void {
    const { elevated, signature } = getRouteElevationContext(this.map);
    if (!force && signature === this.elevationSignature) return;
    this.elevationSignature = signature;
    for (const [layerId, offset] of this.elevatedLineLayers) {
      if (!this.map.getLayer(layerId)) continue;
      this.map.setLayoutProperty(layerId, 'line-elevation-reference' as never, (elevated ? 'ground' : 'none') as never);
      this.map.setLayoutProperty(layerId, 'line-z-offset' as never, (elevated ? offset : 0) as never);
    }
    // La trace du flyover est (re)posée avec le contexte courant ; progression et opacité réappliquées.
    setAnalysisFlyoverRoute(this.map, this.route.points, this.route.color);
    if (this.trailProgress >= 0) setAnalysisFlyoverProgress(this.map, this.trailProgress);
    if (this.trailOpacity >= 0) setAnalysisFlyoverOpacity(this.map, this.trailOpacity);
  }

  /** Position (px de la vidéo) d'un point de la trace, relief compris ; `null` hors champ. */
  project(lng: number, lat: number): { x: number; y: number } | null {
    try {
      const point = this.map.project([lng, lat]);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1e6) return null;
      return { x: point.x, y: point.y };
    } catch {
      return null;
    }
  }

  /* ── Préchargement ───────────────────────────────────────────────── */

  /**
   * Charge dès maintenant les tuiles des poses à venir (relief, pente,
   * imagerie, fond vectoriel), les plus proches d'abord, chacune une fois.
   * Chaque tuile chargée entre dans le cache de tuiles de sa source : quand
   * la caméra arrive, Mapbox l'y reprend telle quelle — téléchargement,
   * décodage et envoi au GPU ont eu lieu pendant le rendu des images
   * précédentes au lieu de bloquer celle-ci. Sans ces internes, repli : un
   * simple `fetch` des mêmes URL, qui remplit au moins les caches (Service
   * Worker, HTTP).
   */
  preload(cameras: readonly VideoCamera[]): void {
    const caches = this.sourceCaches();
    if (!caches || cameras.length === 0) return;
    const transforms = cameras.map((camera) => this.transformFor(camera)).filter((tr): tr is TransformLike => tr != null);
    if (transforms.length === 0) return;
    const demTileSize = this.internals.painter?.terrain?.getScaledDemTileSize();
    withDevicePixelRatio(this.pixelRatio, () => {
      for (const [cacheId, cache] of Object.entries(caches)) {
        const source = cache?._source;
        if (!cache?._sourceLoaded || !source?.type || !PRELOADED_SOURCE_TYPES.has(source.type)) continue;
        // L'image en cours d'abord : pas de préchargement dans une source qui charge
        // encore ses tuiles visibles (S3 et d'autres hôtes HTTP/1.1 n'ouvrent que
        // 6 connexions, une tuile lointaine passerait devant une tuile à l'écran).
        if (this.hasPendingTiles(cache)) continue;
        const tileIds = this.upcomingTiles(cacheId, cache, transforms, demTileSize);
        if (tileIds.length === 0) continue;
        if (!this.preloadIntoTileCache(cache, tileIds)) this.warmHttpCache(cache, tileIds);
      }
    });
    this.pumpPreloads();
  }

  /**
   * Mise en route, avant la première image : toutes les tuiles des poses
   * données (plan d'ouverture et survol d'approche, où le zoom traverse dix
   * niveaux en deux secondes) sont téléchargées dans les caches HTTP et du
   * Service Worker — sans décodage ni texture, quel que soit leur nombre —
   * puis on attend qu'elles soient arrivées (au plus `maxMs`).
   */
  async warmUp(
    cameras: readonly VideoCamera[],
    signal: AbortSignal,
    maxMs: number,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    const caches = this.sourceCaches();
    if (!caches || cameras.length === 0) return;
    const transforms = cameras.map((camera) => this.transformFor(camera)).filter((tr): tr is TransformLike => tr != null);
    const demTileSize = this.internals.painter?.terrain?.getScaledDemTileSize();
    const seen = new Set<string>();
    for (const [cacheId, cache] of Object.entries(caches)) {
      const source = cache?._source;
      if (!cache?._sourceLoaded || !source?.type || !PRELOADED_SOURCE_TYPES.has(source.type)) continue;
      const tileIds = this.upcomingTiles(cacheId, cache, transforms, demTileSize, { limit: Number.POSITIVE_INFINITY, seen });
      this.warmHttpCache(cache, tileIds);
    }
    const total = this.preloadQueue.length + this.preloadInFlight;
    this.pumpPreloads(WARMUP_CONCURRENCY);
    const startedAt = performance.now();
    const deadline = startedAt + maxMs;
    while ((this.preloadQueue.length > 0 || this.preloadInFlight > 0) && performance.now() < deadline) {
      if (signal.aborted) throw abortError();
      await this.waitForActivity(100, signal);
      const remaining = this.preloadQueue.length + this.preloadInFlight;
      // Tuiles arrivées ou temps écoulé : le plus avancé des deux (attente bornée).
      onProgress?.(Math.max(total > 0 ? 1 - remaining / total : 1, (performance.now() - startedAt) / maxMs));
    }
  }

  /** Tuiles des poses à venir encore inconnues de la source (ni affichées, ni en cache, ni déjà demandées). */
  private upcomingTiles(
    cacheId: string,
    cache: SourceCacheLike,
    transforms: readonly TransformLike[],
    demTileSize: number | undefined,
    { limit = PRELOAD_TILES_PER_CALL, seen = this.preloaded }: { limit?: number; seen?: Set<string> } = {},
  ): TileIdLike[] {
    const source = cache._source as TileSourceLike;
    const forTerrain = Boolean(cache.usedForTerrain && demTileSize);
    const options = {
      tileSize: forTerrain ? demTileSize : source.tileSize,
      minzoom: source.minzoom,
      maxzoom: source.maxzoom,
      roundZoom: Boolean(source.roundZoom) && !forTerrain,
      reparseOverscaled: source.reparseOverscaled,
      isTerrainDEM: forTerrain,
    };
    const selected: TileIdLike[] = [];
    for (const tr of transforms) {
      let tileIds: TileIdLike[];
      try {
        tileIds = tr.coveringTiles(options);
      } catch {
        continue;
      }
      for (const id of tileIds) {
        if (selected.length >= limit) return selected;
        const key = `${cacheId}/${id.key}`;
        if (seen.has(key) || cache._tiles?.[id.key] || cache._cache?.has(id)) continue;
        seen.add(key);
        selected.push(id);
      }
    }
    return selected;
  }

  /**
   * Préchargement par Mapbox lui-même (`_preloadTiles`), mais chaque tuile
   * chargée est adoptée par le cache de la source au lieu d'être jetée (ce
   * que fait `_preloadTiles` : texture GPU perdue). Faux si les internes
   * manquent.
   */
  private preloadIntoTileCache(cache: SourceCacheLike, tileIds: TileIdLike[]): boolean {
    const loadTile = cache._loadTile;
    if (!cache._cache || typeof cache._preloadTiles !== 'function' || typeof loadTile !== 'function') return false;
    this.restoreDemBordersFromCache(cache);
    const fixedCover = { coveringTiles: () => tileIds, updateElevation: () => {} };
    cache._loadTile = (tile, callback) =>
      loadTile.call(cache, tile, (error) => {
        this.adoptPreloadedTile(cache, tile);
        callback(error);
      });
    try {
      cache._preloadTiles([fixedCover], () => {});
    } catch {
      return false;
    } finally {
      delete cache._loadTile;
    }
    return true;
  }

  private adoptPreloadedTile(cache: SourceCacheLike, tile: TileLike): void {
    const id = tile.tileID;
    const keep = !this.destroyed && tile.state === 'loaded' && cache._cache && !cache._tiles?.[id.key] && !cache._cache.has(id);
    try {
      if (keep) cache._cache?.add(id, tile, tile.getExpiryTimeout?.());
      else if (tile.state === 'loaded') cache._unloadTile?.(tile);
    } catch {
      /* source retirée */
    }
  }

  /**
   * Une tuile de relief reprise du cache n'est pas raccordée à ses voisines
   * (Mapbox ne le fait qu'au chargement) : raccord refait à la reprise, sinon
   * fissures entre tuiles préchargées.
   */
  private restoreDemBordersFromCache(cache: SourceCacheLike): void {
    const addTile = cache._addTile;
    if (cache._source?.type !== 'raster-dem' || typeof addTile !== 'function' || Object.prototype.hasOwnProperty.call(cache, '_addTile')) {
      return;
    }
    cache._addTile = (id) => {
      const fromCache = !cache._tiles?.[id.key] && Boolean(cache._cache?.has(id));
      const tile = addTile.call(cache, id);
      if (fromCache && tile?.dem && tile.state === 'loaded') cache._backfillDEM?.(tile);
      return tile;
    };
  }

  /** Repli : les mêmes URL que la carte, par `fetch`, pour remplir les caches HTTP et du Service Worker. */
  private warmHttpCache(cache: SourceCacheLike, tileIds: TileIdLike[]): void {
    const requests = this.internals._requestManager;
    const source = cache._source;
    if (!requests || !source?.tiles?.length) return;
    for (const id of tileIds) {
      try {
        const raw = id.canonical.url(source.tiles, source.scheme);
        const url =
          source.type === 'vector'
            ? requests.normalizeTileURL(raw)
            : requests.normalizeTileURL(raw, source.type === 'raster' && this.pixelRatio >= 2, source.tileSize);
        if (this.preloadQueue.length < PRELOAD_QUEUE_MAX) this.preloadQueue.push(requests.transformRequest(url, 'Tile'));
      } catch {
        /* URL non constructible : la carte la chargera elle-même */
      }
    }
  }

  private pumpPreloads(concurrency = PRELOAD_CONCURRENCY): void {
    while (!this.destroyed && this.preloadInFlight < concurrency && this.preloadQueue.length > 0) {
      const request = this.preloadQueue.shift() as (typeof this.preloadQueue)[number];
      this.preloadInFlight += 1;
      fetch(request.url, { credentials: request.credentials ?? 'same-origin', headers: request.headers })
        .then((response) => (response.ok ? response.arrayBuffer() : null))
        .catch(() => null)
        .finally(() => {
          this.preloadInFlight -= 1;
          this.pumpPreloads(concurrency);
        });
    }
  }

  private transformFor(camera: VideoCamera): TransformLike | null {
    try {
      const tr = this.internals.transform.clone();
      if (camera.kind === 'view') {
        const view = camera.view;
        tr.zoom = view.zoom;
        tr.center = new mapboxgl.LngLat(lngFromMercatorX(view.x), latFromMercatorY(view.y));
        tr.pitch = view.pitchDeg;
        tr.bearing = view.bearingDeg;
        return tr;
      }
      const pose = camera.pose;
      const options = this.map.getFreeCameraOptions();
      options.position = new mapboxgl.MercatorCoordinate(pose.x, pose.y, pose.altitudeM / metersPerMercatorUnitAtY(pose.y));
      options.setPitchBearing(Math.min(84.9, Math.max(0, pose.pitchDeg)), pose.bearingDeg);
      tr.setFreeCameraOptions(options);
      return tr;
    } catch {
      return null;
    }
  }

  /* ── Tuiles provisoires du Service Worker ─────────────────────────── */

  /**
   * Comme la carte vivante (useMap/controller/listeners.ts) : une tuile de
   * pente ou d'altitude servie provisoire est rechargée — sinon la vidéo
   * garderait le provisoire jusqu'au bout. Les tuiles du relief ne le sont
   * pas : le préchargement les fait construire avant que la caméra arrive, et
   * recharger une tuile de relief en place pouvait la laisser « reloading »
   * pour toujours (image jamais complète).
   */
  private readonly handleWorkerMessage = (event: MessageEvent) => {
    const type = (event.data as { type?: unknown } | null)?.type;
    if (type === 'SLOPE_TILES_STALE' || type === 'SLOPE_ZONE_HD_READY' || type === 'SLOPE_ZONE_PHASE1_READY') {
      this.scheduleReload('slope-tiles');
    } else if (type === 'SLOPE_TILE_UPDATED' && !(event.data as { zone?: unknown }).zone) {
      this.scheduleReload('slope-tiles');
    } else if (type === 'ALTITUDE_TILES_STALE') {
      this.scheduleReload('altitude-tiles');
    }
  };

  private scheduleReload(sourceId: string): void {
    this.pendingReloads.add(sourceId);
    if (this.reloadTimer) return;
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = 0;
      const ids = [...this.pendingReloads];
      this.pendingReloads.clear();
      const caches = this.sourceCaches();
      if (!caches || this.destroyed) return;
      withDevicePixelRatio(this.pixelRatio, () => {
        for (const [key, cache] of Object.entries(caches)) {
          if (!ids.some((id) => key === id || key.endsWith(`:${id}`))) continue;
          try {
            cache.reload?.();
          } catch {
            /* source retirée */
          }
        }
      });
      this.wake();
    }, 300);
  }

  private sourceCaches(): Record<string, SourceCacheLike> | null {
    const style = this.internals.style;
    return style?._mergedSourceCaches ?? style?._sourceCaches ?? null;
  }

  /* ── Lecture pour le directeur et l'habillage ─────────────────────── */

  directorMap(): DirectorMap {
    const map = this.map;
    const viewport = { width: this.width, height: this.height };
    const exaggeration = readTerrainExaggeration(map);
    const ground = createGroundSampler(map, exaggeration > 0);
    return {
      viewport,
      ground,
      exaggeration,
      overviewView: (bearingDeg) => this.overviewView(bearingDeg),
      currentView: () => {
        const center = map.getCenter();
        return {
          x: mercatorXFromLng(center.lng),
          y: mercatorYFromLat(center.lat),
          zoom: map.getZoom(),
          pitchDeg: map.getPitch(),
          bearingDeg: map.getBearing(),
        };
      },
      currentPose: (out: CameraPose) => readCameraPose(map, out),
    };
  }

  private overviewView(bearingDeg: number): MapView | null {
    const bounds = this.boundsOfRoute();
    if (!bounds) return null;
    const padding = Math.round(OVERVIEW_PADDING_RATIO * Math.min(this.width, this.height));
    try {
      const camera = this.map.cameraForBounds(bounds, { padding, bearing: bearingDeg, pitch: OVERVIEW_PITCH_DEG });
      const center = camera?.center;
      if (!camera || center == null || !Number.isFinite(camera.zoom)) return null;
      const lngLat = mapboxgl.LngLat.convert(center as mapboxgl.LngLatLike);
      return {
        x: mercatorXFromLng(lngLat.lng),
        y: mercatorYFromLat(lngLat.lat),
        zoom: camera.zoom as number,
        pitchDeg: OVERVIEW_PITCH_DEG,
        bearingDeg,
      };
    } catch {
      return null;
    }
  }

  private boundsOfRoute(): [[number, number], [number, number]] | null {
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const point of this.route.points) {
      if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat)) continue;
      minLng = Math.min(minLng, point.lon);
      maxLng = Math.max(maxLng, point.lon);
      minLat = Math.min(minLat, point.lat);
      maxLat = Math.max(maxLat, point.lat);
    }
    return Number.isFinite(minLng) ? [[minLng, minLat], [maxLng, maxLat]] : null;
  }

  /** Attributions des sources, comme le contrôle de la carte (« © Mapbox © OpenStreetMap… »). */
  attributionText(): string {
    const inner = this.container.querySelector('.mapboxgl-ctrl-attrib-inner');
    let text = '';
    if (inner) {
      const copy = inner.cloneNode(true) as Element;
      copy.querySelectorAll('.mapbox-improve-map').forEach((node) => node.remove());
      text = copy.textContent ?? '';
    }
    return (text.trim() || '© Mapbox © OpenStreetMap').replace(/\s+/g, ' ');
  }

  /** Logo Mapbox du contrôle de la carte (data: URI de la feuille de style). */
  logoUrl(): string | null {
    const logo = this.container.querySelector('.mapboxgl-ctrl-logo');
    if (!logo) return null;
    const background = window.getComputedStyle(logo).backgroundImage;
    const match = /url\(["']?(.*?)["']?\)$/.exec(background ?? '');
    return match?.[1] ?? null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    navigator.serviceWorker?.removeEventListener('message', this.handleWorkerMessage);
    if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
    this.wake();
    try {
      this.map.off('styleimagemissing', this.copyMissingImage);
      this.map.off('webglcontextlost', this.handleContextLost);
      this.map.remove();
    } catch {
      /* déjà détruite */
    }
    this.container.remove();
  }
}
