import { useEffect, useRef, useState, type RefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import {
  DEFAULT_VIEW,
  MAPBOX_STYLE,
  MAPBOX_TOKEN,
} from '../../lib/mapbox.config';
import { loadViewport, type MapViewport } from '../../lib/viewport-persist';
import { installCssZoomAwareMapSizing } from '../../lib/mapContainerZoom';
import { installStyleLessMapGuards } from '../../lib/styleLessMapGuards';
import { transformMapboxRequest } from '../../lib/satelliteTiles';
import { TerrainManager } from '../../lib/terrain';
import { createMapLifecycleController } from './controller';
import { styleHasUsableContent } from './controller/styleContent';
import { clearVisibleTimer, setVisibleTimeout, type VisibleTimer } from './controller/visibleClock';
import { applyRuntimeProfileDpr, getMapRuntimeProfile } from './runtimeProfile';
import type { UseMapOptions } from './types';
import {
  createEmptyBootstrapStyle,
  resolveStyleInput,
  resolveStyleInputSync,
  shouldPrefetchMapboxStyle,
  type MapboxStyleDefinition,
} from './stylePrefetch';
import { setupMapSubscriptions } from './useMapSubscriptions';

mapboxgl.accessToken = MAPBOX_TOKEN;

// Les tuiles DEM du terrain, satellite, ortho IGN, pente, altitude et météo
// passent toutes par UNE file d'images FIFO (16 par défaut). Les tuiles du
// Service Worker qui attendent une construction de DEM gardent leur créneau
// pendant ce temps : avec des overlays actifs, les requêtes DEM du terrain
// lui-même attendaient derrière elles. Les requêtes servies par le SW n'ouvrent
// aucune connexion et les hôtes externes sont en HTTP/2 : une file plus large ne
// coûte rien côté réseau.
mapboxgl.maxParallelImageRequests = 32;

// La carte vit dans le canvas du dashboard, mis à l'échelle par le `zoom` CSS
// (appScale) : Mapbox doit se dimensionner en px de mise en page du canvas
// (lib/mapContainerZoom.ts).
installCssZoomAwareMapSizing();
// Style jamais chargé (api.mapbox.com injoignable, jeton refusé) : getSource/getLayer
// renvoient undefined au lieu de lever (lib/styleLessMapGuards.ts).
installStyleLessMapGuards();

// Demande l'état d'horloge maximal au pilote graphique Windows D3D11 / AMD pour les APU
const supportCheck = mapboxgl.supported as typeof mapboxgl.supported & { webGLContextAttributes?: WebGLContextAttributes };
if (supportCheck.webGLContextAttributes) {
  supportCheck.webGLContextAttributes.powerPreference = 'high-performance';
}

const DEFAULT_BASEMAP_CONFIG = {
  styleUrl: MAPBOX_STYLE,
  visualFamily: 'mapbox-classic-v12',
  terrainContract: 'unified-dem-v1',
  lightPreset: undefined,
} as const;

/**
 * Hook principal gérant le cycle de vie, le moteur 3D, le style et les bus de données de la carte Mapbox GL.
 */
function sameMapViewport(a: MapViewport, b: MapViewport): boolean {
  return a.center[0] === b.center[0]
    && a.center[1] === b.center[1]
    && a.zoom === b.zoom
    && a.pitch === b.pitch
    && a.bearing === b.bearing;
}

export function useMap(
  containerRef: RefObject<HTMLDivElement | null>,
  options: UseMapOptions = {},
) {
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const terrainRef = useRef<TerrainManager | null>(null);
  const lifecycleRef = useRef<ReturnType<typeof createMapLifecycleController> | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const {
    initialViewport = null,
    onViewportChange,
    onLoadStatusChange,
    registerReload,
    basemapConfig = DEFAULT_BASEMAP_CONFIG,
  } = options;
  const onViewportChangeRef = useRef(onViewportChange);
  const onLoadStatusChangeRef = useRef(onLoadStatusChange);
  const registerReloadRef = useRef(registerReload);
  const activeBasemapConfigRef = useRef(basemapConfig);
  const prepareStyleChangeRef = useRef<((detail?: string) => void) | null>(null);
  const bootstrapStyleRef = useRef<(() => Promise<boolean>) | null>(null);

  /**
   * Dernière vue enregistrée par la carte elle-même (500 ms après un `moveend`).
   * Elle revient en `initialViewport` : cet écho n'est pas une demande de
   * déplacement. Sans ce repère, un vol de caméra lancé dans ces 500 ms
   * (liste de commentaires, recherche…) était ramené à la vue enregistrée.
   */
  const emittedViewportRef = useRef<MapViewport | null>(null);
  useEffect(() => {
    onViewportChangeRef.current = (viewport: MapViewport) => {
      emittedViewportRef.current = viewport;
      onViewportChange?.(viewport);
    };
  }, [onViewportChange]);

  useEffect(() => {
    onLoadStatusChangeRef.current = onLoadStatusChange;
  }, [onLoadStatusChange]);

  useEffect(() => {
    registerReloadRef.current = registerReload;
  }, [registerReload]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    let cancelled = false;
    const savedVp = initialViewport ?? loadViewport();
    const runtimeProfile = getMapRuntimeProfile();
    applyRuntimeProfileDpr(runtimeProfile);
    const shouldHydrateInitialStyle = shouldPrefetchMapboxStyle(basemapConfig.styleUrl);

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: createEmptyBootstrapStyle() as ConstructorParameters<typeof mapboxgl.Map>[0]['style'],
      center: savedVp?.center ?? DEFAULT_VIEW.center,
      zoom: savedVp?.zoom ?? DEFAULT_VIEW.zoom,
      pitch: savedVp?.pitch ?? DEFAULT_VIEW.pitch,
      bearing: savedVp?.bearing ?? DEFAULT_VIEW.bearing,
      projection: DEFAULT_VIEW.projection,
      antialias: runtimeProfile.antialias,
      // false : évite une copie plein écran du tampon arrière à chaque image
      // (coût majeur sur les GPU Apple TBDR / ANGLE-Metal et les iGPU). Les
      // lecteurs du canvas (MapBlurMirror, mapThumbnail) copient plutôt de façon
      // synchrone dans l'événement `render`.
      preserveDrawingBuffer: false,
      performanceMetricsCollection: false,
      fadeDuration: 0,
      maxTileCacheSize: runtimeProfile.maxTileCacheSize,
      minTileCacheSize: runtimeProfile.minTileCacheSize,
      transformRequest: transformMapboxRequest,
    } as mapboxgl.MapOptions);

    mapRef.current = map;

    // Pendant que la caméra bouge, chaque `backdrop-filter` au-dessus du canvas
    // WebGL est reflouté à chaque image de la carte (gros noyaux en résolution
    // Retina, principale source d'à-coups sur Safari / macOS et sur les iGPU).
    // `index.css` retire le flou d'arrière-plan tant que cet indicateur est
    // posé ; il est rétabli peu après la fin du mouvement.
    const rootEl = document.documentElement;
    let movingFlagTimer: ReturnType<typeof setTimeout> | null = null;
    const handleCameraMoveStart = () => {
      if (movingFlagTimer) {
        clearTimeout(movingFlagTimer);
        movingFlagTimer = null;
      }
      rootEl.setAttribute('data-rv-map-moving', '');
    };
    const handleCameraMoveEnd = () => {
      if (movingFlagTimer) clearTimeout(movingFlagTimer);
      movingFlagTimer = setTimeout(() => {
        movingFlagTimer = null;
        rootEl.removeAttribute('data-rv-map-moving');
      }, 160);
    };
    map.on('movestart', handleCameraMoveStart);
    map.on('moveend', handleCameraMoveEnd);

    const lifecycle = createMapLifecycleController({
      map,
      runtimeProfile,
      terrainRef,
      onLoadStatusChangeRef,
      registerReloadRef,
      getActiveStyleUrl: () => activeBasemapConfigRef.current.styleUrl,
      getActiveVisualFamily: () => activeBasemapConfigRef.current.visualFamily,
      getActiveTerrainContract: () => activeBasemapConfigRef.current.terrainContract,
      getActiveLightPreset: () => activeBasemapConfigRef.current.lightPreset,
      isCancelled: () => cancelled,
    });
    lifecycleRef.current = lifecycle;
    lifecycle.reportStatus('loading', 6, 'Initialisation');
    lifecycle.reportStatus('loading', 14, 'Moteur 3D');
    registerReloadRef.current?.(lifecycle.reloadMapElevation);

    const subscriptions = setupMapSubscriptions({
      map,
      containerRef,
      lifecycle,
      onViewportChangeRef,
    });

    prepareStyleChangeRef.current = lifecycle.prepareStyleChange;
    bootstrapStyleRef.current = lifecycle.bootstrapCurrentStyle;

    const revealMap = () => {
      if (cancelled) return;
      try {
        if (!styleHasUsableContent(map.getStyle())) return;
      } catch {
        return;
      }
      setIsLoaded(true);
    };

    let revealFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const revealSignals = ['style.load', 'styledata', 'idle'] as const;
    const armInitialReveal = () => {
      for (const eventName of revealSignals) map.on(eventName, revealMap);
      revealFallbackTimer = setTimeout(revealMap, 8000);
    };
    const disarmInitialReveal = () => {
      for (const eventName of revealSignals) map.off(eventName, revealMap);
      if (revealFallbackTimer) {
        clearTimeout(revealFallbackTimer);
        revealFallbackTimer = null;
      }
    };

    const attemptInitBootstrap = (): Promise<void> =>
      lifecycle.bootstrapCurrentStyle()
        .then((bootstrapped) => {
          if (!bootstrapped || cancelled) return;
          setIsLoaded(true);
        })
        .catch((error) => {
          console.error('[map3d] init failed', error);
          lifecycle.reportStatus('error', 0, error instanceof Error ? error.message : 'Chargement impossible');
          if (!cancelled) setIsLoaded(true);
        });

    // Réessaie une fois le setStyle initial si Mapbox ne l'a pas analysé après
    // 4 s de temps visible (un style par URL dont la requête a échoué). Armé
    // après le setStyle, jamais pendant le préchargement (il s'y déclenchait sur
    // une liaison lente et entrait en course avec un second setStyle), et sur
    // l'horloge visible : une page masquée n'analyse aucun style
    // (`Style#loadJSON` attend une image).
    const STUCK_SHELL_WATCHDOG_MS = 4000;
    let stuckShellTimer: VisibleTimer | null = null;
    const armStuckShellWatchdog = () => {
      clearVisibleTimer(stuckShellTimer);
      stuckShellTimer = setVisibleTimeout(() => {
        stuckShellTimer = null;
        if (cancelled) return;
        let hasContent = false;
        try {
          hasContent = styleHasUsableContent(map.getStyle());
        } catch { /* getStyle a levé une exception */ }
        if (hasContent) return;
        console.warn(
          `[map3d] style not parsed after ${STUCK_SHELL_WATCHDOG_MS} ms of visible time — retrying setStyle`,
        );
        try {
          lifecycle.prepareStyleChange('Fond de carte (récupération)');
          map.setStyle(resolveStyleInputSync(activeBasemapConfigRef.current.styleUrl) as Parameters<typeof map.setStyle>[0], {
            diff: false,
            localFontFamily: null,
            localIdeographFontFamily: 'sans-serif',
          });
          void attemptInitBootstrap();
        } catch (error) {
          console.error('[map3d] stuck-shell recovery setStyle failed', error);
        }
      }, STUCK_SHELL_WATCHDOG_MS);
    };

    const startInitialStyleAndBootstrap = async (): Promise<void> => {
      let styleInput: string | MapboxStyleDefinition;
      if (shouldHydrateInitialStyle) {
        styleInput = await resolveStyleInput(basemapConfig.styleUrl);
        if (cancelled) return;
        // Un changement de fond est arrivé pendant le préchargement : il a déjà
        // posé son propre style et le démarre.
        if (activeBasemapConfigRef.current !== basemapConfig) return;
      } else {
        styleInput = basemapConfig.styleUrl;
      }
      lifecycle.prepareStyleChange('Fond de carte');
      armInitialReveal();
      try {
        map.setStyle(styleInput as Parameters<typeof map.setStyle>[0], {
          diff: false,
          localFontFamily: null,
          localIdeographFontFamily: 'sans-serif',
        });
      } catch (error) {
        console.error('[map3d] initial setStyle failed', error);
        lifecycle.reportStatus(
          'error',
          0,
          error instanceof Error ? error.message : 'Chargement du fond de carte impossible',
        );
        if (!cancelled) setIsLoaded(true);
        return;
      }

      armStuckShellWatchdog();
      void attemptInitBootstrap();
    };

    void startInitialStyleAndBootstrap();

    return () => {
      cancelled = true;
      map.off('movestart', handleCameraMoveStart);
      map.off('moveend', handleCameraMoveEnd);
      if (movingFlagTimer) clearTimeout(movingFlagTimer);
      rootEl.removeAttribute('data-rv-map-moving');
      disarmInitialReveal();
      clearVisibleTimer(stuckShellTimer);
      subscriptions.cleanup();
      lifecycle.cleanup();
      subscriptions.persistCurrentViewport();
      terrainRef.current?.destroy();
      terrainRef.current = null;
      map.remove();
      mapRef.current = null;
      lifecycleRef.current = null;
      prepareStyleChangeRef.current = null;
      bootstrapStyleRef.current = null;
      registerReloadRef.current?.(null);
      onLoadStatusChangeRef.current?.(null);
    };
  }, [containerRef]);

  useEffect(() => {
    const map = mapRef.current;
    const lifecycle = lifecycleRef.current;
    const prepareStyleChange = prepareStyleChangeRef.current;
    const bootstrapCurrentStyle = bootstrapStyleRef.current;
    if (!map || !lifecycle || !prepareStyleChange || !bootstrapCurrentStyle) return;
    const activeConfig = activeBasemapConfigRef.current;
    if (
      basemapConfig.styleUrl === activeConfig.styleUrl
      && basemapConfig.visualFamily === activeConfig.visualFamily
      && basemapConfig.terrainContract === activeConfig.terrainContract
      && basemapConfig.lightPreset === activeConfig.lightPreset
    ) {
      return;
    }

    let switchCancelled = false;
    const revealAfterSwitch = () => {
      if (switchCancelled) return;
      try {
        if (!styleHasUsableContent(map.getStyle())) return;
      } catch {
        return;
      }
      setIsLoaded(true);
    };
    let switchFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const switchRevealSignals = ['style.load', 'styledata', 'idle'] as const;
    const armSwitchReveal = () => {
      for (const eventName of switchRevealSignals) map.on(eventName, revealAfterSwitch);
      switchFallbackTimer = setTimeout(revealAfterSwitch, 8000);
    };
    const disarmSwitchReveal = () => {
      for (const eventName of switchRevealSignals) map.off(eventName, revealAfterSwitch);
      if (switchFallbackTimer) {
        clearTimeout(switchFallbackTimer);
        switchFallbackTimer = null;
      }
    };

    const attemptBootstrap = (): Promise<void> =>
      bootstrapCurrentStyle()
        .then((bootstrapped) => {
          if (!bootstrapped || switchCancelled) return;
          setIsLoaded(true);
        })
        .catch((error) => {
          console.error('[map3d] style switch failed', error);
          lifecycle.reportStatus(
            'error',
            0,
            error instanceof Error ? error.message : 'Changement de fond de carte impossible',
          );
          setIsLoaded(true);
        });

    const startStyleSwitch = async (): Promise<void> => {
      const previousConfig = activeConfig;
      let styleInput: string | MapboxStyleDefinition;
      try {
        styleInput = await resolveStyleInput(basemapConfig.styleUrl);
      } catch (error) {
        if (switchCancelled) return;
        console.error('[map3d] style switch prefetch failed', error);
        activeBasemapConfigRef.current = previousConfig;
        lifecycle.reportStatus(
          'error',
          0,
          error instanceof Error ? error.message : 'Chargement du fond de carte impossible',
        );
        setIsLoaded(true);
        return;
      }
      if (switchCancelled) return;

      activeBasemapConfigRef.current = basemapConfig;
      setIsLoaded(false);
      prepareStyleChange('Fond de carte');
      armSwitchReveal();

      try {
        map.setStyle(styleInput as Parameters<typeof map.setStyle>[0], {
          diff: false,
          localFontFamily: null,
          localIdeographFontFamily: 'sans-serif',
        });
      } catch (error) {
        if (switchCancelled) return;
        console.error('[map3d] setStyle failed', error);
        activeBasemapConfigRef.current = previousConfig;
        lifecycle.reportStatus(
          'error',
          0,
          error instanceof Error ? error.message : 'Changement de fond de carte impossible',
        );
        setIsLoaded(true);
        return;
      }

      void attemptBootstrap();
    };

    void startStyleSwitch();

    return () => {
      switchCancelled = true;
      disarmSwitchReveal();
    };
  }, [basemapConfig]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !initialViewport) return;
    if (emittedViewportRef.current && sameMapViewport(emittedViewportRef.current, initialViewport)) return;

    const center = map.getCenter();
    const sameViewport =
      Math.abs(center.lng - initialViewport.center[0]) < 1e-7
      && Math.abs(center.lat - initialViewport.center[1]) < 1e-7
      && Math.abs(map.getZoom() - initialViewport.zoom) < 1e-7
      && Math.abs(map.getPitch() - initialViewport.pitch) < 1e-7
      && Math.abs(map.getBearing() - initialViewport.bearing) < 1e-7;
    if (sameViewport) return;

    map.jumpTo({
      center: initialViewport.center,
      zoom: initialViewport.zoom,
      pitch: initialViewport.pitch,
      bearing: initialViewport.bearing,
    });
  }, [initialViewport]);

  return { map: mapRef, isLoaded };
}

export type { UseMapOptions } from './types';
