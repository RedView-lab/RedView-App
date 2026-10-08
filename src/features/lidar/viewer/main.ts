// ============================================
// Viewer LiDAR HD autonome — point d'entrée
// ============================================
// Lit les paramètres de tuile dans l'URL, charge depuis l'OPFS, décode et colorise dans un worker, rend en WebGPU.

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
import { createViewerKeyDownHandler } from './session/viewerShortcuts';
import { ViewerSnowController, type SnowSceneContext } from './session/viewerSnowController';
import { launchWebGLFallback, loadTileFromOPFS, setViewerStatus } from './runtime';
import { explainWorkerError, noEngineHint, showFatalError } from './loading/fatalError';

// --- i18n ---
// Pas de React ici : le DOM du viewer (HTML statique + panneaux impératifs)
// est traduit par le même observateur que l'app, dans la langue qu'elle a
// enregistrée.
const viewerLocale = readStoredAppLocale();
document.documentElement.lang = viewerLocale;
observeDomTranslation(document.body, buildTranslationLookup(createAppTranslationBundle(viewerLocale).entries));

// --- Densité de l'interface ---
// Même échelle dépendant de l'écran que le canevas du tableau de bord,
// appliquée aux panneaux flottants avec `zoom: var(--app-scale)` : le panneau
// de contrôle partagé s'affiche à la même taille de texte ici et dans l'app.
syncRootAppScale();

// --- Audience ---
// Même mesure anonyme que l'app (traceur interne, en production seulement) ;
// le contexte du compte (formule, ancienneté, compte interne) vient de la copie locale de l'app.
initAnalytics({ surface: 'viewer', release: APP_BUILD_ID });
trackScreen('viewer');

// --- Références DOM ---
/** Remplacé par le canvas du renderer une fois créé (un moteur de repli reçoit un élément neuf, voir claimViewerCanvas). */
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
/** Abaissé par la dégradation automatique de qualité quand le GPU ne suit pas. */
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

/** Images rendues après l'arrêt de la caméra pour que le LOD atteigne sa qualité au repos. */
const MAX_SETTLE_FRAMES = 240;
/** Période de rafraîchissement de la ligne de statistiques (ms). */
const STATS_INTERVAL_MS = 250;
/** Les images gardent la qualité « caméra en mouvement » aussi longtemps après le dernier changement de caméra (ms). */
const MOTION_HOLD_MS = 150;
const EDL_DEFAULT_PERCENT = 50;

