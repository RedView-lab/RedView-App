import { useEffect, useRef, useState, type RefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import {
  DEFAULT_VIEW,
  FOG_CONFIG,
  MAPBOX_STYLE,
  MAPBOX_TOKEN,
} from '../../lib/mapbox.config';
import { loadViewport } from '../../lib/viewport-persist';
import { TerrainManager } from '../../lib/terrain';
import { createMapLifecycleController } from './controller';
import { styleHasUsableContent } from './controller/styleContent';
import { getMapRuntimeProfile } from './runtimeProfile';
import type { UseMapOptions } from './types';
import {
  createEmptyBootstrapStyle,
  resolveStyleInput,
  shouldPrefetchMapboxStyle,
  type MapboxStyleDefinition,
} from './stylePrefetch';
import { setupMapSubscriptions } from './useMapSubscriptions';

mapboxgl.accessToken = MAPBOX_TOKEN;

const DEFAULT_BASEMAP_CONFIG = {
  styleUrl: MAPBOX_STYLE,
  visualFamily: 'mapbox-classic-v12',
  terrainContract: 'unified-dem-v1',
  lightPreset: undefined,
} as const;

/**
 * Hook principal gérant le cycle de vie, le moteur 3D, le style et les bus de données de la carte Mapbox GL.
 */
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

  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
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
      preserveDrawingBuffer: true,
      maxTileCacheSize: runtimeProfile.maxTileCacheSize,
      minTileCacheSize: runtimeProfile.minTileCacheSize,
    });

    mapRef.current = map;

    const lifecycle = createMapLifecycleController({
      map,
      fogConfig: FOG_CONFIG as mapboxgl.FogSpecification,
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

    const STUCK_SHELL_WATCHDOG_MS = 4000;
    let stuckShellTimer: ReturnType<typeof setTimeout> | null = null;
    const armStuckShellWatchdog = () => {
      if (stuckShellTimer) clearTimeout(stuckShellTimer);
      stuckShellTimer = setTimeout(() => {
        stuckShellTimer = null;
        if (cancelled) return;
        let hasContent = false;
        try {
          hasContent = styleHasUsableContent(map.getStyle());
        } catch { /* getStyle threw */ }
        if (hasContent) return;
        console.warn(
          `[map3d] stuck on empty bootstrap shell after ${STUCK_SHELL_WATCHDOG_MS} ms — forcing direct setStyle from URL`,
        );
        try {
          lifecycle.prepareStyleChange('Fond de carte (recovery)');
          map.setStyle(basemapConfig.styleUrl as Parameters<typeof map.setStyle>[0], {
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
      armStuckShellWatchdog();
      let styleInput: string | MapboxStyleDefinition;
      if (shouldHydrateInitialStyle) {
        styleInput = await resolveStyleInput(basemapConfig.styleUrl);
        if (cancelled) return;
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

      void attemptInitBootstrap();
    };

    void startInitialStyleAndBootstrap();

    return () => {
      cancelled = true;
      disarmInitialReveal();
      if (stuckShellTimer) clearTimeout(stuckShellTimer);
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
