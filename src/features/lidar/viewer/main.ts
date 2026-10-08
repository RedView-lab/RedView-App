// ============================================
// Standalone LiDAR HD Viewer — Entry Point
// ============================================
// Reads tile params from URL, loads from OPFS, parses+colorizes in a Worker, renders with WebGPU.

import '@/shared/styles/typography.css';
import '@/shared/styles/theme.css';
import '@/shared/styles/glass.css';
import '@/shared/styles/dropdown.css';
import './loading/styles.css';
import './panel/styles.css';
import './tileNavigator/styles.css';
import { createAppTranslationBundle, readStoredAppLocale, translateAppText } from '@/shared/i18n/config';
import { buildTranslationLookup, observeDomTranslation } from '@/shared/i18n/domTranslation';
import type { HeightmapParams } from './renderer';
import type { LidarRenderer } from './renderer/sceneRenderer';
import { createLidarRenderer, type CreatedRenderer } from './renderer/createRenderer';
import { claimViewerCanvas } from './renderer/canvas';
import { CameraController } from './camera';
import { getTimeZoneForCoordinates, toWgs84, trueNorthGridBearingDeg } from '../lib/coordConvert';
import { resolveTimeZoneAt } from '@/shared/lib/timeZoneAt';
import { SceneLod, type SceneLodStats } from './lod/sceneLod';
import { AdaptivePointBudget } from './lod/lodBudget';
import { RestRefinement } from './lod/restRefinement';
import { LidarManager } from '../lib/lidarManager';
import { buildViewerUrl } from '../lib/viewerUrl';
import { syncRootAppScale } from '@/shared/lib/appScale';
import { createViewerPanel } from './panel/controller';
import {
  densityScaleToPercent,
  fixedPointPixelsToPercent,
  percentToDensityScale,
  percentToEdlStrength,
  percentToFixedPointPixels,
  percentToPointSize,
  pointSizeToPercent,
} from './panel/sliderScales';
import { buildGoogleMapsTileCenterUrl, buildTileLocationLabel } from './panel/location';
import { exitLidarViewer, switchViewerEngine } from './panel/runtime/navigation';
import { createViewerTileNavigator } from './tileNavigator/controller';
import { createViewerRightPanel } from './rightPanel';
import { ViewerSlopeController } from './slope/viewerSlopeController';
import { ViewerAltitudeController } from './altitude/viewerAltitudeController';
import { ViewerRouteController } from './route/viewerRouteController';
import { ViewerComments } from './comments/viewerComments';
import { zoneFromPolygon } from '@/features/comments/lib/zoneGeometry';
import { pointFilterClassPredicate, ViewerToolsController } from './tools';
import { countBucket, initAnalytics, trackAnalyticsEvent, trackScreen } from '@/shared/lib/analytics';
import { APP_BUILD_ID } from '@/shared/lib/appCacheEpoch';
import type { ViewerRouteSceneParams } from './route/types';
import { FrameClock } from './perf/frameClock';
import type { ViewerBench } from './perf/viewerBench';
import { installViewerBenchHooks } from './perf/benchHooks';
import { formatLodStatsLine } from './perf/lodStatsLine';
import { SunlightController } from '../viewer-webgl/sunlightController';
import { buildTilePreviewMesh } from './preview/tilePreview';
import { createViewerLoadingOverlay } from './loading/controller';
import { loadViewerSceneData } from './session/dataset';
import { buildTileFileCandidates } from './session/datasetPointCap';
import { parseViewerParamsFromUrl } from './session/viewerUrlParams';
import type { ViewerEngineKey } from './session/viewerEngine';
import { recoverFromGpuFailure } from './session/gpuRecovery';
import { enqueueBackgroundCacheWrite } from './session/backgroundCacheWrites';
import { setUpPhotoMode } from './session/photoModeSetup';
import { createViewerKeyDownHandler } from './session/viewerShortcuts';
import { ViewerSnowController, type SnowSceneContext } from './session/viewerSnowController';
import type { PhotoModeController } from './photoMode/photoModeController';
import { launchWebGLFallback, loadTileFromOPFS, setViewerStatus } from './runtime';
import { explainWorkerError, noEngineHint, showFatalError } from './loading/fatalError';

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

// --- Audience ---
// Same anonymous measurement as the app (first-party tracker, production only);
// the account context (plan, account age, internal account) comes from the app's local copy.
initAnalytics({ surface: 'viewer', release: APP_BUILD_ID });
trackScreen('viewer');