/** Rayon de voisinage de l'EDL : 1,4 px CSS (défaut de Potree), en pixels du canvas. */
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

    /** Moteur terrain (viewer-webgl) : MNT drapé de l'orthophoto, sans points, sur son propre canvas. */
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
    // Le renderer (WebGPU, sinon WebGL 2) démarre pendant que les tuiles
    // s'ouvrent depuis leur cache LOD (en-tête + table des nœuds) ou sont
    // décodées une fois pour le construire.
    setStatus('Préparation du rendu 3D...', 2);
    resizeCanvas();
    const rendererReady = createLidarRenderer(requestedEngine === 'webgl' ? 'webgl' : 'auto');
    const sceneReady = loadViewerSceneData(sceneTileCoords, setStatus, { deviceMemoryGiB });
    sceneReady.catch(() => undefined);
    let created: CreatedRenderer;
    try {
      created = await rendererReady;
    } catch (rendererErr: unknown) {
      // Ni WebGPU ni WebGL 2 n'ont démarré : dernier recours, le moteur terrain.
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
    /** Vue de la scène réduite à ses bornes, pour les contrôleurs de superposition. */
    const sceneInfo = { bounds: sceneBounds };

    const cx = (sceneBounds.minX + sceneBounds.maxX) / 2;
    const cy = (sceneBounds.minY + sceneBounds.maxY) / 2;
    const cz = (sceneBounds.minZ + sceneBounds.maxZ) / 2;

    setStatus('Initialisation du rendu 3D...', 86);

    const terrainMesh = await scene.terrainMesh;
    /** Repère de la scène + grille du MNT, partagés par la superposition du tracé et les recherches de sol. */
    const heightSceneParams: ViewerRouteSceneParams = {
      bounds: sceneBounds,
      crs,
      centerX: cx,
      centerY: cy,
      centerZ: cz,
      heightGrid: terrainMesh.heightGrid,
      gridWidth: terrainMesh.gridWidth,
      gridHeight: terrainMesh.gridHeight,
      // Grille centrée sur cz (heightmapWorker / mergeHeightGrid).
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
    // Un seul diamètre pour tous les points : ≈ 1,5× l'espacement moyen au sol
    // (≈ 0,25 m pour une tuile IGN) comble les trous à pleine densité sans baver.
    const meanSpacing = Math.sqrt((rangeX * rangeY) / Math.max(1, scene.totalPoints));
    renderer.pointSize = Math.min(0.8, Math.max(0.1, meanSpacing * 1.5));
    renderer.pointSizeReference = renderer.pointSize;
    renderer.setEdl(false, percentToEdlStrength(EDL_DEFAULT_PERCENT), edlRadiusPx());
    renderer.setTerrainMesh(terrainMesh);

    const camera = new CameraController(canvas);
    camera.lookAt(0, 0, 0, extent * 0.6);

    const platform = renderer.platform!;
    // `?budget=<points>` fixe le budget (benchs A/B à charge égale).
    const pointBudget = new AdaptivePointBudget(
      pinnedBudget
        ? { ...platform, minBudget: pinnedBudget, initialBudget: pinnedBudget, maxBudget: pinnedBudget }
        : platform,
      { preciseGpu: renderer.hasPreciseGpuTiming() },
    );
    // Caméra immobile : sélection plus dense, puis anticrénelage progressif
    // (désactivé avec un budget fixé : les benchs comparent des variantes à
    // charge égale).
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

    // Dégradation automatique pour les GPU trop lents même au budget de
    // points minimal : d'abord le MSAA, puis la résolution de rendu par paliers.
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
    /** La caméra a bougé depuis la dernière projection des poignées du tracé (faite une fois par image rendue). */
    let routeOverlayStale = true;
    let updateRouteOverlayRef: () => void = () => undefined;
    let lastStatsUpdateTime = 0;
    let settleFramesLeft = MAX_SETTLE_FRAMES;
    const frameClock = new FrameClock();
    let benchRun: ViewerBench | null = null;
    /** Dernier mouvement de la caméra (horloge rAF) ; les images restent en qualité « mouvement » MOTION_HOLD_MS après lui. */
    let lastMotionTime = -Infinity;

    const requestRender = () => {
      renderRequested = true;
      settleFramesLeft = MAX_SETTLE_FRAMES;
      // Quoi qu'il ait changé, l'image fixe moyennée est périmée.
      restRefinement.invalidate();
      if (cleanedUp || document.hidden || frameHandle != null) return;
      frameHandle = window.requestAnimationFrame(renderLoop);
    };

    const backendLabel = renderer.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2';
    const formatLodStats = (lodStats: SceneLodStats): string => formatLodStatsLine({
      lodStats,
      frameClock,
      renderer,
      cpuFrameMs: lastCpuFrameMs,
      restRefinement,
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
      // Les images en mouvement échangent résolution et sprites ronds contre la
      // cadence ; la première image fixe après le maintien rétablit la pleine qualité.
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
        // Le temps GPU des passes de dessin et la cadence réelle pilotent le
        // budget, dimensionné sur les images en mouvement (voir lodBudget).
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
      } else {
        // Affinage d'une vue fixe : ces images peuvent prendre quelques vsyncs
        // et n'alimentent pas le budget en mouvement.
        const restBudget = restRefinement.budget(pointBudget.rawBudget, platform.restMaxBudget);
        sceneLod.setPointBudget(Math.max(1, Math.floor(restBudget * pointBudget.userScale)));
      }
      const [cpx, cpy, cpz] = renderer.lastCamPos;
      // LOD à la résolution du canvas dans les deux modes : démarrer ou
      // arrêter la caméra ne remanie pas la sélection.
      sceneLod.update(renderer.lastViewProj, renderer.lastProjScaleY, cpx, cpy, cpz, canvas.height);
      renderer.renderScene(sceneLod.getSelectedNodes(), {
        motion,
        accumulate: accumulating ? restRefinement.sample : undefined,
      });
      if (motion) renderRequested = true;
      if (routeOverlayStale) {
        routeOverlayStale = false;
        updateRouteOverlayRef();
      }
      const lodStats = sceneLod.getStats();
      // La croissance du budget ne compte que tant qu'elle limite la sélection
      // (les nouveaux nœuds n'en remplissent que ~97 %, voir sceneLod).
      const budgetSettled = pointBudget.isSettled() || lodStats.targetPoints < lodStats.pointBudget * 0.95;
      if (!motion) {
        // Vue fixe : une fois le budget en mouvement stabilisé et sa sélection
        // dessinée, l'affiner, puis l'anticréneler (voir RestRefinement).
        if (restRefinement.phase === 'moving') {
          if (budgetSettled && sceneLod.isIdle()) restRefinement.startRefine();
        } else {
          const stillMs = renderer.hasPreciseGpuTiming() ? renderer.getGpuFrameMs() : frameClock.lastIntervalMs;
          if (restRefinement.phase === 'refine') {
            restRefinement.onRefineFrame(
              {
                lodIdle: sceneLod.isIdle(),
                gpuMs: stillMs,
                // Les nouveaux nœuds ne remplissent que ~97 % du budget (voir sceneLod).
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
      const goingIdle = !renderRequested && !keepSettling;

      const now = performance.now();
      // La dernière image avant le repos rafraîchit toujours les statistiques (pas de « chargement » périmé).
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
        // La caméra est immobile, mais des nœuds arrivent encore, le budget
        // s'adapte ou l'image fixe est en cours d'affinage.
        settleFramesLeft -= 1;
        frameHandle = window.requestAnimationFrame(renderLoop);
      } else {
        frameClock.pause();
      }
    };
    requestRenderRef = requestRender;

    const [lon, lat] = toWgs84(cx, cy, crs);
    const snowController = new ViewerSnowController();
    // Lu au premier calcul de la neige (le panneau et les outils existent alors).
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
    // L'EDL assombrit chaque marche de profondeur (contours autour des points
    // et contre le ciel) ; il reste disponible mais désactivé par défaut.
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

    /** Visibilité d'une classe ASPRS dans le filtre de points (le picking saute les retours masqués). */
    let isClassVisible: (classification: number) => boolean = () => true;
    /** Commentaires du projet de l'app (bulles sur la scène), créés une fois que les outils fournissent le modèle de terrain. */
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

    const rightPanel = createViewerRightPanel({
      centerLon: lon,
      centerLat: lat,
      timeZone: tileTimeZone,
      routeController,
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
    window.addEventListener('resize', handleResize);

    const handleKeyDown = createViewerKeyDownHandler({
      getRenderer: () => renderer,
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
