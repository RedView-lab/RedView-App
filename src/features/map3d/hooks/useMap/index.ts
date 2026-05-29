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
import { styleHasUsableContent } from './controller/styleContent';
import { getMapRuntimeProfile } from './runtimeProfile';
import type { UseMapOptions } from './types';
import {
  getActiveDem3dQuality,
  subscribeDem3dQuality,
} from '../../lib/dem3dQualityBus';
import {
  getActiveDemProfilePreference,
  subscribeDemProfilePreference,
} from '../../lib/demProfileBus';

mapboxgl.accessToken = MAPBOX_TOKEN;

type MapboxStyleDefinition = Record<string, unknown>;

const prefetchedStyleCache = new Map<string, MapboxStyleDefinition>();

function createEmptyBootstrapStyle(): MapboxStyleDefinition {
  return { version: 8, sources: {}, layers: [] };
}

function getMapboxStyleApiUrl(styleUrl: string): string | null {
  const prefix = 'mapbox://styles/';
  if (!styleUrl.startsWith(prefix)) return null;
  const stylePath = styleUrl.slice(prefix.length);
  return `https://api.mapbox.com/styles/v1/${stylePath}?access_token=${encodeURIComponent(MAPBOX_TOKEN)}`;
}

function cloneStyleDefinition(style: MapboxStyleDefinition): MapboxStyleDefinition {
  return JSON.parse(JSON.stringify(style)) as MapboxStyleDefinition;
}

function shouldPrefetchMapboxStyle(styleUrl: string): boolean {
  const apiUrl = getMapboxStyleApiUrl(styleUrl);
  if (!apiUrl) return false;
  // Mapbox Standard / Standard-Satellite are imported styles that can
  // settle without emitting a usable readiness event after a prefetched
  // object `setStyle()` call, especially on topo -> satellite switches.
  // Let Mapbox resolve those natively from the URL string instead.
  if (
    styleUrl === 'mapbox://styles/mapbox/standard'
    || styleUrl === 'mapbox://styles/mapbox/standard-satellite'
  ) {
    return false;
  }
  return true;
}

// Prefetch budget per attempt. Kept tight so a slow Mapbox CDN response
// (cold incognito session, no service-worker cache, no HTTP cache) never
// blocks the bootstrap longer than this — we fall back to letting Mapbox
// fetch the style natively from the URL string instead. Previous value
// (6 s × 2 attempts = up to 12 s) caused the visible bug where a slow
// cold prefetch left the map sitting on the empty bootstrap shell
// indefinitely whenever a React StrictMode unmount/remount cancelled the
// in-flight await before `setStyle()` could be applied.
const STYLE_PREFETCH_TIMEOUT_MS = 2500;

