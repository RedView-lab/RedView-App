// ============================================
// Standalone LiDAR HD Viewer — Entry Point
// ============================================
// Reads tile params from URL, loads from OPFS, parses+colorizes in a Worker, renders with WebGPU.

import './loading/styles.css';
import './panel/styles.css';
import './tileNavigator/styles.css';
import { LidarRenderer, type HeightmapParams } from './renderer';
import { CameraController } from './camera';
import { getTimeZoneForCoordinates, toWgs84 } from '../lib/coordConvert';
import type { AABB } from './lod/types';
import { LodManager } from './lod/lodManager';
import { LidarManager } from '../lib/lidarManager';
import { buildViewerUrl } from '../lib/viewerUrl';
import {
  createViewerPanel,
  densityScaleToPercent,
  percentToDensityScale,
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
import { SunlightController } from '../viewer-webgl/sunlightController';
import { buildTilePreviewMesh } from './preview/tilePreview';
import { createViewerLoadingOverlay } from './loading/controller';
import { loadViewerSceneData } from './session/dataset';
import { buildTileFileCandidates } from './session/datasetPointCap';
import {
  computeSceneBudgetScale,
  parseViewerParamsFromUrl,
} from './session/viewerUrlParams';
import { ViewerSnowController } from './session/viewerSnowController';
import {
  buildOctreeInWorker,
  buildRGBA,
  centerPositions,
  explainWorkerError,
  launchWebGLFallback,
  loadTileFromOPFS,
  preflightWebGPU,
  setViewerStatus,
  showFatalError,
} from './runtime';

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

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const maxDim = Math.max(window.innerWidth, window.innerHeight);
  const maxCanvasDim = renderer?.platform?.maxCanvasDim ?? 4096;
  const effectiveDpr = Math.min(dpr, maxCanvasDim / maxDim);
  canvas.width = Math.floor(window.innerWidth * effectiveDpr);
  canvas.height = Math.floor(window.innerHeight * effectiveDpr);
}