// --- DOM refs ---
/** Replaced by the renderer's canvas once created (a fallback engine gets a fresh element, see claimViewerCanvas). */
let canvas = document.getElementById('canvas') as HTMLCanvasElement;
const overlay = document.getElementById('overlay')!;
const statsEl = document.getElementById('stats')!;
const loadingOverlay = createViewerLoadingOverlay(overlay);
const { statusEl, detailEl, barFill, percentEl } = loadingOverlay;

type MemoryAwareNavigator = Navigator & {
  deviceMemory?: number;
};

function setStatus(msg: string, pct?: number) {
  setViewerStatus(statusEl, barFill, msg, pct, { percentEl, detailEl });
}

let renderer: LidarRenderer | null = null;
/** Lowered by the automatic quality downgrade when the GPU cannot keep up. */
let resolutionScale = 1;
/** Pixel-ratio ceiling raised while the photo mode is on (null: the platform's). */
let photoDprCap: number | null = null;
const MIN_RESOLUTION_SCALE = 0.55;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const maxDim = Math.max(window.innerWidth, window.innerHeight);
  const maxCanvasDim = renderer?.platform?.maxCanvasDim ?? 4096;
  const dprCap = Math.max(renderer?.platform?.dprCap ?? 1.25, photoDprCap ?? 0);
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

