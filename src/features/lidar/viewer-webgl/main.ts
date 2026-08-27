import { CameraController } from '../viewer/camera';
import { WebGLTerrainRenderer } from './renderer';
import type { TerrainMeshWebGL } from './terrainWorker';
import { stitchOrtho } from './orthoStitcher';
import { getTimeZoneForCoordinates, toWgs84 } from '../lib/coordConvert';
import { createViewerPanel, factorToElevationPercent, type SnowModeKey } from '../viewer/panel/controller';
import { buildGoogleMapsTileCenterUrl, buildTileLocationLabel } from '../viewer/panel/location';
import { exitLidarViewer, switchViewerEngine } from '../viewer/panel/runtime/navigation';
import '../viewer/tileNavigator/styles.css';
import { createViewerTileNavigator } from '../viewer/tileNavigator/controller';
import { createViewerRightPanel } from '../viewer/rightPanel';
import { ViewerRouteController } from '../viewer/route/viewerRouteController';
import { buildTilePreviewMesh } from '../viewer/preview/tilePreview';
import { LidarManager } from '../lib/lidarManager';
import { buildViewerUrl } from '../lib/viewerUrl';
import type { TileCoord, DetectedCrs } from '../types';
import { setViewerStatus } from '../viewer/runtime';
import { detectDeviceTier, readBoundsFromLasHeader } from './qualityProfile';
import { SunlightController } from './sunlightController';
import { unionBounds } from '../viewer/session/datasetMerge';

export interface WebGLViewerHandles {
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  status: HTMLElement;
  bar: HTMLElement;
  stats: HTMLElement;
  percent?: HTMLElement;
  detail?: HTMLElement;
}

export interface WebGLViewerOptions {
  buffer?: ArrayBuffer;
  buffers?: ArrayBuffer[];
  altRefLabel: string;
  tileLabel: string;
  tileCoord?: TileCoord;
  sceneTileCoords?: TileCoord[];
  lidarManager?: LidarManager;
  reloadBuffer?: () => Promise<ArrayBuffer>;
}

