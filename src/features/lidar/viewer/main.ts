// ============================================
// Standalone LiDAR HD Viewer — Entry Point
// ============================================
// Reads tile params from URL, loads from OPFS, parses+colorizes in a Worker, renders with WebGPU.

import '@/shared/styles/typography.css';
import '@/shared/styles/glass.css';
import '@/shared/styles/dropdown.css';
import './loading/styles.css';
import './panel/styles.css';
import './tileNavigator/styles.css';
import { createAppTranslationBundle, readStoredAppLocale, translateAppText } from '@/shared/i18n/config';
import { buildTranslationLookup, observeDomTranslation } from '@/shared/i18n/domTranslation';
import { LidarRenderer, type HeightmapParams } from './renderer';
import { CameraController } from './camera';
import { getTimeZoneForCoordinates, toWgs84, trueNorthGridBearingDeg } from '../lib/coordConvert';
import { resolveTimeZoneAt } from '@/shared/lib/timeZoneAt';
import { SceneLod, type SceneLodStats } from './lod/sceneLod';
import { AdaptivePointBudget } from './lod/lodBudget';
import { LidarManager } from '../lib/lidarManager';
import { buildViewerUrl } from '../lib/viewerUrl';
import { syncRootAppScale } from '@/shared/lib/appScale';
import {
  createViewerPanel,
  densityScaleToPercent,
  FIXED_POINT_PX_MAX,
  FIXED_POINT_PX_MIN,
  fixedPointPixelsToPercent,
  percentToDensityScale,
  percentToEdlStrength,
  percentToFixedPointPixels,
  percentToPointSize,
  POINT_SIZE_MAX,
  POINT_SIZE_MIN,
  pointSizeToPercent,
  type SnowModeKey,
} from './panel/controller';
import { buildGoogleMapsTileCenterUrl, buildTileLocationLabel } from './panel/location';
import { exitLidarViewer, switchViewerEngine } from './panel/runtime/navigation';
import { createViewerTileNavigator } from './tileNavigator/controller';
import { createViewerRightPanel } from './rightPanel';
import { ViewerSlopeController } from './slope/viewerSlopeController';
import { ViewerAltitudeController } from './altitude/viewerAltitudeController';
import { ViewerRouteController } from './route/viewerRouteController';
import { sampleElevationAtProj } from './route/terrainRaycaster';
import type { ViewerRouteSceneParams } from './route/types';
import { FrameClock } from './perf/frameClock';
import { ViewerBench } from './perf/viewerBench';
import { SunlightController } from '../viewer-webgl/sunlightController';
import { buildTilePreviewMesh } from './preview/tilePreview';
import { createViewerLoadingOverlay } from './loading/controller';
import { loadViewerSceneData } from './session/dataset';
import { buildTileFileCandidates } from './session/datasetPointCap';
import { parseViewerParamsFromUrl } from './session/viewerUrlParams';
import { ViewerSnowController } from './session/viewerSnowController';
import {
  explainWorkerError,
  launchWebGLFallback,
  loadTileFromOPFS,
  preflightWebGPU,
  setViewerStatus,
  showFatalError,
} from './runtime';

// --- i18n ---
// No React here: the viewer's DOM (static HTML + imperative panels) is
// translated by the same observer as the app, in the locale stored by it.
const viewerLocale = readStoredAppLocale();
document.documentElement.lang = viewerLocale;
observeDomTranslation(document.body, buildTranslationLookup(createAppTranslationBundle(viewerLocale).entries));

// --- UI density ---
// Same screen-dependent scale as the dashboard canvas, applied to the floating
// panels with `zoom: var(--app-scale)`: the shared control panel renders at
// the same type size here and in the app.
syncRootAppScale();

// --- DOM refs ---
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const overlay = document.getElementById('overlay')!;
const statsEl = document.getElementById('stats')!;
const loadingOverlay = createViewerLoadingOverlay(overlay);
const { statusEl, detailEl, barFill, percentEl } = loadingOverlay;

type IdleSchedulerWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
};