(async () => {
  try {
    const {
      crs,
      altRef,
      engine: requestedEngine,
      bench: benchMode,
      pinnedBudget,
      motionQuality,
      viewerTileCoord,
      sceneTileCoords,
      panelTileLabel,
    } = parseViewerParamsFromUrl();

    document.title = `LiDAR — ${sceneTileCoords.map((c) => `${c.xKm}_${c.yKm}`).join(' + ')}`;

    const lidarManager = new LidarManager();

    /** Terrain engine (viewer-webgl): orthophoto-draped DTM without points, on a canvas of its own. */
    const startTerrainEngine = async (reasonForLog: string): Promise<void> => {
      const loadAllBuffers = async (): Promise<ArrayBuffer[]> => {
        const buffers: ArrayBuffer[] = [];
        for (const coord of sceneTileCoords) {
          const { fileName, legacyFileName } = buildTileFileCandidates(coord);
          const buf = await loadTileFromOPFS([fileName, legacyFileName]);
          buffers.push(buf);
        }
        return buffers;
      };

      canvas = claimViewerCanvas();
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

    const trackViewerOpened = (engine: ViewerEngineKey) =>
      trackAnalyticsEvent({ name: 'lidar_viewer_opened', data: { engine, tiles: countBucket(sceneTileCoords.length) } });

    if (requestedEngine === 'terrain') {
      trackViewerOpened('terrain');
      try {
        await startTerrainEngine('?engine=terrain');
      } catch (err: unknown) {
        console.error('[Viewer] Terrain engine failed:', err);
        showFatalError(overlay, {
          title: 'Terrain texturé indisponible',
          message: 'Impossible de démarrer le moteur de terrain texturé.',
          hint: 'Vérifiez que la tuile est bien téléchargée, ou rouvrez le viewer avec le moteur WebGPU ou WebGL 2.',
          technical: (err as Error)?.message || String(err),
        });
      }
      return;
    }

    const deviceMemoryGiB = (navigator as MemoryAwareNavigator).deviceMemory;
    // The renderer (WebGPU, else WebGL 2) starts while the tiles open from
    // their LOD cache (header + node table) or are decoded once to build it.
    setStatus('Préparation du rendu 3D...', 2);
    resizeCanvas();
    const rendererReady = createLidarRenderer(requestedEngine === 'webgl' ? 'webgl' : 'auto');
    const sceneReady = loadViewerSceneData(sceneTileCoords, setStatus, { deviceMemoryGiB });
    sceneReady.catch(() => undefined);
    let created: CreatedRenderer;
    try {
      created = await rendererReady;
    } catch (rendererErr: unknown) {
      // Neither WebGPU nor WebGL 2 started: last resort, the terrain engine.
      const rendererDetail = (rendererErr as Error)?.message || String(rendererErr);
      console.error('[Viewer] No point-cloud renderer:', rendererErr);
      trackViewerOpened('terrain');
      try {
        await startTerrainEngine(`renderer: ${rendererDetail}`);
      } catch (terrainErr: unknown) {
        console.error('[Viewer] Terrain engine failed:', terrainErr);
        showFatalError(overlay, {
          title: 'Aucun moteur compatible',
          message: "Ni WebGPU, ni WebGL 2, ni le terrain texturé n'ont pu démarrer dans ce navigateur.",
          hint: noEngineHint(),
          technical: `3D: ${rendererDetail}\nTerrain: ${(terrainErr as Error)?.message || String(terrainErr)}`,
        });
      }
      return;
    }
    renderer = created.renderer;
    canvas = renderer.canvas;
    const runningEngine: ViewerEngineKey = renderer.backend;
    trackViewerOpened(runningEngine);
    renderer.onDeviceLost = (info) => {
      trackAnalyticsEvent({ name: 'gpu_context_lost', data: { engine: runningEngine } });
      recoverFromGpuFailure(`context lost: ${info.message || info.reason}`, runningEngine);
    };
    renderer.motionScale = motionQuality.scale ?? renderer.platform!.motionScale;
    renderer.motionSquares = motionQuality.squares;
    resizeCanvas();
    renderer.resize(canvas.width, canvas.height);

    const scene = await sceneReady;
    const sceneBounds = scene.bounds;
    /** Bounds-only view of the scene for the overlay controllers. */
    const sceneInfo = { bounds: sceneBounds };

    const cx = (sceneBounds.minX + sceneBounds.maxX) / 2;
    const cy = (sceneBounds.minY + sceneBounds.maxY) / 2;
    const cz = (sceneBounds.minZ + sceneBounds.maxZ) / 2;

    setStatus('Initialisation du rendu 3D...', 86);

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
    renderer.setTerrainMesh(terrainMesh);

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
    // Still camera: denser selection, then progressive anti-aliasing (off
    // with a pinned budget: benches compare variants at equal load).
    const restRefinement = new RestRefinement(!pinnedBudget);
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
    let handleResizeRef: () => void = () => undefined;

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
      // Whatever changed, the averaged still image is stale.
      restRefinement.invalidate();
      if (cleanedUp || document.hidden || frameHandle != null) return;
      frameHandle = window.requestAnimationFrame(renderLoop);
    };
    /** One more frame, the still image kept (photo mode: drifting clouds, capture). */
    const requestFrame = () => {
      if (cleanedUp || document.hidden || frameHandle != null) return;
      frameHandle = window.requestAnimationFrame(renderLoop);
    };
    /** Photo mode (WebGPU); created with the panels. */
    let photo: PhotoModeController | null = null;

    const backendLabel = renderer.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2';
    const formatLodStats = (lodStats: SceneLodStats): string => formatLodStatsLine({
      lodStats,
      frameClock,
      renderer,
      cpuFrameMs: lastCpuFrameMs,
      restRefinement,
      photoActive: photo?.active ?? false,
      tileCount: sceneTileCoords.length,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      backendLabel,
      platformTier: platform.tier,
    });

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
      if (motion) restRefinement.setMoving();
      const accumulating = restRefinement.phase === 'accumulate';
      const [jitterX, jitterY] = restRefinement.jitter();
      renderer.setSubpixelJitter(jitterX, jitterY);

      renderer.setEyeLevelPoints(camera.getMode() === 'look');
      const depthRange = camera.getDepthRange();
      renderer.setDepthRange(depthRange.near, depthRange.far);
      renderer.updateCamera(camera.getViewMatrix(), camera.getRenderProjMatrix(), camera.getEye());

      if (restRefinement.phase === 'moving') {
        // GPU time of the draw passes and the real cadence drive the budget,
        // sized on moving frames (see lodBudget).
        // The photo mode's clouds are not the points' to pay for: fewer
        // points would not make them cheaper, and the budget collapsed to
        // its floor, then the render resolution, for good.
        pointBudget.sample({
          gpuMs: Math.max(0, renderer.getGpuFrameMs() - (renderer.photo?.getCloudMs() ?? 0)),
          cpuMs: lastCpuFrameMs,
          intervalMs,
          targetIntervalMs: frameClock.getTargetIntervalMs(),
          refreshMs: frameClock.getRefreshMs(),
          rest: !motion,
        });
        if (!pinnedBudget && pointBudget.isStarved() && !degrading) void degradeQuality();
        sceneLod.setPointBudget(pointBudget.pointBudget);
      } else {
        // Refining a still view: these frames may take a few vsyncs and do
        // not feed the moving budget.
        const restBudget = restRefinement.budget(pointBudget.rawBudget, platform.restMaxBudget);
        sceneLod.setPointBudget(Math.max(1, Math.floor(restBudget * pointBudget.userScale)));
      }
      const [cpx, cpy, cpz] = renderer.lastCamPos;
      // LOD at the canvas resolution in both modes: starting or stopping
      // the camera does not reshuffle the selection.
      sceneLod.update(renderer.lastViewProj, renderer.lastProjScaleY, cpx, cpy, cpz, canvas.height);
      const photoActive = photo?.active ?? false;
      if (photoActive) {
        // The detail shadow cascade follows what the camera looks at.
        if (camera.getMode() === 'look') {
          const eye = camera.getEye();
          const [fx, fy, fz] = camera.getForward();
          renderer.photo?.setFocus([eye[0] + fx * 40, eye[1] + fy * 40, eye[2] + fz * 40], 90);
        } else {
          renderer.photo?.setFocus([camera.targetX, camera.targetY, camera.targetZ], camera.radius * 0.9);
        }
      }
      renderer.renderScene(sceneLod.getSelectedNodes(), {
        motion,
        accumulate: accumulating ? restRefinement.sample : undefined,
        // Still image already averaged: only the clouds move.
        reuseScene: photoActive && !motion && restRefinement.phase === 'done',
      });
      if (motion) renderRequested = true;
      if (routeOverlayStale) {
        routeOverlayStale = false;
        updateRouteOverlayRef();
      }
      const lodStats = sceneLod.getStats();
      // Budget growth only matters while it limits the selection (new nodes
      // only fill ~97 % of it, see sceneLod).
      const budgetSettled = pointBudget.isSettled() || lodStats.targetPoints < lodStats.pointBudget * 0.95;
      if (!motion) {
        // Still view: once the moving budget has settled with its selection
        // drawn, refine it, then anti-alias it (see RestRefinement).
        if (restRefinement.phase === 'moving') {
          if (budgetSettled && sceneLod.isIdle()) restRefinement.startRefine();
        } else {
          const stillMs = renderer.hasPreciseGpuTiming() ? renderer.getGpuFrameMs() : frameClock.lastIntervalMs;
          if (restRefinement.phase === 'refine') {
            restRefinement.onRefineFrame(
              {
                lodIdle: sceneLod.isIdle(),
                gpuMs: stillMs,
                // New nodes only fill ~97 % of the budget (see sceneLod).
                budgetLimited: lodStats.targetPoints >= lodStats.pointBudget * 0.95,
              },
              pointBudget.rawBudget,
              platform.restMaxBudget,
            );
          } else if (accumulating) {
            restRefinement.onAccumulatedFrame(stillMs, pointBudget.rawBudget);
          }
        }
      }
      const keepSettling = !renderRequested
        && (!budgetSettled || !sceneLod.isIdle() || restRefinement.pending || (!motion && restRefinement.phase === 'moving'))
        && settleFramesLeft > 0;
      // Photo mode: clouds converging or drifting, tables being built, capture.
      const photoFrames = !renderRequested && !keepSettling && photoActive && (renderer.photo?.needsFrames() ?? false);
      const goingIdle = !renderRequested && !keepSettling && !photoFrames;

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
        // Camera is still, but nodes are still streaming in, the budget is
        // adapting or the still image is being refined.
        settleFramesLeft -= 1;
        frameHandle = window.requestAnimationFrame(renderLoop);
      } else if (photoFrames) {
        frameHandle = window.requestAnimationFrame(renderLoop);
      } else {
        frameClock.pause();
      }
    };
    requestRenderRef = requestRender;

    const [lon, lat] = toWgs84(cx, cy, crs);
    const snowController = new ViewerSnowController();
    // Read when the snow is first computed (the panel and the tools exist by then).
    const snowContext = (): SnowSceneContext => ({
      renderer,
      pointCloud: sceneInfo,
      terrainMesh,
      crs,
      cx,
      cy,
      cz,
      readCanopy: (cellM) => tools?.readSceneCanopy(cellM) ?? Promise.resolve(null),
      onProgressState: (loading) => panel.setSnowLoading(loading),
      requestRender,
    });

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
      engineMode: runningEngine,
      engineOptions: [
        created.webgpuUnavailable !== null && requestedEngine === 'auto'
          ? {
            key: 'webgpu',
            disabled: true,
            title: translateAppText('WebGPU indisponible dans ce navigateur : {{reason}}', { reason: created.webgpuUnavailable }),
          }
          : { key: 'webgpu', title: 'Moteur WebGPU (le plus rapide).' },
        { key: 'webgl', title: 'Même viewer en WebGL 2, compatible avec tous les navigateurs (Firefox, Chrome sous Linux).' },
        { key: 'terrain', title: "Relief texturé par l'orthophoto, sans nuage de points." },
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
      onEngineModeChange: (mode) => {
        if (!switchViewerEngine(mode, runningEngine)) panel.setEngineMode(runningEngine);
      },
      onSnowModeChange: (mode) => {
        void snowController.handleSnowModeChange(mode, snowContext(), (next) => panel.setSnowMode(next));
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

    /** Point-filter visibility of an ASPRS class (picking skips hidden returns). */
    let isClassVisible: (classification: number) => boolean = () => true;
    /** Comments of the app project (bubbles on the scene), created once the tools give the ground model. */
    let comments: ViewerComments | null = null;
    const tools = ViewerToolsController.create({
      canvas,
      container: canvas.parentElement ?? document.body,
      camera,
      sceneParams: heightSceneParams,
      tiles: scene.tiles,
      getDrawnNodes: () => sceneLod.getSelectedNodes(),
      isClassVisible: (classification) => isClassVisible(classification),
      getPointSize: () => renderer?.pointSize ?? 0.3,
      routeController,
      setAnalysisMesh: (mesh) => {
        if (!renderer) return;
        if (mesh) renderer.setAnalysisMesh(mesh.vertices, mesh.colors, mesh.indices);
        else renderer.clearAnalysisMesh();
      },
      requestRender: () => requestRender(),
      commentsAvailable: () => comments?.writable ?? false,
      onComment: (pick) => comments?.startDraft({ lng: pick.lon, lat: pick.lat, elevationM: pick.groundAltitudeM ?? pick.altitudeM }),
      onCommentZone: (ring, anchor) => {
        const zone = zoneFromPolygon(ring);
        if (zone) comments?.startDraft({ lng: anchor.lon, lat: anchor.lat, elevationM: anchor.groundAltitudeM ?? anchor.altitudeM }, zone);
      },
    });
    if (tools) {
      comments = new ViewerComments({
        container: canvas.parentElement ?? document.body,
        toLocal: (lon, lat, altitudeM) => tools.localFromLonLat(lon, lat, altitudeM),
        project: (local) => tools.projectLocal(local),
        isVisible: (local) => tools.isLocalVisible(local),
        centerOn: (local) => tools.centerOnLocal(local),
        obstacles: () => [...document.querySelectorAll('.viewer-panel, .lidar-viewer-right-panel-host')],
        showZone: (ring) => tools.setCommentZone(ring),
      });
    }

    // ── Photo mode (WebGPU): sky, clouds, shadows of the point cloud ──────
    const photoSetup = setUpPhotoMode({
      renderer,
      sceneBounds,
      terrainMesh,
      cx,
      cy,
      cz,
      crs,
      lat,
      lon,
      timeZone: tileTimeZone,
      sceneLod,
      restRefinement,
      pointBudget,
      captureName: panelTileLabel,
      requestRender,
      requestFrame,
      onActiveChange: (active) => {
        // Retina screens get their full pixel ratio for the photo.
        photoDprCap = active && platform.tier === 'apple' ? 2 : null;
        handleResizeRef();
      },
    });
    photo = photoSetup.photo;

    const rightPanel = createViewerRightPanel({
      centerLon: lon,
      centerLat: lat,
      timeZone: tileTimeZone,
      routeController,
      photo: photoSetup.panelSection,
      onPointFilterChange: (pointFilterState) => {
        isClassVisible = pointFilterClassPredicate(pointFilterState);
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

    updateRouteOverlayRef = () => {
      routeController.updateOverlay();
      tools?.updateOverlay();
      comments?.updateOverlay();
    };
    camera.onChange = () => {
      routeOverlayStale = true;
      lastMotionTime = performance.now();
      requestRender();
    };
    requestRender();

    installViewerBenchHooks({
      mode: benchMode,
      camera,
      extent,
      cx,
      cy,
      heightSceneParams,
      sceneLod,
      frameClock,
      onBenchRun: (run) => { benchRun = run; },
      isRendering: () => frameHandle !== null,
    });

    const handleResize = () => {
      if (!renderer) return;
      resizeCanvas();
      renderer.resize(canvas.width, canvas.height);
      applyEdl();
      routeOverlayStale = true;
      requestRender();
    };
    handleResizeRef = handleResize;
    window.addEventListener('resize', handleResize);

    const handleKeyDown = createViewerKeyDownHandler({
      getRenderer: () => renderer,
      getPhoto: () => photo,
      camera,
      heightSceneParams,
      routeController,
      snowController,
      snowContext,
      panel,
      pointSizeSliderPercent,
      toggleLodStats: () => { showLodStats = !showLodStats; },
      requestRender,
    });
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
      photo?.destroy();
      comments?.destroy();
      tools?.destroy();
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