function resizeCanvas(canvas: HTMLCanvasElement, dprCap: number): void {
  const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

export async function runWebGLFallback(
  ui: WebGLViewerHandles,
  opts: WebGLViewerOptions,
): Promise<void> {
  const { canvas, overlay, status, bar, stats } = ui;
  const percentEl = ui.percent ?? overlay.querySelector<HTMLElement>('#progress-percent') ?? undefined;
  const detailEl = ui.detail ?? overlay.querySelector<HTMLElement>('#status-detail') ?? undefined;

  const setStatus = (msg: string, pct?: number) => {
    setViewerStatus(status, bar, msg, pct, { percentEl, detailEl });
  };

  setStatus('Mode WebGL HD : initialisation…', 1);

  const profile = detectDeviceTier();
  console.log(
    `[WebGL Viewer] Quality tier = ${profile.tier} (${profile.reason}) ` +
    `→ grid ≤ ${profile.maxGrid}, res ≥ ${profile.minResM}m, ` +
    `tex ≤ ${profile.textureCap}, dpr ≤ ${profile.dprCap}, lowPower=${profile.lowPower}`,
  );

  resizeCanvas(canvas, profile.dprCap);
  const renderer = new WebGLTerrainRenderer(canvas, { lowPower: profile.lowPower });
  console.log(`[WebGL Viewer] ${renderer.rendererInfo} · maxTex=${renderer.maxTextureSize}`);

  const rawBuffers: ArrayBuffer[] = opts.buffers && opts.buffers.length > 0
    ? opts.buffers
    : (opts.buffer ? [opts.buffer] : []);

  if (rawBuffers.length === 0) {
    throw new Error('Aucun buffer LAZ disponible pour le visualiseur WebGL.');
  }

  const headers = rawBuffers.map((buf) => readBoundsFromLasHeader(buf)).filter(Boolean);
  const boundsList = headers.map((h) => h!.bounds);
  const primaryHeader = headers[0];
  const crs = (primaryHeader?.crs as DetectedCrs) ?? opts.tileCoord?.projection ?? 'LAMB93';
  const combinedBounds = unionBounds(boundsList);

  setStatus('Orthophoto HD en cours…', 10);
  const ortho = await stitchOrtho(
    combinedBounds,
    crs,
    profile.textureCap,
    (pct, label) => setStatus(label, 10 + Math.round(pct * 50)),
  );

  setStatus('Décompression du relief LiDAR…', 65);

  const worker = new Worker(
    new URL('./terrainWorker.ts', import.meta.url),
    { type: 'module' },
  );

  const mesh = await new Promise<TerrainMeshWebGL>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        setStatus(`Décompression LiDAR : ${msg.phase}…`, 65 + Math.round(msg.percent * 0.25));
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve(msg.mesh);
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(err);
    };

    worker.postMessage(
      {
        type: 'build',
        buffers: rawBuffers,
        bounds: combinedBounds,
        cornerUV: ortho.cornerUV,
        maxGrid: profile.maxGrid,
        minResM: profile.minResM,
      },
      rawBuffers,
    );
  });

  setStatus('Upload GPU…', 95);
  renderer.uploadMesh({
    vertices: mesh.vertices,
    indices: mesh.indices,
    vertexCount: mesh.vertexCount,
    indexCount: mesh.indexCount,
  });
  renderer.setCenterAltitude(mesh.centerZ, mesh.bounds.maxZ);
  renderer.uploadOrtho(ortho.bitmap);

  const spanX = mesh.bounds.maxX - mesh.bounds.minX;
  const spanY = mesh.bounds.maxY - mesh.bounds.minY;
  const spanZ = mesh.bounds.maxZ - mesh.bounds.minZ;
  const cx = (mesh.bounds.minX + mesh.bounds.maxX) / 2;
  const cy = (mesh.bounds.minY + mesh.bounds.maxY) / 2;

  renderer.setTerrainBounds({
    originX: mesh.bounds.minX - cx,
    originZ: -(mesh.bounds.maxY - cy),
    scaleX: spanX,
    scaleZ: spanY,
  });

  const camera = new CameraController(canvas);
  const maxSpan = Math.max(spanX, spanY, spanZ);
  camera.lookAt(0, (mesh.bounds.maxZ - mesh.bounds.minZ) / 2, 0, maxSpan * 0.6);

  let frameHandle: number | null = null;
  let renderRequested = true;
  let cleanedUp = false;

  const requestRender = () => {
    renderRequested = true;
    if (cleanedUp || document.hidden || frameHandle != null) return;
    frameHandle = window.requestAnimationFrame(renderLoop);
  };

  const renderLoop = () => {
    frameHandle = null;
    if (cleanedUp || document.hidden) return;
    renderRequested = false;

    const viewMatrix = camera.getViewMatrix();
    const viewProj = WebGLTerrainRenderer.multiplyMat4(viewMatrix, camera.getProjMatrix());
    renderer.render(viewProj, viewMatrix);

    stats.textContent =
      `WebGL2 · ${(mesh.vertexCount / 1e3).toFixed(0)}k sommets · ${(mesh.indexCount / 3e3).toFixed(0)}k triangles · ` +
      `ortho ${ortho.width}×${ortho.height} · ${sceneCoords.length} tuile(s) · canvas ${canvas.width}×${canvas.height}`;

    if (renderRequested) {
      requestRender();
    }
  };

  const [centerLon, centerLat] = toWgs84(cx, cy, crs);
  const tileTimeZone = getTimeZoneForCoordinates(centerLon, centerLat, crs);

  const sunlightController = new SunlightController({
    bounds: mesh.bounds,
    centerX: cx,
    centerY: cy,
    centerZ: mesh.centerZ,
    centerLon,
    centerLat,
    heightGrid: mesh.heightGrid,
    gridWidth: mesh.gridWidth,
    gridHeight: mesh.gridHeight,
    timeZone: tileTimeZone,
    onRequestRender: () => requestRender(),
  });

  const snowModes: Record<SnowModeKey, 0 | 1 | 2> = { off: 0, cover: 1, thickness: 2 };
  let snowMode: SnowModeKey = 'off';
  let snowFieldLoaded = false;
  let snowLoading = false;

  async function ensureSnowFieldLoaded(): Promise<boolean> {
    if (snowLoading || snowFieldLoaded) return true;
    snowLoading = true;
    panel.setSnowLoading(true);
    try {
      const { runSnowPipeline } = await import('@/features/snow');
      const cx = (mesh.bounds.minX + mesh.bounds.maxX) / 2;
      const cy = (mesh.bounds.minY + mesh.bounds.maxY) / 2;
      const field = await runSnowPipeline(
        {
          data: mesh.heightGrid,
          width: mesh.gridWidth,
          height: mesh.gridHeight,
          bounds: mesh.bounds,
          crs,
        },
        { progress: () => undefined },
      );
      const flipped = new Float32Array(field.data.length);
      for (let y = 0; y < field.height; y++) {
        const srcRow = (field.height - 1 - y) * field.width;
        const dstRow = y * field.width;
        for (let x = 0; x < field.width; x++) {
          flipped[dstRow + x] = field.data[srcRow + x]!;
        }
      }
      renderer.setSnow({
        data: flipped,
        width: field.width,
        height: field.height,
        originX: mesh.bounds.minX - cx,
        originZ: -(mesh.bounds.maxY - cy),
        scaleX: mesh.bounds.maxX - mesh.bounds.minX,
        scaleZ: mesh.bounds.maxY - mesh.bounds.minY,
      });
      requestRender();
      snowFieldLoaded = true;
      return true;
    } catch (err) {
      console.error('[WebGL Viewer] Snow fetch failed:', err);
      renderer.setSnowMode(0);
      requestRender();
      return false;
    } finally {
      snowLoading = false;
      panel.setSnowLoading(false);
    }
  }

  const handleSnowModeChange = async (nextMode: SnowModeKey) => {
    if (nextMode === snowMode) return;
    snowMode = nextMode;
    panel.setSnowMode(nextMode);
    if (nextMode === 'off') {
      renderer.setSnowMode(0);
      requestRender();
      return;
    }
    const ok = await ensureSnowFieldLoaded();
    if (!ok) return;
    renderer.setSnowMode(snowModes[nextMode]);
    requestRender();
  };

  const primaryCoord: TileCoord = opts.tileCoord ?? {
    xKm: primaryHeader?.bounds ? Math.floor(primaryHeader.bounds.minX / 1000) : 0,
    yKm: primaryHeader?.bounds ? Math.floor(primaryHeader.bounds.minY / 1000) : 0,
    territory: 'FXX',
    projection: crs,
    altRef: 'IGN69',
  };

  const sceneCoords = opts.sceneTileCoords && opts.sceneTileCoords.length > 0
    ? opts.sceneTileCoords
    : [primaryCoord];

  const panel = createViewerPanel({
    tileLabel: sceneCoords.length > 1
      ? `${sceneCoords.length} tuiles (${sceneCoords.map((c) => `${c.xKm}/${c.yKm}`).join(' + ')})`
      : `Tuile ${opts.tileLabel}`,
    locationLabel: buildTileLocationLabel(centerLon, centerLat),
    googleMapsUrl: buildGoogleMapsTileCenterUrl(centerLon, centerLat),
    engineMode: 'webgl',
    pointSizePercent: 50,
    densityPercent: 100,
    elevationPercent: factorToElevationPercent(1.0),
    engineOptions: [
      { key: 'webgpu', title: 'Basculer vers le moteur WebGPU HD.' },
      { key: 'webgl' },
    ],
    onPointSizeChange: () => {},
    onDensityChange: () => {},
    onElevationChange: (_percent, factor) => {
      renderer.setElevationExaggeration(factor);
      requestRender();
    },
    onEngineModeChange: (mode) => switchViewerEngine(mode),
    onSnowModeChange: (mode) => {
      void handleSnowModeChange(mode);
    },
    onPrimaryActionClick: () => exitLidarViewer(),
  });

  panel.setSnowMode('off');
  panel.setPrimaryActionState({
    label: 'Quitter le mode LIDAR',
    title: 'Fermer le visualiseur et revenir à l’application.',
  });

  const routeController = new ViewerRouteController({
    sceneParams: {
      bounds: mesh.bounds,
      crs,
      centerX: cx,
      centerY: cy,
      centerZ: mesh.centerZ,
      heightGrid: mesh.heightGrid,
      gridWidth: mesh.gridWidth,
      gridHeight: mesh.gridHeight,
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
    centerLon,
    centerLat,
    timeZone: tileTimeZone,
    routeController,
    onSlopeChange: (slopeState) => {
      renderer?.setSlopeState(slopeState);
      requestRender();
    },
    onAltitudeChange: (altitudeState) => {
      renderer?.setAltitudeState(altitudeState);
      requestRender();
    },
    onSunlightChange: (sunlightState) => {
      if (!renderer || !sunlightController) return;
      const renderState = sunlightController.compute(sunlightState);
      renderer.setSunlightRenderState(renderState);
      requestRender();
    },
  });

  const manager = opts.lidarManager ?? new LidarManager();

  const tileNavigator = createViewerTileNavigator({
    currentTile: primaryCoord,
    activeTiles: sceneCoords,
    manager,
    onPreviewTile: (coord) => {
      if (!renderer) return;
      if (!coord) {
        renderer.clearPreviewMesh();
        requestRender();
        return;
      }
      const previewMesh = buildTilePreviewMesh(coord, mesh.bounds, {
        heightGrid: mesh.heightGrid,
        gridWidth: mesh.gridWidth,
        gridHeight: mesh.gridHeight,
        vertices: mesh.vertices,
        indices: mesh.indices,
        colors: new Uint8Array(0),
        vertexCount: mesh.vertexCount,
        indexCount: mesh.indexCount,
      });
      renderer.setPreviewMesh(previewMesh.vertices, previewMesh.colors, previewMesh.indices);
      requestRender();
    },
    onSelectTiles: (coords) => {
      const baseUrl = buildViewerUrl(primaryCoord, coords.slice(1));
      const url = new URL(baseUrl, window.location.origin);
      url.searchParams.set('engine', 'webgl');
      window.location.assign(url.toString());
    },
  });

  setStatus('Prêt', 100);
  setTimeout(() => overlay.classList.add('hidden'), 300);

  camera.onChange = () => {
    requestRender();
    routeController.updateOverlay();
  };
  requestRender();

  const handleResize = () => {
    resizeCanvas(canvas, profile.dprCap);
    renderer.resize(canvas.width, canvas.height);
    routeController.updateOverlay();
    requestRender();
  };
  window.addEventListener('resize', handleResize);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) {
      return;
    }
    if (e.key === 'e' || e.key === 'E') {
      const curState = routeController.getState();
      routeController.setEditMode(!curState.editMode);
      return;
    }
    if (e.key === 'n' || e.key === 'N') {
      const nextMode: SnowModeKey = snowMode === 'off'
        ? 'cover'
        : snowMode === 'cover'
          ? 'thickness'
          : 'off';
      void handleSnowModeChange(nextMode);
    }
  };
  window.addEventListener('keydown', handleKeyDown);

  const handleVisibilityChange = () => {
    if (document.hidden) {
      if (frameHandle != null) {
        window.cancelAnimationFrame(frameHandle);
        frameHandle = null;
      }
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
    sunlightController.destroy();
    panel.destroy();
    rightPanel.destroy();
    routeController.destroy();
    tileNavigator.destroy();
  };

  window.addEventListener('pagehide', (ev) => {
    if (!ev.persisted) cleanup();
  });
}