async function fetchMapboxStyleDefinition(styleUrl: string): Promise<MapboxStyleDefinition> {
  const cached = prefetchedStyleCache.get(styleUrl);
  if (cached) return cloneStyleDefinition(cached);

  const apiUrl = getMapboxStyleApiUrl(styleUrl);
  if (!apiUrl) throw new Error(`Unsupported style URL: ${styleUrl}`);

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), STYLE_PREFETCH_TIMEOUT_MS);
  try {
    const response = await fetch(apiUrl, {
      signal: controller.signal,
      credentials: 'omit',
      cache: 'default',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching style ${styleUrl}`);
    }
    const style = (await response.json()) as MapboxStyleDefinition;
    prefetchedStyleCache.set(styleUrl, style);
    return cloneStyleDefinition(style);
  } finally {
    window.clearTimeout(timeout);
  }
}

async function resolveStyleInput(styleUrl: string): Promise<string | MapboxStyleDefinition> {
  if (!shouldPrefetchMapboxStyle(styleUrl)) return styleUrl;
  try {
    return await fetchMapboxStyleDefinition(styleUrl);
  } catch (error) {
    // Never block the bootstrap on prefetch failure. Mapbox can resolve
    // `mapbox://` URLs natively; a string fallback always works.
    console.warn('[map3d] style prefetch failed, falling back to URL', error);
    return styleUrl;
  }
}

const DEFAULT_BASEMAP_CONFIG = {
  styleUrl: MAPBOX_STYLE,
  visualFamily: 'mapbox-classic-v12',
  terrainContract: 'unified-dem-v1',
  lightPreset: undefined,
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
    const shouldHydrateInitialStyle = shouldPrefetchMapboxStyle(basemapConfig.styleUrl);
    // Always construct with the empty bootstrap shell. The real basemap
    // style (prefetched JSON for topo, URL string for Standard /
    // Standard-Satellite) is applied via `map.setStyle(...)` below, AFTER
    // the lifecycle controller exists and `bootstrapCurrentStyle()` has
    // attached its readiness listeners. Passing the satellite URL
    // directly to the constructor used to start Mapbox's internal style
    // fetch at T=0 and — with a warm browser cache — fire
    // `style.load`/`styledata`/`sourcedata` BEFORE our listeners were
    // attached (they only register inside the async
    // `attemptInitBootstrap()` chain). The race left `spriteStormBypass`
    // unprimed, the unified-DEM lost the terrain slot to the satellite
    // import's builtin `mapbox-dem`, and the map rendered flat with no
    // `[map3d] styledata: … sprite-storm bypass` log ever appearing.
    // Forcing every basemap through the same shell + `setStyle()` path
    // guarantees listeners are armed before Mapbox can emit anything.
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

    // 3D quality bus: keep the lifecycle in sync with whatever the
    // ControlPanel selector publishes. Apply the current value once
    // (so a session that re-mounted with fast-30m already selected
    // re-binds the AWS source instead of the unified one), then
    // subscribe for live changes.
    if (getActiveDem3dQuality() === 'fast-30m') {
      try { lifecycle.setDem3dQuality('fast-30m'); } catch { /* best-effort */ }
    }
    const unsubscribeDem3dQuality = subscribeDem3dQuality((q) => {
      try { lifecycle.setDem3dQuality(q); } catch (err) {
        console.warn('[map3d] setDem3dQuality failed', err);
      }
    });
    const unsubscribeDemProfile = subscribeDemProfilePreference(() => {
      try {
        // Lightweight reload: keeps the SW DEM cache + cache-bust token
        // intact so a switch back to a previously viewed profile resolves
        // instantly from CacheStorage instead of re-fetching from IGN.
        lifecycle.reloadMapElevationForProfile();
      } catch (err) {
        console.warn('[map3d] reloadMapElevationForProfile after DEM profile change failed', err);
      }
    });
    if (getActiveDemProfilePreference() !== 'default') {
      try {
        lifecycle.reloadMapElevationForProfile();
      } catch {
        /* best-effort */
      }
    }

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
      // Hard fallback: if no usable style signal reaches us within 8s,
      // the map is almost certainly already rendering tiles (Mapbox can
      // suppress `style.load` / `idle` under sprite-image rejection
      // storms). Reveal anyway so the user isn't stuck behind the
      // overlay forever.
      revealFallbackTimer = setTimeout(revealMap, 8000);
    };
    const disarmInitialReveal = () => {
      for (const eventName of revealSignals) map.off(eventName, revealMap);
      if (revealFallbackTimer) {
        clearTimeout(revealFallbackTimer);
        revealFallbackTimer = null;
      }
    };

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
        .then((bootstrapped) => {
          if (!bootstrapped || cancelled) return;
          setIsLoaded(true);
        })
        .catch((error) => {
          console.error('[map3d] init failed', error);
          lifecycle.reportStatus('error', 0, error instanceof Error ? error.message : 'Chargement impossible');
          if (!cancelled) setIsLoaded(true);
        });

    // Stuck-shell watchdog. The map is created with an empty bootstrap
    // style ({version:8, sources:{}, layers:[]}) so we can prefetch the
    // real Mapbox style in parallel. If the real `setStyle()` never
    // applies (cold-cache prefetch race, cancelled await, network hiccup),
    // the map silently sits on that empty shell forever — no `[map3d]`
    // logs, weather-overlay watchdogs see `hasStyle:true, sourceCount:0`
    // and the user has to F5 manually. This watchdog detects that state
    // (no real style content after STUCK_SHELL_WATCHDOG_MS) and forces a
    // direct setStyle from the URL string, which Mapbox fetches itself
    // through the standard internal pipeline.
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
        } catch { /* getStyle threw — treat as stuck */ }
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
          // Re-trigger the bootstrap against the real style.
          void attemptInitBootstrap();
        } catch (error) {
          console.error('[map3d] stuck-shell recovery setStyle failed', error);
        }
      }, STUCK_SHELL_WATCHDOG_MS);
    };

    const startInitialStyleAndBootstrap = async (): Promise<void> => {
      // Arm recovery BEFORE we touch anything async so a stalled fetch
      // (prefetch HTTP for topo, native Mapbox style resolution for
      // satellite) can never strand the map on the empty bootstrap shell.
      armStuckShellWatchdog();
      let styleInput: string | MapboxStyleDefinition;
      if (shouldHydrateInitialStyle) {
        // resolveStyleInput now never throws — it falls back to the URL
        // string on any prefetch failure (timeout, network, parse).
        styleInput = await resolveStyleInput(basemapConfig.styleUrl);
        if (cancelled) return;
      } else {
        // Non-prefetched basemaps (Mapbox Standard / Standard-Satellite)
        // are passed as a URL string to `setStyle()`; Mapbox resolves
        // them natively without an extra HTTP round-trip. The setStyle
        // call still goes through the same `prepareStyleChange()` +
        // listener-attach sequence as the prefetched path, so satellite
        // cold-start no longer races Mapbox's internal style events.
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
      disarmInitialReveal();
      if (stuckShellTimer) clearTimeout(stuckShellTimer);
      unsubscribeDem3dQuality();
      unsubscribeDemProfile();
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
