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
    basemapStyleUrl = MAPBOX_STYLE,
  } = options;
  const onViewportChangeRef = useRef(onViewportChange);
  const onLoadStatusChangeRef = useRef(onLoadStatusChange);
  const registerReloadRef = useRef(registerReload);
  const activeStyleUrlRef = useRef(basemapStyleUrl);
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
      style: basemapStyleUrl,
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
      getActiveStyleUrl: () => activeStyleUrlRef.current,
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

    let mountRetries = 0;
    const MAX_MOUNT_RETRIES = 3;
    const attemptInitBootstrap = (): Promise<void> =>
      lifecycle.bootstrapCurrentStyle()
        .then((ok) => {
          if (!cancelled) setIsLoaded(true);
          if (!ok && !cancelled && mountRetries < MAX_MOUNT_RETRIES) {
            mountRetries += 1;
            console.warn(`[map3d] initial bootstrap returned false, retrying (${mountRetries}/${MAX_MOUNT_RETRIES})`);
            setTimeout(() => {
              if (!cancelled) void attemptInitBootstrap();
            }, 3000);
          }
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
    if (basemapStyleUrl === activeStyleUrlRef.current) return;

    activeStyleUrlRef.current = basemapStyleUrl;
    setIsLoaded(false);
    prepareStyleChange('Fond de carte');
    map.setStyle(basemapStyleUrl, {
      diff: false,
      localFontFamily: null,
      localIdeographFontFamily: 'sans-serif',
    });

    // Reveal as soon as the new style yields any rendered output, with
    // a hard 8s fallback. Same rationale as the initial-mount path: the
    // bootstrap promise can stall under sprite/image error storms.
    let switchCancelled = false;
    const revealAfterSwitch = () => {
      if (switchCancelled) return;
      setIsLoaded(true);
    };
    map.once('load', revealAfterSwitch);
    map.once('idle', revealAfterSwitch);
    const switchFallbackTimer = setTimeout(revealAfterSwitch, 8000);

    let switchRetries = 0;
    const MAX_SWITCH_RETRIES = 3;
    const attemptBootstrap = (): Promise<void> =>
      bootstrapCurrentStyle()
        .then((ok) => {
          setIsLoaded(true);
          // If bootstrap returned false (style not ready, went through
          // polling path), retry after a short delay — don't leave the
          // map flat forever.
          if (!ok && !switchCancelled && switchRetries < MAX_SWITCH_RETRIES) {
            switchRetries += 1;
            console.warn(`[map3d] style switch bootstrap returned false, retrying (${switchRetries}/${MAX_SWITCH_RETRIES})`);
            setTimeout(() => {
              if (!switchCancelled) void attemptBootstrap();
            }, 3000);
          }
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

    void attemptBootstrap();

    return () => {
      switchCancelled = true;
      clearTimeout(switchFallbackTimer);
      map.off('load', revealAfterSwitch);
      map.off('idle', revealAfterSwitch);
    };
  }, [basemapStyleUrl]);

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