type MemoryAwareNavigator = Navigator & {
  deviceMemory?: number;
};

let cacheWriteQueue = Promise.resolve();

function setStatus(msg: string, pct?: number) {
  setViewerStatus(statusEl, barFill, msg, pct, { percentEl, detailEl });
}

function enqueueBackgroundCacheWrite(label: string, task: () => Promise<void>): void {
  cacheWriteQueue = cacheWriteQueue
    .then(async () => {
      await new Promise<void>((resolve) => {
        const idleWindow = window as IdleSchedulerWindow;
        if (typeof idleWindow.requestIdleCallback === 'function') {
          idleWindow.requestIdleCallback(() => resolve(), { timeout: 1500 });
          return;
        }
        window.setTimeout(resolve, 250);
      });
      await task();
    })
    .catch((error) => {
      console.warn(`[Viewer] Background cache write failed (${label})`, error);
    });
}

let renderer: LidarRenderer | null = null;
/** Lowered by the automatic quality downgrade when the GPU cannot keep up. */
let resolutionScale = 1;
const MIN_RESOLUTION_SCALE = 0.55;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const maxDim = Math.max(window.innerWidth, window.innerHeight);
  const maxCanvasDim = renderer?.platform?.maxCanvasDim ?? 4096;
  const dprCap = renderer?.platform?.dprCap ?? 1.25;
  const effectiveDpr = Math.min(dpr, dprCap, maxCanvasDim / maxDim) * resolutionScale;
  canvas.width = Math.floor(window.innerWidth * effectiveDpr);
  canvas.height = Math.floor(window.innerHeight * effectiveDpr);
}

/** Frames rendered after the camera stops so the LOD reaches its resting quality. */
const MAX_SETTLE_FRAMES = 240;
/** Stats line refresh period (ms). */
const STATS_INTERVAL_MS = 250;
/** Frames keep the moving-camera quality this long after the last camera change (ms). */
const MOTION_HOLD_MS = 150;
const EDL_DEFAULT_PERCENT = 50;

/** EDL neighbour radius: 1.4 CSS px (Potree default), in canvas pixels. */
function edlRadiusPx(): number {
  return 1.4 * (canvas.width / Math.max(1, window.innerWidth));
}
const GPU_RETRY_STORAGE_KEY = 'redview-lidar-webgpu-retry-at';
const GPU_RETRY_WINDOW_MS = 120_000;

/**
 * Leaves WebGPU after a lost device or an out-of-memory upload. The canvas
 * already holds a WebGPU context, so the WebGL engine needs a fresh page:
 * the first loss reloads WebGPU once (tiles come back from the OPFS cache),
 * a second one within two minutes switches to `?engine=webgl`.
 */
function recoverFromGpuFailure(reason: string, allowRetry: boolean): void {
  const url = new URL(window.location.href);
  let recentRetry = false;
  try {
    const last = Number(window.sessionStorage.getItem(GPU_RETRY_STORAGE_KEY) || 0);
    recentRetry = Date.now() - last < GPU_RETRY_WINDOW_MS;
    window.sessionStorage.setItem(GPU_RETRY_STORAGE_KEY, String(Date.now()));
  } catch {
    recentRetry = true;
  }
  if (!allowRetry || recentRetry) {
    console.warn(`[Viewer] WebGPU failure (${reason}), switching to the WebGL engine.`);
    url.searchParams.set('engine', 'webgl');
  } else {
    console.warn(`[Viewer] WebGPU failure (${reason}), reloading once.`);
  }
  window.location.replace(url.toString());
}

