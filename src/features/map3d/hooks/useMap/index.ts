import { useEffect, useRef, useState, type RefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import {
  DEFAULT_VIEW,
  FOG_CONFIG,
  MAPBOX_STYLE,
  MAPBOX_TOKEN,
} from '../../lib/mapbox.config';
import { loadViewport, saveViewport, type MapViewport } from '../../lib/viewport-persist';
import { TerrainManager } from '../../lib/terrain';
import { createMapLifecycleController } from './controller';
import { getMapRuntimeProfile } from './runtimeProfile';
import type { UseMapOptions } from './types';

mapboxgl.accessToken = MAPBOX_TOKEN;

type MapboxStyleDefinition = Record<string, unknown>;

const prefetchedStyleCache = new Map<string, MapboxStyleDefinition>();

function getMapboxStyleApiUrl(styleUrl: string): string | null {
  const prefix = 'mapbox://styles/';
  if (!styleUrl.startsWith(prefix)) return null;
  const stylePath = styleUrl.slice(prefix.length);
  return `https://api.mapbox.com/styles/v1/${stylePath}?access_token=${encodeURIComponent(MAPBOX_TOKEN)}`;
}

function cloneStyleDefinition(style: MapboxStyleDefinition): MapboxStyleDefinition {
  return JSON.parse(JSON.stringify(style)) as MapboxStyleDefinition;
}

async function fetchMapboxStyleDefinition(styleUrl: string): Promise<MapboxStyleDefinition> {
  const cached = prefetchedStyleCache.get(styleUrl);
  if (cached) return cloneStyleDefinition(cached);

  const apiUrl = getMapboxStyleApiUrl(styleUrl);
  if (!apiUrl) throw new Error(`Unsupported style URL: ${styleUrl}`);

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(apiUrl, {
        signal: controller.signal,
        credentials: 'omit',
        cache: attempt === 0 ? 'default' : 'reload',
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} while fetching style ${styleUrl}`);
      }
      const style = (await response.json()) as MapboxStyleDefinition;
      prefetchedStyleCache.set(styleUrl, style);
      return cloneStyleDefinition(style);
    } catch (error) {
      lastError = error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to fetch style ${styleUrl}`);
}

async function resolveStyleInput(styleUrl: string): Promise<string | MapboxStyleDefinition> {
  return getMapboxStyleApiUrl(styleUrl)
    ? fetchMapboxStyleDefinition(styleUrl)
    : styleUrl;
}

const DEFAULT_BASEMAP_CONFIG = {
  styleUrl: MAPBOX_STYLE,
  visualFamily: 'mapbox-classic-v12',
  terrainContract: 'unified-dem-v1',
} as const;

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
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: basemapConfig.styleUrl,
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
      isCancelled: () => cancelled,
    });
    lifecycleRef.current = lifecycle;
    lifecycle.reportStatus('loading', 6, 'Initialisation');
    lifecycle.reportStatus('loading', 14, 'Moteur 3D');
    registerReloadRef.current?.(lifecycle.reloadMapElevation);

    prepareStyleChangeRef.current = lifecycle.prepareStyleChange;
    bootstrapStyleRef.current = lifecycle.bootstrapCurrentStyle;

    // Reveal the map as soon as Mapbox emits any of these signals.
    // Decoupled from `bootstrapCurrentStyle()` because that promise can
    // stall when the watchdog falls back to its deferred path (style
    // sprite/image rejection storms keep `isStyleLoaded()` false past
    // 15s and the late-style listener may never re-fire on some
    // basemap variants). The map is visually usable long before the
    // bootstrap fully wires DEM/terrain — keeping the "Chargement du
    // globe…" overlay until the bootstrap promise resolves was the
    // visible bug ("3D visible mais loader bloqué à 30%").
    const revealMap = () => {
      if (cancelled) return;
      setIsLoaded(true);
    };
    map.once('load', revealMap);
    map.once('idle', revealMap);
    // Hard fallback: if neither `load` nor `idle` fired within 8s, the
    // map is almost certainly already rendering tiles (Mapbox keeps
    // those events suppressed when sprite/image errors loop). Reveal
    // anyway so the user isn't stuck behind the overlay forever.
    const revealFallbackTimer = setTimeout(revealMap, 8000);

    // Single-shot bootstrap. The bootstrap promise now waits on real
    // Mapbox readiness signals (style.load / styledata-with-content /
    // sourcedata / first idle) and, on the SW path, falls through to
    // the AWS Terrarium fallback when the SW controller hasn't claimed
    // yet — that fallback already arms a `swLateReady` listener which
    // auto-upgrades to IGN MNS as soon as the controller appears, with
    // no parallel bootstrap race. Retrying here would fire a second
    // bootstrap against the same map (the source of the previous
    // "[map3d] initial bootstrap returned false, retrying" log spam +
    // permanent flat terrain).
    const attemptInitBootstrap = (): Promise<void> =>
      lifecycle.bootstrapCurrentStyle()
        .then(() => {
          if (!cancelled) setIsLoaded(true);
        })
        .catch((error) => {
          console.error('[map3d] init failed', error);
          lifecycle.reportStatus('error', 0, error instanceof Error ? error.message : 'Chargement impossible');
          if (!cancelled) setIsLoaded(true);
        });

    void attemptInitBootstrap();

    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const persistViewport = (viewport: MapViewport) => {
      saveViewport(viewport);
      onViewportChangeRef.current?.(viewport);
    };
    const onMoveEnd = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const center = map.getCenter();
        persistViewport({
          center: [center.lng, center.lat],
          zoom: map.getZoom(),
          pitch: map.getPitch(),
          bearing: map.getBearing(),
        });
      }, 500);
    };
    map.on('moveend', onMoveEnd);

    let lastSvgWarnAt = 0;
    let suppressedSvgErrors = 0;
    map.on('error', (event) => {
      const message = event.error?.message || String(event);
      // Mapbox 3.x explicitly rejects SVG assets referenced by the active
      // style/sprite. Some basemap variants keep retrying the failing image
      // every frame, which floods the console (and can stall the style
      // bootstrap). Rate-limit the log so a single failing asset doesn't
      // drown real diagnostics.
      if (message.includes('SVGs are not supported')) {
        const now = Date.now();
        if (now - lastSvgWarnAt < 5000) {
          suppressedSvgErrors += 1;
          return;
        }
        const skipped = suppressedSvgErrors;
        suppressedSvgErrors = 0;
        lastSvgWarnAt = now;
        console.warn(
          '[mapbox] image rejected (SVG not supported by Mapbox 3.x); further occurrences suppressed for 5s',
          skipped > 0 ? `(${skipped} suppressed)` : '',
        );
        return;
      }
      console.error('[mapbox]', message);
    });

    return () => {
      cancelled = true;
      clearTimeout(revealFallbackTimer);
      lifecycle.cleanup();
      if (saveTimer) clearTimeout(saveTimer);
      if (mapRef.current) {
        const center = mapRef.current.getCenter();
        persistViewport({
          center: [center.lng, center.lat],
          zoom: mapRef.current.getZoom(),
          pitch: mapRef.current.getPitch(),
          bearing: mapRef.current.getBearing(),
        });
      }
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
    ) {
      return;
    }

    let switchCancelled = false;
    const revealAfterSwitch = () => {
      if (switchCancelled) return;
      setIsLoaded(true);
    };
    let switchFallbackTimer: ReturnType<typeof setTimeout> | null = null;

    // Single-shot bootstrap. The bootstrap promise itself now waits on
    // real Mapbox readiness signals (style.load / styledata-with-content
    // / sourcedata / first idle) and only returns false on cancellation
    // — there is no timing race left to retry around. Retry-on-false
    // would fire a parallel bootstrap against the same map and racing
    // setStyle calls, which is exactly what produced the
    // "[map3d] style switch bootstrap returned false, retrying"
    // log spam + permanent flat terrain seen on Standard-Satellite
    // switches.
    const attemptBootstrap = (): Promise<void> =>
      bootstrapCurrentStyle()
        .then(() => {
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

      // Reveal as soon as the new style yields any rendered output, with
      // a hard 8s fallback. Same rationale as the initial-mount path: the
      // bootstrap promise can stall under sprite/image error storms.
      map.once('load', revealAfterSwitch);
      map.once('idle', revealAfterSwitch);
      switchFallbackTimer = setTimeout(revealAfterSwitch, 8000);

      void attemptBootstrap();
    };

    void startStyleSwitch();

    return () => {
      switchCancelled = true;
      if (switchFallbackTimer) clearTimeout(switchFallbackTimer);
      map.off('load', revealAfterSwitch);
      map.off('idle', revealAfterSwitch);
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