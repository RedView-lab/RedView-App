// ============================================
// Standalone LiDAR HD Viewer — Entry Point
// ============================================
// Reads tile params from URL, loads from OPFS, parses+colorizes in a Worker, renders with WebGPU.

import './panel/styles.css';
import './tileNavigator/styles.css';
import { LidarRenderer } from './renderer';
import type { HeightmapParams } from './renderer';
import { CameraController } from './camera';
import { buildTileFileName, getTileInfo, toWgs84 } from '../lib/coordConvert';
import type { DetectedCrs, AltitudeRef, TileCoord } from '../types';
import type { AABB } from './lod/types';
import { LodManager } from './lod/lodManager';
import { LidarManager } from '../lib/lidarManager';
import { buildViewerUrl, MAX_VIEWER_SCENE_TILES } from '../lib/viewerUrl';
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
import { createViewerTileNavigator } from './tileNavigator/controller';
import { buildTilePreviewMesh } from './preview/tilePreview';
import { loadViewerScene } from './session/dataset';
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
const statusEl = document.getElementById('status')!;
const barFill = document.getElementById('bar-fill')!;
const statsEl = document.getElementById('stats')!;

type IdleSchedulerWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
};

let cacheWriteQueue = Promise.resolve();

function setStatus(msg: string, pct?: number) {
  setViewerStatus(statusEl, barFill, msg, pct);
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

function buildPanelTileLabel(x: number, y: number, projection: DetectedCrs): string {
  return `Tuile ${x}/${y} (${projection})`;
}

function tileCoordKey(coord: Pick<TileCoord, 'xKm' | 'yKm' | 'projection' | 'altRef'>): string {
  return `${coord.xKm}_${coord.yKm}_${coord.projection}_${coord.altRef}`;
}

function parseSceneTileCoords(params: URLSearchParams, primaryTile: TileCoord): TileCoord[] {
  const tiles: TileCoord[] = [primaryTile];
  const seen = new Set<string>([tileCoordKey(primaryTile)]);

  const appendTile = (xKm: number, yKm: number) => {
    if (!Number.isFinite(xKm) || !Number.isFinite(yKm)) return;
    if (tiles.length >= MAX_VIEWER_SCENE_TILES) return;

    const coord: TileCoord = {
      ...primaryTile,
      xKm,
      yKm,
    };
    const key = tileCoordKey(coord);
    if (seen.has(key)) return;
    seen.add(key);
    tiles.push(coord);
  };

  for (const rawTile of params.getAll('tile')) {
    const [rawX, rawY] = rawTile.split(',', 2);
    appendTile(parseInt(rawX || '', 10), parseInt(rawY || '', 10));
  }

  const legacySecondaryXKm = parseInt(params.get('sx') || '', 10);
  const legacySecondaryYKm = parseInt(params.get('sy') || '', 10);
  appendTile(legacySecondaryXKm, legacySecondaryYKm);

  return tiles;
}

function computeSceneBudgetScale(tileCount: number, totalPoints: number, pointChunkCapacity: number): number {
  if (tileCount <= 1) return 1.0;

  const tilePressureScale = 1 / (1 + (tileCount - 1) * 0.16);
  const chunkPressureRatio = totalPoints / Math.max(pointChunkCapacity * 1.5, 1);
  const chunkPressureScale = chunkPressureRatio <= 1
    ? 1.0
    : 1 / (1 + Math.log2(chunkPressureRatio) * 0.18);

  return Math.max(0.35, Math.min(1.0, tilePressureScale * chunkPressureScale));
}

// --- Parse URL params ---
const params = new URLSearchParams(window.location.search);
const xKm = parseInt(params.get('x') || '', 10);
const yKm = parseInt(params.get('y') || '', 10);
const crs = (params.get('crs') || 'LAMB93') as DetectedCrs;
const altRef = (params.get('alt') || 'IGN69') as AltitudeRef;

if (isNaN(xKm) || isNaN(yKm)) {
  setStatus('❌ Paramètres invalides. URL: ?x=1003&y=6547&crs=LAMB93&alt=IGN69');
  throw new Error('Invalid viewer params');
}

const tileFileName = `${buildTileFileName(xKm, yKm, crs, altRef)}.copc.laz`;
// Legacy naming used yKm directly instead of yKm+1 (NW corner). Fall back to it
// for tiles downloaded before the naming convention fix.
const legacyTileFileName = `${buildTileFileName(xKm, yKm - 1, crs, altRef)}.copc.laz`;
const tileInfo = getTileInfo(crs);
const viewerTileCoord = {
  xKm,
  yKm,
  territory: tileInfo.territory,
  projection: crs,
  altRef,
} as TileCoord;
const sceneTileCoords = parseSceneTileCoords(params, viewerTileCoord);
const panelTileLabel = sceneTileCoords
  .map((coord) => buildPanelTileLabel(coord.xKm, coord.yKm, coord.projection))
  .join(' + ');
document.title = `LiDAR — ${sceneTileCoords
  .map((coord) => `${buildTileFileName(coord.xKm, coord.yKm, coord.projection, coord.altRef)}.copc.laz`)
  .join(' + ')}`;

// --- Load tile from OPFS ---
async function loadFromOPFS(): Promise<ArrayBuffer> {
  return loadTileFromOPFS([tileFileName, legacyTileFileName]);
}

// --- Main ---
let renderer: LidarRenderer | null = null;
const forceWebGL = params.get('engine') === 'webgl';

function switchToWebGLFallback() {
  if (!confirm(
    'Basculer vers le moteur WebGL HD ?\n\n' +
    '• Terrain texturé orthophoto en haute résolution\n' +
    '• Pas de nuage de points LiDAR (compatible toutes machines)\n' +
    '• Action irréversible : il faudra recharger pour revenir à WebGPU.'
  )) return;
  const url = new URL(window.location.href);
  url.searchParams.set('engine', 'webgl');
  window.location.href = url.toString();
}

async function startWebGLFallback(reasonForLog: string): Promise<void> {
  if (sceneTileCoords.length > 1) {
    throw new Error('Le mode LowQuality/WebGL ne supporte qu une seule tuile a la fois.');
  }
  await launchWebGLFallback({
    reasonForLog,
    dom: { canvas, overlay, statusEl, barFill, statsEl },
    loadFromOPFS,
    altRef,
    tileLabel: `${xKm},${yKm} ${crs}/${altRef}`,
    setStatus,
  });
}

(async () => {
  try {
    // User explicitly requested WebGL via the engine switch button → skip
    // the entire WebGPU pipeline and run the fallback directly.
    if (forceWebGL) {
      try {
        await startWebGLFallback('user requested ?engine=webgl');
        return;
      } catch (err: any) {
        console.error('[Viewer] Forced WebGL fallback failed:', err);
        showFatalError(overlay, {
          title: 'Moteur WebGL HD indisponible',
          message: "Impossible de démarrer le moteur WebGL HD demandé.",
          hint: "Vérifiez que la tuile est bien téléchargée, mettez à jour vos pilotes graphiques, ou réessayez sans le paramètre ?engine=webgl.",
          technical: err?.message || String(err),
        });
        return;
      }
    }

    // 0. WebGPU preflight — bail early on machines without a usable GPU
    setStatus('Vérification du support WebGPU...', 2);
    const pre = await preflightWebGPU();
    if (!pre.ok) {
      // No usable WebGPU adapter → spin up the WebGL2 fallback engine
      // (textured terrain only, no point cloud). Works on iGPU / older
      // browsers / headless setups.
      try {
        await startWebGLFallback(`preflight=${pre.code}`);
        return;
      } catch (fallbackErr: any) {
        console.error('[Viewer] WebGL fallback failed:', fallbackErr);
        const detail = fallbackErr?.message || String(fallbackErr);
        showFatalError(overlay, {
          title: 'Aucun moteur compatible',
          message:
            "Ni WebGPU ni le moteur WebGL HD de secours n'ont pu démarrer sur cette machine. " +
            "Le visualiseur LiDAR HD ne peut pas s'afficher.",
          hint:
            "Mettez à jour vos pilotes graphiques, utilisez un navigateur récent (Chrome / Edge / Firefox), " +
            "ou ouvrez le visualiseur sur une machine équipée d'un GPU dédié.",
          technical: `WebGPU: ${pre.code} — ${pre.detail}\nWebGL fallback: ${detail}`,
        });
        return;
      }
    }
    console.log(`[Viewer] Preflight OK — vendor=${pre.vendor} arch=${pre.arch} desc=${pre.desc}`);

    const scene = await loadViewerScene(sceneTileCoords, setStatus);
    const pointCloud = scene.pointCloud;

    // 3. Build RGBA colors
    const rgba = buildRGBA(pointCloud);

    // 3b. The scene terrain is merged once so the primary tile and the added
    // neighbor share the same height texture, one terrain pass, and one octree.
    setStatus('Assemblage du terrain...', 82);
    const terrainMesh = scene.terrainMesh;
    console.log(`[Viewer] Terrain: ${terrainMesh.vertexCount.toLocaleString()} vertices, ${(terrainMesh.indexCount / 3).toLocaleString()} triangles`);

    // 4. Center positions relative to bounding box center
    const { positions } = centerPositions(pointCloud);

    // 5. Init WebGPU
    setStatus('Initialisation WebGPU...', 85);
    resizeCanvas();
    renderer = new LidarRenderer();
    await renderer.init(canvas);
    // Re-resize with platform-aware DPR cap now that we know the GPU
    resizeCanvas();
    renderer.resize(canvas.width, canvas.height);

    // 5b. Upload heightmap texture for GPU Sobel normals
    const cx = (pointCloud.bounds.minX + pointCloud.bounds.maxX) / 2;
    const cy = (pointCloud.bounds.minY + pointCloud.bounds.maxY) / 2;
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

    const extent = Math.max(
      pointCloud.bounds.maxX - pointCloud.bounds.minX,
      pointCloud.bounds.maxY - pointCloud.bounds.minY,
      pointCloud.bounds.maxZ - pointCloud.bounds.minZ,
    );
    renderer.pointSize = 0.59;
    renderer.lodThreshold = Math.max(50, extent * 0.5);

    // 6. Build octree LOD in Web Worker
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
    console.log(`[Viewer] Octree: ${octree.nodeCount} nodes, depth ${octree.maxDepthReached}, ${octree.totalVoxelSamples.toLocaleString()} voxels`);

    // 6b. Upload octree data to GPU
    setStatus('Upload GPU (octree)...', 92);
    renderer.setOctreeData(octree);
    renderer.setMesh(terrainMesh.vertices, terrainMesh.colors, terrainMesh.indices);

    // 7. Camera + LOD Manager
    const camera = new CameraController(canvas);
    const halfExt = extent / 2;
    camera.lookAt(0, (pointCloud.bounds.maxZ - pointCloud.bounds.minZ) / 2, 0, halfExt);

    const lodManager = new LodManager();
    lodManager.setOctree(octree);
    if (renderer.platform) lodManager.applyPlatformProfile(renderer.platform);
    const sceneBudgetScale = computeSceneBudgetScale(
      sceneTileCoords.length,
      pointCloud.count,
      renderer.getPointChunkCapacity(),
    );
    lodManager.setSceneBudgetScale(sceneBudgetScale);
    console.log(
      `[Viewer] Scene budget scale ${sceneBudgetScale.toFixed(2)} for ` +
      `${sceneTileCoords.length} tile(s), ${pointCloud.count.toLocaleString()} pts, ` +
      `chunkCapacity=${renderer.getPointChunkCapacity().toLocaleString()}`,
    );

    const [lon, lat] = toWgs84(
      (pointCloud.bounds.minX + pointCloud.bounds.maxX) / 2,
      (pointCloud.bounds.minY + pointCloud.bounds.maxY) / 2,
      crs,
    );
    const lidarManager = new LidarManager();
    let panelSnowHandler = async (_mode: SnowModeKey) => {};
    const panel = createViewerPanel({
      tileLabel: panelTileLabel,
      locationLabel: buildTileLocationLabel(lon, lat),
      googleMapsUrl: buildGoogleMapsTileCenterUrl(lon, lat),
      pointSizePercent: pointSizeToPercent(renderer.pointSize),
      densityPercent: densityScaleToPercent(lodManager.getUserDensityScale()),
      onPointSizeChange: (percent) => {
        if (!renderer) return;
        renderer.pointSize = percentToPointSize(percent);
        requestRender();
      },
      onDensityChange: (percent) => {
        lodManager.setUserDensityScale(percentToDensityScale(percent));
        requestRender();
      },
      onSnowModeChange: (mode) => {
        void panelSnowHandler(mode);
      },
      onLowQualityClick: () => {
        switchToWebGLFallback();
      },
    });
    panel.setSettingsEnabled(false);
    panel.setSnowMode('off');
    panel.setLowQualityButtonState({
      label: 'Passer en mode LowQuality',
      disabled: sceneTileCoords.length > 1,
      title: sceneTileCoords.length > 1
        ? 'Le mode LowQuality est limite a une seule tuile.'
        : 'Bascule vers le moteur WebGL HD (terrain texture sans nuage de points).',
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

    // Done — hide overlay
    setStatus('Prêt', 100);
    setTimeout(() => overlay.classList.add('hidden'), 300);
    for (const write of scene.cacheWrites) {
      enqueueBackgroundCacheWrite(write.label, write.task);
    }

    // 8. Render loop with LOD
    let showLodStats = true;
    let lastCpuFrameMs = 16.6;

    let frameHandle: number | null = null;
    let renderRequested = true;
    let idleReset = true;
    let cleanedUp = false;

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

      renderer.updateCamera(camera.getViewMatrix(), camera.getProjMatrix());

      const [cpx, cpy, cpz] = renderer.lastCamPos;
      const [cfx, cfy, cfz] = renderer.lastCamFwd;
      lodManager.update(
        renderer.lastViewProj,
        cpx, cpy, cpz,
        cfx, cfy, cfz,
        canvas.width, canvas.height,
        budgetSampleMs,
      );

      const voxelSize = lodManager.getVoxelPointSize(renderer.pointSize);
      renderer.renderLOD(lodManager.getVisibleNodes(), voxelSize);

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

      lastCpuFrameMs = Math.max(1, performance.now() - frameStart);

      if (renderRequested) {
        requestRender();
      } else {
        idleReset = true;
      }
    };
    camera.onChange = () => requestRender();
    requestRender();

    // Handle resize
    const handleResize = () => {
      if (!renderer) return;
      resizeCanvas();
      renderer.resize(canvas.width, canvas.height);
      requestRender();
    };
    window.addEventListener('resize', handleResize);

    // Keyboard controls
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!renderer) return;
      if (e.key === '+' || e.key === '=') renderer.pointSize *= 1.2;
      if (e.key === '-' || e.key === '_') renderer.pointSize /= 1.2;
      renderer.pointSize = Math.max(POINT_SIZE_MIN, Math.min(POINT_SIZE_MAX, renderer.pointSize));
      if (e.key === 't' || e.key === 'T') renderer.terrainVisible = !renderer.terrainVisible;
      if (e.key === 'l' || e.key === 'L') {
        renderer.lodThreshold = renderer.lodThreshold > 0 ? 0 : Math.max(50, extent * 0.5);
      }
      if (e.key === 'q' || e.key === 'Q') showLodStats = !showLodStats;
      if (e.key === 'n' || e.key === 'N') {
        const nextMode: SnowModeKey = snowMode === 'off'
          ? 'cover'
          : snowMode === 'cover'
            ? 'thickness'
            : 'off';
        void panelSnowHandler(nextMode);
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
      window.removeEventListener('pagehide', handlePageHide);
      camera.onChange = null;
      camera.destroy();
      tileNavigator.destroy();
      lidarManager.destroy();
      panel.destroy();
      renderer?.destroy();
      renderer = null;
    };
    const handlePageHide = (event: PageTransitionEvent) => {
      if (event.persisted) {
        handleVisibilityChange();
        return;
      }
      cleanup();
    };
    window.addEventListener('pagehide', handlePageHide);

    // ---------------- SNOW ❄ ----------------
    // Le panneau Figma pilote les modes neige (off / couverture / épaisseur).
    const snowModes: Record<SnowModeKey, 0 | 1 | 2> = {
      off: 0,
      cover: 1,
      thickness: 2,
    };
    let snowMode: SnowModeKey = 'off';
    let snowFieldLoaded = false;
    let snowLoading = false;

    async function ensureSnowFieldLoaded() {
      if (!renderer || snowLoading || snowFieldLoaded) return true;
      const pc = pointCloud;
      const tm = terrainMesh;
      if (!pc || !tm) return false;
      snowLoading = true;
      panel.setSnowLoading(true);
      try {
        const { runSnowPipeline } = await import('../../snow');
        const field = await runSnowPipeline(
          {
            data: tm.heightGrid,
            width: tm.gridWidth,
            height: tm.gridHeight,
            bounds: pc.bounds,
            crs,
          },
          { progress: () => undefined },
        );
        const flipped = new Float32Array(field.data.length);
        for (let y = 0; y < field.height; y++) {
          const srcRow = (field.height - 1 - y) * field.width;
          const dstRow = y * field.width;
          for (let x = 0; x < field.width; x++) {
            flipped[dstRow + x] = field.data[srcRow + x];
          }
        }
        renderer.setSnow({
          data: flipped,
          width: field.width,
          height: field.height,
          originX: pc.bounds.minX - cx,
          originZ: -(pc.bounds.maxY - cy),
          scaleX: pc.bounds.maxX - pc.bounds.minX,
          scaleZ: pc.bounds.maxY - pc.bounds.minY,
        });
        requestRender();
        snowFieldLoaded = true;
        console.log(
          `[Viewer] Snow loaded: avg=${field.stats.meanCm.toFixed(0)}cm, ` +
          `max=${field.stats.maxCm.toFixed(0)}cm, cov=${field.stats.coveragePct.toFixed(1)}%, ` +
          `${field.stats.elapsedMs.toFixed(0)}ms (AROME ${field.arome.timestamp})`,
        );
        return true;
      } catch (err) {
        console.error('[Viewer] Snow fetch failed:', err);
        renderer.setSnowMode(0);
        requestRender();
        return false;
      } finally {
        snowLoading = false;
        panel.setSnowLoading(false);
      }
    }

    panelSnowHandler = async (nextMode: SnowModeKey) => {
      if (!renderer || snowLoading) return;
      if (nextMode !== 'off') {
        const ready = await ensureSnowFieldLoaded();
        if (!ready) {
          snowMode = 'off';
          panel.setSnowMode('off');
          return;
        }
      }
      snowMode = nextMode;
      renderer.setSnowMode(snowModes[nextMode]);
      panel.setSnowMode(nextMode);
      requestRender();
    };

  } catch (err: any) {
    const raw = err?.message || String(err);
    console.error('[Viewer] Fatal:', err);
    const explained = explainWorkerError(raw);
    showFatalError(overlay, { ...explained, technical: raw });
  }
})();

// --- Helpers ---

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  // Cap resolution to avoid oversized canvases on high-DPR screens (Retina Mac M1 etc.)
  const MAX_DIM = renderer?.platform?.maxCanvasDim ?? 4096;
  const maxDim = Math.max(window.innerWidth, window.innerHeight);
  const effectiveDpr = Math.min(dpr, MAX_DIM / maxDim);
  canvas.width = Math.floor(window.innerWidth * effectiveDpr);
  canvas.height = Math.floor(window.innerHeight * effectiveDpr);
}