(async () => {
  try {
    const {
      crs,
      altRef,
      forceWebGL,
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
    const scene = await loadViewerSceneData(sceneTileCoords, setStatus, {
      deviceMemoryGiB,
      gpuInfo: { vendor: pre.vendor, arch: pre.arch, desc: pre.desc },
    });
    const pointCloud = scene.pointCloud;
    const rgba = buildRGBA(pointCloud);

    setStatus('Assemblage du terrain...', 82);
    const terrainMesh = scene.terrainMesh;
    const { positions } = centerPositions(pointCloud);

    setStatus('Initialisation WebGPU...', 85);
    resizeCanvas();
    renderer = new LidarRenderer();
    await renderer.init(canvas);
    resizeCanvas();
    renderer.resize(canvas.width, canvas.height);

    const cx = (pointCloud.bounds.minX + pointCloud.bounds.maxX) / 2;
    const cy = (pointCloud.bounds.minY + pointCloud.bounds.maxY) / 2;
    const cz = (pointCloud.bounds.minZ + pointCloud.bounds.maxZ) / 2;
    renderer.centerAltitude = cz;
    renderer.setMaxAltitude(pointCloud.bounds.maxZ);
    const rangeX = pointCloud.bounds.maxX - pointCloud.bounds.minX;
    const rangeY = pointCloud.bounds.maxY - pointCloud.bounds.minY;
    renderer.setHeightmap({
      data: terrainMesh.heightGrid,
      width: terrainMesh.gridWidth,
      height: terrainMesh.gridHeight,
      originX: pointCloud.bounds.minX - cx,
      originZ: -(pointCloud.bounds.maxY - cy),
      scaleX: rangeX,
      scaleZ: rangeY,
    } as HeightmapParams);

    const extent = Math.max(rangeX, rangeY, pointCloud.bounds.maxZ - pointCloud.bounds.minZ);
    renderer.pointSize = 0.59;
    renderer.lodThreshold = Math.max(50, extent * 0.5);

    setStatus('Construction octree LOD...', 87);
    const centeredBounds: AABB = {
      minX: pointCloud.bounds.minX - cx,
      maxX: pointCloud.bounds.maxX - cx,
      minY: (pointCloud.bounds.minZ - (pointCloud.bounds.minZ + pointCloud.bounds.maxZ) / 2),
      maxY: (pointCloud.bounds.maxZ - (pointCloud.bounds.minZ + pointCloud.bounds.maxZ) / 2),
      minZ: -(pointCloud.bounds.maxY - cy),
      maxZ: -(pointCloud.bounds.minY - cy),
    };

    const octree = await buildOctreeInWorker(positions, rgba, centeredBounds, setStatus);
    setStatus('Upload GPU (octree)...', 92);
    renderer.setOctreeData(octree);
    renderer.setMesh(terrainMesh.vertices, terrainMesh.colors, terrainMesh.indices);

    const camera = new CameraController(canvas);
    camera.lookAt(0, 0, 0, extent * 0.6);

    const lodManager = new LodManager();
    lodManager.setOctree(octree);
    if (renderer.platform) lodManager.applyPlatformProfile(renderer.platform);
    const sceneBudgetScale = computeSceneBudgetScale(sceneTileCoords.length, pointCloud.count, renderer.getPointChunkCapacity());
    lodManager.setSceneBudgetScale(sceneBudgetScale);

    let showLodStats = true;
    let lastCpuFrameMs = 16.6;
    let frameHandle: number | null = null;
    let renderRequested = true;
    let idleReset = true;
    let cleanedUp = false;
    let lastStatsUpdateTime = 0;

    const requestRender = () => {
      renderRequested = true;
      if (cleanedUp || document.hidden || frameHandle != null) return;
      frameHandle = window.requestAnimationFrame(renderLoop);
    };

    const renderLoop = () => {
      frameHandle = null;
      if (!renderer || cleanedUp || document.hidden) {
        idleReset = true;
        return;
      }
      const frameStart = performance.now();
      const budgetSampleMs = idleReset ? Math.max(16.6, lastCpuFrameMs) : lastCpuFrameMs;
      idleReset = false;
      renderRequested = false;

      renderer.updateCamera(camera.getViewMatrix(), camera.getProjMatrix(), camera.getEye());

      const [cpx, cpy, cpz] = renderer.lastCamPos;
      const [cfx, cfy, cfz] = renderer.lastCamFwd;
      lodManager.update(renderer.lastViewProj, cpx, cpy, cpz, cfx, cfy, cfz, canvas.width, canvas.height, budgetSampleMs);

      const voxelSize = lodManager.getVoxelPointSize(renderer.pointSize);
      renderer.renderLOD(lodManager.getVisibleNodes(), voxelSize);

      const now = performance.now();
      if (now - lastStatsUpdateTime >= 100) {
        lastStatsUpdateTime = now;
        const s = lodManager.stats;
        const renderStats = renderer.getLastRenderStats();
        const gpu = renderer.platform?.isApple ? ' [Apple]' : '';
        if (showLodStats) {
          statsEl.textContent =
            `${s.visiblePoints.toLocaleString()} / ${s.totalPoints.toLocaleString()} pts` +
            ` · ${s.fps} fps · budget ${(s.pointBudget / 1000).toFixed(0)}K` +
            ` · ${s.visibleNodes} nodes · cull ${s.frustumCulled} · lod ${s.lodSkipped}` +
            ` · draws ${renderStats.drawCalls} · batches ${renderStats.leafBatches + renderStats.voxelBatches}${renderStats.gpuDrivenDensity ? ' gpu' : ''}` +
            ` · qual ${(s.qualityScale * 100).toFixed(0)}% · move ${(s.motionPressure * 100).toFixed(0)}%` +
            ` · voxel ${renderer.pointSize.toFixed(2)}m` +
            ` · ${sceneTileCoords.length} tuile(s) · ${canvas.width}×${canvas.height}${gpu}`;
        } else {
          statsEl.textContent = `${pointCloud.count.toLocaleString()} pts · voxel ${renderer.pointSize.toFixed(2)}m · ${scene.tileFileLabel}`;
        }
      }

      lastCpuFrameMs = Math.max(1, performance.now() - frameStart);
      if (renderRequested) requestRender();
      else idleReset = true;
    };

    const [lon, lat] = toWgs84(cx, cy, crs);
    const snowController = new ViewerSnowController();

    const panel = createViewerPanel({
      tileLabel: panelTileLabel,
      locationLabel: buildTileLocationLabel(lon, lat),
      googleMapsUrl: buildGoogleMapsTileCenterUrl(lon, lat),
      pointSizePercent: pointSizeToPercent(renderer.pointSize),
      densityPercent: densityScaleToPercent(lodManager.getUserDensityScale()),
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
        renderer.pointSize = percentToPointSize(percent);
        requestRender();
      },
      onDensityChange: (percent) => {
        lodManager.setUserDensityScale(percentToDensityScale(percent));
        requestRender();
      },
      onEngineModeChange: (mode) => switchViewerEngine(mode),
      onSnowModeChange: (mode) => {
        void snowController.handleSnowModeChange(
          mode,
          renderer,
          pointCloud,
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

    const tileTimeZone = getTimeZoneForCoordinates(lon, lat, crs);

    const slopeController = new ViewerSlopeController(renderer, () => requestRender());
    const altitudeController = new ViewerAltitudeController(renderer, () => requestRender());
    const sunlightController = new SunlightController({
      bounds: pointCloud.bounds,
      centerX: cx,
      centerY: cy,
      centerZ: cz,
      centerLon: lon,
      centerLat: lat,
      timeZone: tileTimeZone,
      heightGrid: terrainMesh.heightGrid,
      gridWidth: terrainMesh.gridWidth,
      gridHeight: terrainMesh.gridHeight,
      onRequestRender: () => requestRender(),
    });

    const routeController = new ViewerRouteController({
      sceneParams: {
        bounds: pointCloud.bounds,
        crs,
        centerX: cx,
        centerY: cy,
        centerZ: cz,
        heightGrid: terrainMesh.heightGrid,
        gridWidth: terrainMesh.gridWidth,
        gridHeight: terrainMesh.gridHeight,
      },
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
        const previewMesh = buildTilePreviewMesh(coord, pointCloud.bounds, terrainMesh);
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

    camera.onChange = () => {
      requestRender();
      routeController.updateOverlay();
    };
    requestRender();

    const handleResize = () => {
      if (!renderer) return;
      resizeCanvas();
      renderer.resize(canvas.width, canvas.height);
      routeController.updateOverlay();
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
      if (e.key === '+' || e.key === '=') renderer.pointSize *= 1.2;
      if (e.key === '-' || e.key === '_') renderer.pointSize /= 1.2;
      renderer.pointSize = Math.max(POINT_SIZE_MIN, Math.min(POINT_SIZE_MAX, renderer.pointSize));
      if (e.key === 't' || e.key === 'T') renderer.terrainVisible = !renderer.terrainVisible;
      if (e.key === 'l' || e.key === 'L') {
        renderer.lodThreshold = renderer.lodThreshold > 0 ? 0 : Math.max(50, extent * 0.5);
      }
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
          pointCloud,
          terrainMesh,
          crs,
          cx,
          cy,
          (loading) => panel.setSnowLoading(loading),
          (next) => panel.setSnowMode(next),
          requestRender,
        );
      }
      panel.setPointSizePercent(pointSizeToPercent(renderer.pointSize));
      requestRender();
    };
    window.addEventListener('keydown', handleKeyDown);

    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (frameHandle != null) {
          window.cancelAnimationFrame(frameHandle);
          frameHandle = null;
        }
        idleReset = true;
        return;
      }
      idleReset = true;
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