(async () => {
  try {
    const {
      crs,
      altRef,
      forceWebGL,
      bench: benchMode,
      pinnedBudget,
      motionQuality,
      viewerTileCoord,
      sceneTileCoords,
      panelTileLabel,
    } = parseViewerParamsFromUrl();

    document.title = `LiDAR — ${sceneTileCoords.map((c) => `${c.xKm}_${c.yKm}`).join(' + ')}`;

    const lidarManager = new LidarManager();

    const startWebGLFallback = async (reasonForLog: string): Promise<void> => {
      const loadAllBuffers = async (): Promise<ArrayBuffer[]> => {
        const buffers: ArrayBuffer[] = [];
        for (const coord of sceneTileCoords) {
          const { fileName, legacyFileName } = buildTileFileCandidates(coord);
          const buf = await loadTileFromOPFS([fileName, legacyFileName]);
          buffers.push(buf);
        }
        return buffers;
      };

      await launchWebGLFallback({
        reasonForLog,
        dom: { canvas, overlay, statusEl, barFill, statsEl },
        loadFromOPFS: loadAllBuffers,
        altRef,
        tileLabel: panelTileLabel,
        tileCoord: viewerTileCoord,
        sceneTileCoords,
        lidarManager,
        setStatus,
      });
    };

    if (forceWebGL) {
      try {
        await startWebGLFallback('user requested ?engine=webgl');
        return;
      } catch (err: unknown) {
        console.error('[Viewer] Forced WebGL fallback failed:', err);
        showFatalError(overlay, {
          title: 'Moteur WebGL HD indisponible',
          message: "Impossible de démarrer le moteur WebGL HD demandé.",
          hint: "Vérifiez que la tuile est bien téléchargée ou réessayez sans le paramètre ?engine=webgl.",
          technical: (err as Error)?.message || String(err),
        });
        return;
      }
    }

    setStatus('Vérification du support WebGPU...', 2);
    const pre = await preflightWebGPU();
    if (!pre.ok) {
      try {
        await startWebGLFallback(`preflight=${pre.code}`);
        return;
      } catch (fallbackErr: unknown) {
        console.error('[Viewer] WebGL fallback failed:', fallbackErr);
        const detail = (fallbackErr as Error)?.message || String(fallbackErr);
        showFatalError(overlay, {
          title: 'Aucun moteur compatible',
          message: "Ni WebGPU ni le moteur WebGL HD de secours n'ont pu démarrer sur cette machine.",
          hint: "Mettez à jour vos pilotes graphiques ou utilisez un navigateur récent.",
          technical: `WebGPU: ${pre.code} — ${pre.detail}\nWebGL fallback: ${detail}`,
        });
        return;
      }
    }

    const deviceMemoryGiB = (navigator as MemoryAwareNavigator).deviceMemory;
    // Tiles open from their LOD cache (header + node table) or are decoded
    // once to build it; WebGPU init runs meanwhile.
    resizeCanvas();
    const rendererReady = (async () => {
      const instance = new LidarRenderer();
      await instance.init(canvas);
      return instance;
    })();
    rendererReady.catch(() => undefined);
    const scene = await loadViewerSceneData(sceneTileCoords, setStatus, { deviceMemoryGiB });
    const sceneBounds = scene.bounds;
    /** Bounds-only view of the scene for the overlay controllers. */
    const sceneInfo = { bounds: sceneBounds };

    const cx = (sceneBounds.minX + sceneBounds.maxX) / 2;
    const cy = (sceneBounds.minY + sceneBounds.maxY) / 2;
    const cz = (sceneBounds.minZ + sceneBounds.maxZ) / 2;

    setStatus('Initialisation WebGPU...', 86);
    renderer = await rendererReady;
    renderer.onDeviceLost = (info) => recoverFromGpuFailure(`device lost: ${info.message || info.reason}`, true);
    renderer.motionScale = motionQuality.scale ?? renderer.platform!.motionScale;
    renderer.motionSquares = motionQuality.squares;
    resizeCanvas();
    renderer.resize(canvas.width, canvas.height);

    const terrainMesh = await scene.terrainMesh;
    /** Scene frame + DTM grid, shared by the route overlay and the ground lookups. */
    const heightSceneParams: ViewerRouteSceneParams = {
      bounds: sceneBounds,
      crs,
      centerX: cx,
      centerY: cy,
      centerZ: cz,
      heightGrid: terrainMesh.heightGrid,
      gridWidth: terrainMesh.gridWidth,
      gridHeight: terrainMesh.gridHeight,
      // Grid centred on cz (heightmapWorker / mergeHeightGrid).
      heightGridOffsetZ: 0,
    };

    renderer.centerAltitude = cz;
    renderer.setMaxAltitude(sceneBounds.maxZ);
    const rangeX = sceneBounds.maxX - sceneBounds.minX;
    const rangeY = sceneBounds.maxY - sceneBounds.minY;
    renderer.setHeightmap({
      data: terrainMesh.heightGrid,
      width: terrainMesh.gridWidth,
      height: terrainMesh.gridHeight,
      originX: sceneBounds.minX - cx,
      originZ: -(sceneBounds.maxY - cy),
      scaleX: rangeX,
      scaleZ: rangeY,
    } as HeightmapParams);

    const extent = Math.max(rangeX, rangeY, sceneBounds.maxZ - sceneBounds.minZ);
    // One diameter for every point: ≈ 1.5× the mean ground spacing (≈0.25 m
    // for an IGN tile) closes the gaps at full density without smearing.
    const meanSpacing = Math.sqrt((rangeX * rangeY) / Math.max(1, scene.totalPoints));
    renderer.pointSize = Math.min(0.8, Math.max(0.1, meanSpacing * 1.5));
    renderer.pointSizeReference = renderer.pointSize;
    renderer.setEdl(false, percentToEdlStrength(EDL_DEFAULT_PERCENT), edlRadiusPx());
    renderer.setMesh(terrainMesh.vertices, terrainMesh.colors, terrainMesh.indices);

    const camera = new CameraController(canvas);
    camera.lookAt(0, 0, 0, extent * 0.6);

    const platform = renderer.platform!;
    // `?budget=<points>` pins the budget (A/B benches at equal load).
    const pointBudget = new AdaptivePointBudget(
      pinnedBudget
        ? { ...platform, minBudget: pinnedBudget, initialBudget: pinnedBudget, maxBudget: pinnedBudget }
        : platform,
      { preciseGpu: renderer.hasPreciseGpuTiming() },
    );
    let requestRenderRef: () => void = () => undefined;
    const sceneLod = new SceneLod(scene.tiles, { x: cx, y: cy, z: cz }, {
      pointBudget: pointBudget.pointBudget,
      poolBudget: platform.poolBudget,
      maxResidentNodes: renderer.getNodeCapacity(),
      uploader: renderer,
      onNodeResident: () => requestRenderRef(),
    });

    if (import.meta.env.DEV) {
      (window as unknown as { __rvLidar?: unknown }).__rvLidar = { sceneLod, pointBudget, renderer };
    }

    // Automatic downgrade for GPUs too slow even at the minimum point budget:
    // MSAA off first, then the render resolution in steps.
    let degrading = false;
    const degradeQuality = async (): Promise<void> => {
      if (!renderer) return;
      degrading = true;
      try {
        let changed = await renderer.disableMsaa();
        if (!changed && resolutionScale > MIN_RESOLUTION_SCALE) {
          resolutionScale = Math.max(MIN_RESOLUTION_SCALE, resolutionScale * 0.8);
          resizeCanvas();
          renderer.resize(canvas.width, canvas.height);
          applyEdlRef();
          changed = true;
          console.log(`[Viewer] Render resolution lowered to ${(resolutionScale * 100).toFixed(0)} % to keep the frame rate.`);
        }
        if (changed) pointBudget.resetMeasurements();
      } finally {
        degrading = false;
        requestRenderRef();
      }
    };
    let applyEdlRef: () => void = () => undefined;

    let showLodStats = true;
    let lastCpuFrameMs = 16.6;
    let frameHandle: number | null = null;
    let renderRequested = true;
    let cleanedUp = false;
    /** The camera moved since the route handles were last projected (done once per rendered frame). */
    let routeOverlayStale = true;
    let updateRouteOverlayRef: () => void = () => undefined;
    let lastStatsUpdateTime = 0;
    let settleFramesLeft = MAX_SETTLE_FRAMES;
    const frameClock = new FrameClock();
    let benchRun: ViewerBench | null = null;
    /** Last time the camera moved (rAF clock); frames stay in motion quality for MOTION_HOLD_MS after it. */
    let lastMotionTime = -Infinity;

    const requestRender = () => {
      renderRequested = true;
      settleFramesLeft = MAX_SETTLE_FRAMES;
      if (cleanedUp || document.hidden || frameHandle != null) return;
      frameHandle = window.requestAnimationFrame(renderLoop);
    };

    const formatLodStats = (lodStats: SceneLodStats): string => {
      const cadence = frameClock.getCadence();
      const gpuMs = renderer?.getGpuFrameMs() ?? 0;
      const shadeMs = renderer?.getGpuShadeMs() ?? 0;
      const drawCalls = renderer?.getLastRenderStats().drawCalls ?? 0;
      const renderScale = renderer?.getLastRenderScale() ?? 1;
      return (cadence.samples > 0 ? `${cadence.fps} fps · p95 ${cadence.p95Ms.toFixed(0)} ms` : '— fps') +
        (gpuMs > 0 ? ` · GPU ${gpuMs.toFixed(1)} ms` : '') +
        (shadeMs >= 0.05 ? ` + ${translateAppText('ombrage {{ms}} ms', { ms: shadeMs.toFixed(1) })}` : '') +
        ` · CPU ${lastCpuFrameMs.toFixed(1)} ms` +
        ` · ${lodStats.selectedPoints.toLocaleString()} / ${lodStats.totalPoints.toLocaleString()} pts` +
        ` · budget ${(lodStats.pointBudget / 1e6).toFixed(1)}M` +
        ` · ${lodStats.selectedNodes}/${lodStats.totalNodes} nodes · draws ${drawCalls}` +
        ` · GPU ${(lodStats.residentPoints / 1e6).toFixed(1)}/${(lodStats.poolBudget / 1e6).toFixed(0)}M pts` +
        (lodStats.pendingLoads > 0 ? ` · ${translateAppText('chargement {{count}}', { count: lodStats.pendingLoads })}` : '') +
        ` · ${translateAppText('{{count}} tuile(s)', { count: sceneTileCoords.length })}` +
        ` · ${canvas.width}×${canvas.height}${renderScale < 1 ? ` ×${renderScale.toFixed(2)}` : ''} ${platform.tier}`;
    };

    const renderLoop = (frameTime: number) => {
      frameHandle = null;
      if (!renderer || cleanedUp || document.hidden) {
        frameClock.pause();
        return;
      }
      const intervalMs = frameClock.frame(frameTime);
      const frameStart = performance.now();
      renderRequested = false;

      if (camera.update(frameTime)) {
        lastMotionTime = frameTime;
        routeOverlayStale = true;
      }
      // Moving frames trade resolution and round sprites for cadence; the
      // first still frame after the hold restores full quality.
      const motion = frameTime - lastMotionTime < MOTION_HOLD_MS;

      renderer.updateCamera(camera.getViewMatrix(), camera.getRenderProjMatrix(), camera.getEye());

      // GPU time of the draw passes and the real cadence drive the budget,
      // sized on moving frames (see lodBudget).
      pointBudget.sample({
        gpuMs: renderer.getGpuFrameMs(),
        cpuMs: lastCpuFrameMs,
        intervalMs,
        targetIntervalMs: frameClock.getTargetIntervalMs(),
        refreshMs: frameClock.getRefreshMs(),
        rest: !motion,
      });
      if (!pinnedBudget && pointBudget.isStarved() && !degrading) void degradeQuality();
      sceneLod.setPointBudget(pointBudget.pointBudget);
      const [cpx, cpy, cpz] = renderer.lastCamPos;
      // LOD at the canvas resolution in both modes: starting or stopping
      // the camera does not reshuffle the selection.
      sceneLod.update(renderer.lastViewProj, renderer.lastProjScaleY, cpx, cpy, cpz, canvas.height);
      renderer.renderScene(sceneLod.getSelectedNodes(), { motion });
      if (motion) renderRequested = true;
      if (routeOverlayStale) {
        routeOverlayStale = false;
        updateRouteOverlayRef();
      }
      const lodStats = sceneLod.getStats();
      // Budget growth only matters while it limits the selection (new nodes
      // only fill ~97 % of it, see sceneLod).
      const budgetSettled = pointBudget.isSettled() || lodStats.targetPoints < lodStats.pointBudget * 0.95;
      const keepSettling = !renderRequested && (!budgetSettled || !sceneLod.isIdle()) && settleFramesLeft > 0;
      const goingIdle = !renderRequested && !keepSettling;

      const now = performance.now();
      // The last frame before idling always refreshes the stats (no stale "loading").
      if (now - lastStatsUpdateTime >= STATS_INTERVAL_MS || goingIdle) {
        lastStatsUpdateTime = now;
        const text = showLodStats ? formatLodStats(lodStats) : `${scene.totalPoints.toLocaleString()} pts · ${scene.tileFileLabel}`;
        if (statsEl.textContent !== text) statsEl.textContent = text;
      }

      lastCpuFrameMs = Math.max(0.1, performance.now() - frameStart);
      benchRun?.recordFrame(frameTime, {
        drawMs: renderer.getGpuFrameMs(),
        shadeMs: renderer.getGpuShadeMs(),
        cpuMs: lastCpuFrameMs,
        selectedPoints: lodStats.selectedPoints,
        pointBudget: lodStats.pointBudget,
        uploadedNodes: lodStats.uploadedNodes,
        renderScale: renderer.getLastRenderScale(),
      });
      if (renderRequested) {
        requestRender();
      } else if (keepSettling) {
        // Camera is still, but nodes are still streaming in or the budget is adapting.
        settleFramesLeft -= 1;
        frameHandle = window.requestAnimationFrame(renderLoop);
      } else {
        frameClock.pause();
      }
    };
    requestRenderRef = requestRender;

    const [lon, lat] = toWgs84(cx, cy, crs);
    const snowController = new ViewerSnowController();

    let lastFixedPointPixels = 2;
    // EDL darkens every depth step (outlines around points and against the
    // sky); it stays available but off by default.
    let edlEnabled = false;
    let edlStrengthPercent = EDL_DEFAULT_PERCENT;
    const applyEdl = () => renderer?.setEdl(edlEnabled, percentToEdlStrength(edlStrengthPercent), edlRadiusPx());
    applyEdlRef = applyEdl;
    const pointSizeSliderPercent = (r: LidarRenderer) => (r.fixedPointPixels > 0
      ? fixedPointPixelsToPercent(r.fixedPointPixels)
      : pointSizeToPercent(r.pointSize));

    const panel = createViewerPanel({
      tileLabel: panelTileLabel,
      locationLabel: buildTileLocationLabel(lon, lat),
      googleMapsUrl: buildGoogleMapsTileCenterUrl(lon, lat),
      pointSizePercent: pointSizeToPercent(renderer.pointSize),
      densityPercent: densityScaleToPercent(pointBudget.userScale),
      edlEnabled,
      edlStrengthPercent,
      engineMode: 'webgpu',
      engineOptions: [
        { key: 'webgpu' },
        {
          key: 'webgl',
          title: 'Basculer vers le moteur WebGL HD.',
        },
      ],
      onPointSizeChange: (percent) => {
        if (!renderer) return;
        if (renderer.fixedPointPixels > 0) renderer.fixedPointPixels = percentToFixedPointPixels(percent);
        else renderer.pointSize = percentToPointSize(percent);
        requestRender();
      },
      onFixedSizeChange: (fixed) => {
        if (!renderer) return;
        if (!fixed && renderer.fixedPointPixels > 0) lastFixedPointPixels = renderer.fixedPointPixels;
        renderer.fixedPointPixels = fixed ? lastFixedPointPixels : 0;
        panel.setPointSizePercent(pointSizeSliderPercent(renderer));
        requestRender();
      },
      onEdlChange: (enabled, strengthPercent) => {
        edlEnabled = enabled;
        edlStrengthPercent = strengthPercent;
        applyEdl();
        requestRender();
      },
      onColorModeChange: (mode) => {
        renderer?.setColorMode(mode);
        requestRender();
      },
      onDensityChange: (percent) => {
        pointBudget.userScale = percentToDensityScale(percent);
        requestRender();
      },
      onEngineModeChange: (mode) => switchViewerEngine(mode),
      onSnowModeChange: (mode) => {
        void snowController.handleSnowModeChange(
          mode,
          renderer,
          sceneInfo,
          terrainMesh,
          crs,
          cx,
          cy,
          (loading) => panel.setSnowLoading(loading),
          (next) => panel.setSnowMode(next),
          requestRender,
        );
      },
      onPrimaryActionClick: () => exitLidarViewer(),
    });

    panel.setSnowMode('off');
    panel.setPrimaryActionState({ label: 'Quitter le mode LIDAR', title: 'Fermer le viewer LiDAR.' });

    const tileTimeZone = (await resolveTimeZoneAt(lon, lat)) ?? getTimeZoneForCoordinates(lon, lat, crs);

    const slopeController = new ViewerSlopeController(renderer, () => requestRender());
    const altitudeController = new ViewerAltitudeController(renderer, () => requestRender());
    const sunlightController = new SunlightController({
      bounds: sceneBounds,
      centerX: cx,
      centerY: cy,
      centerZ: cz,
      centerLon: lon,
      centerLat: lat,
      timeZone: tileTimeZone,
      trueNorthGridBearingDeg: trueNorthGridBearingDeg(cx, cy, crs),
      heightGrid: terrainMesh.heightGrid,
      gridWidth: terrainMesh.gridWidth,
      gridHeight: terrainMesh.gridHeight,
      onRequestRender: () => requestRender(),
    });

    const routeController = new ViewerRouteController({
      sceneParams: heightSceneParams,
      canvas,
      container: canvas.parentElement ?? document.body,
      camera,
      onMeshChange: (geom) => {
        if (!renderer) return;
        if (geom) {
          renderer.setRouteMesh(geom.vertices, geom.colors, geom.indices, geom.indexCount);
        } else {
          renderer.clearRouteMesh();
        }
      },
      onRequestRender: () => requestRender(),
    });

    const rightPanel = createViewerRightPanel({
      centerLon: lon,
      centerLat: lat,
      timeZone: tileTimeZone,
      routeController,
      onPointFilterChange: (pointFilterState) => {
        if (renderer) {
          renderer.setPointFilterState(pointFilterState);
          requestRender();
        }
      },
      onSlopeChange: (slopeState) => {
        slopeController.handleSlopeChange(slopeState);
      },
      onAltitudeChange: (altitudeState) => {
        altitudeController.handleAltitudeChange(altitudeState);
      },
      onSunlightChange: (sunlightState) => {
        const renderState = sunlightController.compute(sunlightState);
        if (renderer) {
          renderer.setSunlightRenderState(renderState);
          requestRender();
        }
      },
    });

    const tileNavigator = createViewerTileNavigator({
      currentTile: viewerTileCoord,
      activeTiles: sceneTileCoords,
      manager: lidarManager,
      onPreviewTile: (coord) => {
        if (!renderer) return;
        if (!coord) {
          renderer.clearPreviewMesh();
          return;
        }
        const previewMesh = buildTilePreviewMesh(coord, sceneBounds, terrainMesh, 0);
        renderer.setPreviewMesh(previewMesh.vertices, previewMesh.colors, previewMesh.indices);
        requestRender();
      },
      onSelectTiles: (coords) => {
        window.location.assign(buildViewerUrl(viewerTileCoord, coords.slice(1)));
      },
    });

    setStatus('Prêt', 100);
    setTimeout(() => overlay.classList.add('hidden'), 300);
    for (const write of scene.cacheWrites) {
      enqueueBackgroundCacheWrite(write.label, write.task);
    }
    scene.cacheWrites.length = 0;

    updateRouteOverlayRef = () => routeController.updateOverlay();
    camera.onChange = () => {
      routeOverlayStale = true;
      lastMotionTime = performance.now();
      requestRender();
    };
    requestRender();

    if (benchMode === 'orbit') {
      void (async () => {
        // Start from a settled scene: the first pass then measures streaming
        // driven by the motion only.
        const deadline = performance.now() + 30_000;
        await new Promise((resolve) => setTimeout(resolve, 500));
        while (!sceneLod.isIdle() && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        benchRun = new ViewerBench({
          camera,
          extent,
          groundAt: (x, z) => sampleElevationAtProj(x + cx, cy - z, heightSceneParams),
          getRefreshMs: () => frameClock.getRefreshMs(),
          onDone: (result) => {
            (window as unknown as { __rvLidarBench?: unknown }).__rvLidarBench = result;
            console.log(`[LiDAR bench] ${JSON.stringify(result)}`);
          },
        });
        benchRun.start();
      })();
    }

    const handleResize = () => {
      if (!renderer) return;
      resizeCanvas();
      renderer.resize(canvas.width, canvas.height);
      applyEdl();
      routeOverlayStale = true;
      requestRender();
    };
    window.addEventListener('resize', handleResize);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!renderer) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) {
        return;
      }
      if (e.key === 'e' || e.key === 'E') {
        const curState = routeController.getState();
        routeController.setEditMode(!curState.editMode);
        return;
      }
      const sizeStep = e.key === '+' || e.key === '=' ? 1.2 : e.key === '-' || e.key === '_' ? 1 / 1.2 : 1;
      if (renderer.fixedPointPixels > 0) {
        renderer.fixedPointPixels = Math.max(FIXED_POINT_PX_MIN, Math.min(FIXED_POINT_PX_MAX, renderer.fixedPointPixels * sizeStep));
      } else {
        renderer.pointSize = Math.max(POINT_SIZE_MIN, Math.min(POINT_SIZE_MAX, renderer.pointSize * sizeStep));
      }
      if (e.key === 't' || e.key === 'T') renderer.terrainVisible = !renderer.terrainVisible;
      if (e.key === 'l' || e.key === 'L') renderer.adaptivePointSize = !renderer.adaptivePointSize;
      if (e.key === 'q' || e.key === 'Q') showLodStats = !showLodStats;
      if (e.key === 'n' || e.key === 'N') {
        const nextMode: SnowModeKey = snowController.getMode() === 'off'
          ? 'cover'
          : snowController.getMode() === 'cover'
            ? 'thickness'
            : 'off';
        void snowController.handleSnowModeChange(
          nextMode,
          renderer,
          sceneInfo,
          terrainMesh,
          crs,
          cx,
          cy,
          (loading) => panel.setSnowLoading(loading),
          (next) => panel.setSnowMode(next),
          requestRender,
        );
      }
      panel.setPointSizePercent(pointSizeSliderPercent(renderer));
      requestRender();
    };
    window.addEventListener('keydown', handleKeyDown);

    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (frameHandle != null) {
          window.cancelAnimationFrame(frameHandle);
          frameHandle = null;
        }
        frameClock.pause();
        return;
      }
      requestRender();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (frameHandle != null) {
        window.cancelAnimationFrame(frameHandle);
        frameHandle = null;
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('keydown', handleKeyDown);
      camera.onChange = null;
      camera.destroy();
      tileNavigator.destroy();
      lidarManager.destroy();
      routeController.destroy();
      panel.destroy();
      rightPanel.destroy();
      sceneLod.destroy();
      renderer?.destroy();
      renderer = null;
    };
    window.addEventListener('pagehide', (ev) => {
      if (!ev.persisted) cleanup();
    });
  } catch (err: unknown) {
    const raw = (err as Error)?.message || String(err);
    console.error('[Viewer] Fatal:', err);
    const explained = explainWorkerError(raw);
    showFatalError(overlay, { ...explained, technical: raw });
  }
})();
