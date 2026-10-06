// ============================================
// LiDAR viewer tools — controller
// ============================================
//
// Input model (the camera keeps every gesture: left drag orbits, right drag
// pans, wheel zooms):
//  - a right click (no drag, short press) opens the context menu on the
//    point under the cursor; while a drawing tool runs it finishes it, while
//    the route editor draws it is left to the route editor;
//  - with a tool active, a left click places a vertex (Alt or Shift: the
//    ground under the vegetation) or runs the one-point tool;
//  - keys: M distance, H height/angle, S area, P profile, F fall line,
//    A avalanche exposure, V viewshed; Enter finishes, Backspace removes the
//    last vertex, Escape cancels;
//  - drawing an area (measurement or comment zone), a click on a vertex
//    already placed closes it on that vertex (`shared/lib/polygonClosing`).

import { translateAppText as t } from '@/shared/i18n/config';
import { closePolygonAt, polygonCloseIndex, polygonVertexHit } from '@/shared/lib/polygonClosing';
import type { OpenedLodTile } from '../../lib/lodCache';
import type { CameraController } from '../camera';
import type { SceneNode } from '../lod/sceneLod';
import { fromWgs84 } from '../../lib/coordConvert';
import { projectToScreen, type ProjectedScreenPoint } from '../route/terrainRaycaster';
import type { ViewerRouteSceneParams } from '../route/types';
import type { ViewerRouteController } from '../route/viewerRouteController';
import { readLookAround, resolveLookAroundStart } from './lookAround/lookAround';
import { createMeasurement, MIN_VERTICES, nextMeasurementId } from './measurements/compute';
import { draftLayer, measurementLayer, measurementMesh } from './measurements/layers';
import type { Measurement } from './measurements/types';
import { mergeMeshes, type OverlayMeshData } from './overlay/cellMesh';
import { ToolsOverlay, type OverlayLayer, type Projector } from './overlay/toolsOverlay';
import { CanopyGridBuilder } from './terrain/avalanche/canopy';
import { AvalancheComputer } from './terrain/avalanche/client';
import { avalancheReadBounds, type AvalancheTerrainResult } from './terrain/avalanche/exposure';
import { PointCloudPicker } from './picking/pointCloudPicker';
import { ScenePicker } from './picking/scenePicker';
import { toolForKey } from './shortcuts';
import { FallCoverBuilder, type CoverBounds, type FallCover } from './terrain/fallCover';
import { computeFallLine, displayedFallScenario, fallLineBounds } from './terrain/fallLine';
import { TerrainField, type AnalysisGrid } from './terrain/terrainField';
import { isDrawingTool, type ScenePick, type ToolId, type Vec3 } from './types';
import { ToolsUiStore, type ContextMenuAction, type LookAroundModel, type ToolsUiActions } from './ui/toolsUiStore';
import { mountViewerToolsUi } from './ui/mount';

export interface ViewerToolsOptions {
  canvas: HTMLCanvasElement;
  /** Parent of the scene canvas; receives the overlay canvas. */
  container: HTMLElement;
  camera: CameraController;
  sceneParams: ViewerRouteSceneParams;
  /** LOD tiles of the scene, indexed like `SceneNode.tileIndex`. */
  tiles: readonly OpenedLodTile[];
  /** LOD nodes drawn by the last frame. */
  getDrawnNodes: () => readonly SceneNode[];
  /** The point filter shows this ASPRS class. */
  isClassVisible: (classification: number) => boolean;
  /** Current point diameter, m. */
  getPointSize: () => number;
  routeController: ViewerRouteController;
  setAnalysisMesh: (mesh: OverlayMeshData | null) => void;
  requestRender: () => void;
  /** Comments of the app project can be written from here (bridge to the app tab live). */
  commentsAvailable?: () => boolean;
  /** « Commenter ici » on a point of the scene. */
  onComment?: (pick: ScenePick) => void;
  /** « Commenter une zone » drawn like an area: WGS84 ring and its last vertex (bubble anchor). */
  onCommentZone?: (ring: Array<[number, number]>, anchor: ScenePick) => void;
}

const CLICK_MOVE_TOLERANCE_PX = 6;
const RIGHT_CLICK_MAX_HOLD_MS = 350;
const LEFT_CLICK_MAX_HOLD_MS = 450;
const NOTICE_MS = 2600;
/** A click this close to the last vertex (double click) adds none, CSS px. */
const DUPLICATE_VERTEX_PX = 4;
/** Baseline of the slope faced by "Face à la pente": the face, not a step in it (m). */
const FACE_SLOPE_BASELINE_M = 20;
/** Below this slope "Face à la pente" looks straight down. */
const FACE_SLOPE_MIN_DEG = 3;

/** Arrow keys of the first-person view: [yaw steps, pitch steps]. */
const LOOK_KEYS: Readonly<Record<string, [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

/** One analysis of each of these kinds is shown at a time (overlapping zones would mix). */
const SINGLE_INSTANCE_KINDS = new Set<Measurement['kind']>(['avalanche', 'viewshed', 'profile']);
/** Ground cover is read this far around the nominal fall lines (the fan spreads), m. */
const FALL_COVER_MARGIN_M = 60;
/** Octree spacing the canopy cover is read at (crowns seen in 2 m columns), m. */
const CANOPY_SPACING_M = 2;

interface PointerPress {
  button: number;
  clientX: number;
  clientY: number;
  time: number;
  moved: boolean;
}

export class ViewerToolsController {
  private readonly opts: ViewerToolsOptions;
  private readonly field: TerrainField;
  private readonly picker: ScenePicker;
  private readonly pointPicker: PointCloudPicker;
  private readonly overlay: ToolsOverlay;
  private readonly store = new ToolsUiStore();
  private readonly unmountUi: () => void;
  private readonly unsubscribeRoute: () => void;
  private readonly avalanche = new AvalancheComputer();
  /** Bumped by every avalanche request: an older one still running is dropped. */
  private avalancheToken = 0;

  private measurements: Measurement[] = [];
  private readonly layers = new Map<string, OverlayLayer>();
  private readonly meshes = new Map<string, OverlayMeshData>();

  private activeTool: ToolId | null = null;
  /** The area being drawn outlines a comment zone, not a measurement. */
  private commentZoneDrawing = false;
  /** Outline of the hovered / open comment zone, draped on the ground model. */
  private commentZoneLayer: OverlayLayer | null = null;
  private draft: ScenePick[] = [];
  private hover: ScenePick | null = null;
  /** Area being drawn: vertex under the cursor a click would close it on, or -1. */
  private closeHoverIndex = -1;
  private profileMarker: Vec3 | null = null;
  private press: PointerPress | null = null;
  private destroyed = false;
  /** Bumped by every new press: a pick still running for an older one is dropped. */
  private pickToken = 0;
  private hoverFrame: number | null = null;
  private hoverPosition: { x: number; y: number } | null = null;
  private noticeTimer: number | null = null;
  /** Ground under the first-person eye, m. */
  private lookGroundAltitudeM = 0;
  /** Last HUD state sent to React (JSON), to skip identical updates. */
  private lookHudKey = '';

  /** `null` when the scene has no ground model to measure on. */
  static create(opts: ViewerToolsOptions): ViewerToolsController | null {
    const field = TerrainField.fromSceneParams(opts.sceneParams);
    return field ? new ViewerToolsController(opts, field) : null;
  }

  private constructor(opts: ViewerToolsOptions, field: TerrainField) {
    this.opts = opts;
    this.field = field;
    this.pointPicker = new PointCloudPicker(opts.tiles, opts.getDrawnNodes, opts.isClassVisible);
    this.picker = new ScenePicker({
      canvas: opts.canvas,
      camera: opts.camera,
      field,
      pointPicker: this.pointPicker,
      getPointSize: opts.getPointSize,
    });
    this.overlay = new ToolsOverlay(opts.container, opts.canvas);
    this.unmountUi = mountViewerToolsUi(this.store, this.uiActions);
    this.unsubscribeRoute = opts.routeController.onStateChange((state) => {
      // The route editor and a tool both use the left click: the last one started wins.
      if (state.editMode && this.activeTool) this.cancelTool();
    });

    opts.canvas.addEventListener('pointerdown', this.onPointerDown);
    opts.canvas.addEventListener('dblclick', this.onDoubleClick);
    opts.canvas.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
  }

  /**
   * Canopy cover (0–1) of the whole scene on a node grid of about `cellM`
   * spacing over the ground model bounds (snow model input, read like the
   * avalanche forest: high-vegetation returns 3 m above the ground). `null`
   * when the cloud carries no ground classification.
   */
  async readSceneCanopy(cellM: number): Promise<{ data: Float32Array; width: number; height: number } | null> {
    const field = this.field;
    const width = Math.max(2, Math.round((field.maxX - field.minX) / cellM) + 1);
    const cell = (field.maxX - field.minX) / (width - 1);
    const height = Math.max(2, Math.round((field.maxY - field.minY) / cell) + 1);
    const grid: AnalysisGrid = {
      width, height, cell, originX: field.minX, originY: field.minY,
      altitude: new Float32Array(0), slopeDeg: new Float32Array(0),
    };
    const builder = new CanopyGridBuilder(field, grid);
    await this.pointPicker.forEachPointToSpacing(builder.bounds, CANOPY_SPACING_M, (x, y, z, cls) => builder.add(x, y, z, cls));
    const cover = builder.finish();
    if (!cover) return null;
    return { data: Float32Array.from(cover.canopyPct, (v) => (Number.isFinite(v) ? v / 100 : 0)), width, height };
  }

  // ── Comments (lidar/viewer/comments) ──────────────────────────────────────

  /** Render-frame point of a WGS84 position (DTM altitude when `altitudeM` is null); null outside the scene. */
  localFromLonLat(lon: number, lat: number, altitudeM: number | null): Vec3 | null {
    const [projX, projY] = fromWgs84(lon, lat, this.field.crs);
    if (!Number.isFinite(projX) || !Number.isFinite(projY) || !this.field.contains(projX, projY)) return null;
    const altitude = altitudeM ?? this.field.altitudeAt(projX, projY);
    return altitude == null ? null : this.field.toLocal(projX, projY, altitude);
  }

  projectLocal(local: Vec3): ProjectedScreenPoint {
    return this.projector()(local);
  }

  /** The ground model does not hide this point from the camera. */
  isLocalVisible(local: Vec3): boolean {
    return this.field.isVisibleFrom(local, [...this.opts.camera.getEye()]);
  }

  /** Draws (or clears, with null) the outline of a comment zone (WGS84 ring) on the ground. */
  setCommentZone(ring: ReadonlyArray<[number, number]> | null): void {
    if (!ring || ring.length < 3) {
      if (!this.commentZoneLayer) return;
      this.commentZoneLayer = null;
      this.updateOverlay();
      return;
    }
    const vertices = ring.map(([lon, lat]) => {
      const [projX, projY] = fromWgs84(lon, lat, this.field.crs);
      return { projX, projY };
    });
    const draped = this.field.drape([...vertices, vertices[0]], Math.max(2, this.field.cell));
    const points = draped.map((sample) => this.field.toLocal(sample.projX, sample.projY, sample.altitudeM + 0.5));
    this.commentZoneLayer = points.length >= 2
      ? { id: '', paths: [{ points, color: '#c50000', width: 2.5 }], dots: [], labels: [] }
      : null;
    this.updateOverlay();
  }

  centerOnLocal(local: Vec3): void {
    const { camera } = this.opts;
    const eye = camera.getEye();
    const distance = Math.hypot(eye[0] - local[0], eye[1] - local[1], eye[2] - local[2]);
    camera.animateTo({ targetX: local[0], targetY: local[1], targetZ: local[2], radius: Math.max(60, Math.min(distance, camera.sceneRadius)) });
  }

  /** Reprojects the overlay; call once per rendered frame after a camera move. */
  updateOverlay(): void {
    const layers: OverlayLayer[] = [...this.layers.values()];
    if (this.commentZoneLayer) layers.push(this.commentZoneLayer);
    if (this.activeTool) layers.push(draftLayer(this.activeTool, this.draft, this.hover, this.closeHoverIndex));
    if (this.profileMarker) {
      layers.push({ id: '', paths: [], dots: [{ at: this.profileMarker, color: '#ff2a1f', radius: 5 }], labels: [] });
    }
    const eye: Vec3 = [...this.opts.camera.getEye()];
    this.overlay.render(layers, this.projector(), (v) => this.field.isVisibleFrom(v, eye));
    this.syncLookAroundHud();
  }

  destroy(): void {
    this.destroyed = true;
    const { canvas } = this.opts;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('dblclick', this.onDoubleClick);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    if (this.hoverFrame != null) window.cancelAnimationFrame(this.hoverFrame);
    if (this.noticeTimer != null) window.clearTimeout(this.noticeTimer);
    this.unsubscribeRoute();
    this.unmountUi();
    this.avalanche.destroy();
    this.overlay.destroy();
    this.opts.setAnalysisMesh(null);
  }

  // ── React callbacks ────────────────────────────────────────────────────────

  private readonly uiActions: ToolsUiActions = {
    onMenuAction: (action) => this.runMenuAction(action),
    closeMenu: () => this.store.update({ menu: null }),
    cancelTool: () => this.cancelTool(),
    closeProfile: () => {
      const profile = this.store.getState().profile;
      if (profile) this.removeMeasurement(profile.id);
    },
    hoverProfile: (index) => {
      const profile = this.store.getState().profile;
      const sample = index != null ? profile?.profile.samples[index] : undefined;
      this.profileMarker = sample ? this.field.toLocal(sample.projX, sample.projY, sample.altitudeM + 0.4) : null;
      this.updateOverlay();
    },
    notify: (message) => this.notify(message),
    setLookFov: (fovDeg) => this.opts.camera.setLookGoal({ fovX: (fovDeg * Math.PI) / 180 }),
    exitLookAround: () => this.exitLookAround(),
  };

  private runMenuAction(action: ContextMenuAction): void {
    const menu = this.store.getState().menu;
    this.store.update({ menu: null });
    if (!menu) return;
    const { pick } = menu;
    switch (action.type) {
      case 'tool':
        if (isDrawingTool(action.tool)) {
          this.startTool(action.tool, action.tool === 'height' ? pick : this.picker.toGround(pick) ?? undefined);
        } else {
          this.runPointTool(action.tool, pick);
        }
        break;
      case 'center':
        this.centerOn(pick);
        break;
      case 'lookAround':
        this.enterLookAround(pick);
        break;
      case 'faceSlope':
        this.faceSlope(pick);
        break;
      case 'route':
        this.opts.routeController.placePoint(action.position, {
          lat: pick.lat,
          lon: pick.lon,
          elevationM: pick.groundAltitudeM ?? pick.altitudeM,
        });
        break;
      case 'comment':
        this.opts.onComment?.(pick);
        break;
      case 'commentZone':
        this.startTool('area', this.picker.toGround(pick) ?? undefined);
        this.commentZoneDrawing = true;
        this.store.update({ commentZone: true });
        break;
      case 'deleteMeasurement':
        this.removeMeasurement(action.id);
        break;
      case 'clearMeasurements':
        this.clearMeasurements();
        break;
    }
  }

  // ── Tools ──────────────────────────────────────────────────────────────────

  private startTool(tool: ToolId, firstPick?: ScenePick): void {
    const route = this.opts.routeController;
    if (route.getState().editMode) route.setEditMode(false);
    // Backspace would also delete a selected route point.
    route.setSelectedPointIndex(null);
    this.store.update({ menu: null });
    this.activeTool = tool;
    this.commentZoneDrawing = false;
    this.draft = firstPick && isDrawingTool(tool) ? [firstPick] : [];
    this.closeHoverIndex = -1;
    this.store.update({ activeTool: tool, vertexCount: this.draft.length, commentZone: false });
    this.opts.canvas.style.cursor = 'crosshair';
    this.updateOverlay();
  }

  private cancelTool(): void {
    if (!this.activeTool) return;
    this.activeTool = null;
    this.commentZoneDrawing = false;
    this.draft = [];
    this.hover = null;
    this.closeHoverIndex = -1;
    this.store.update({ activeTool: null, vertexCount: 0, commentZone: false });
    this.opts.canvas.style.cursor = '';
    this.updateOverlay();
  }

  private addVertex(pick: ScenePick, canvasX: number, canvasY: number): void {
    if (this.activeTool === 'area') {
      // A click on a placed vertex closes the area there, never adds a duplicate.
      const click = { x: canvasX, y: canvasY };
      const screen = this.draftScreenPoints();
      const closeIndex = polygonCloseIndex(screen, click, MIN_VERTICES.area);
      if (closeIndex >= 0) {
        this.finishDrawing(closePolygonAt(this.draft, closeIndex), this.draft[closeIndex]);
        return;
      }
      if (polygonVertexHit(screen, click) >= 0) return;
    }
    const last = this.draft[this.draft.length - 1];
    if (last) {
      const p = this.projector()(last.local);
      if (p.inFront && Math.hypot(p.screenX - canvasX, p.screenY - canvasY) <= DUPLICATE_VERTEX_PX) return;
    }
    this.draft.push(pick);
    this.closeHoverIndex = -1;
    this.store.update({ vertexCount: this.draft.length });
    if (this.activeTool === 'height' && this.draft.length >= 2) {
      this.finishDrawing();
      return;
    }
    this.updateOverlay();
  }

  private removeLastVertex(): void {
    if (this.draft.length === 0) return;
    this.draft.pop();
    this.closeHoverIndex = -1;
    this.store.update({ vertexCount: this.draft.length });
    this.updateOverlay();
  }

  /**
   * Vertex the hover would close the area on. Not the last one: the cursor
   * sits there right after placing it (a second click still finishes, like a
   * double click, but the preview would flash at every vertex).
   */
  private closeIndexForHover(position: { x: number; y: number }): number {
    if (this.activeTool !== 'area') return -1;
    const index = polygonCloseIndex(this.draftScreenPoints(), position, MIN_VERTICES.area);
    return index === this.draft.length - 1 ? -1 : index;
  }

  /** Draft vertices on screen (canvas CSS px), null behind the camera. */
  private draftScreenPoints(): Array<{ x: number; y: number } | null> {
    const project = this.projector();
    return this.draft.map((vertex) => {
      const p = project(vertex.local);
      return p.inFront ? { x: p.screenX, y: p.screenY } : null;
    });
  }

  /**
   * Ends the drawing with `picks` (the whole draft, or the loop closed on a
   * vertex); a comment zone's bubble goes on `anchor` (default: last vertex).
   */
  private finishDrawing(picks: ScenePick[] = this.draft, anchor?: ScenePick): void {
    const tool = this.activeTool;
    if (!tool || !isDrawingTool(tool)) return;
    const commentZone = this.commentZoneDrawing;
    this.activeTool = null;
    this.commentZoneDrawing = false;
    this.draft = [];
    this.hover = null;
    this.closeHoverIndex = -1;
    this.store.update({ activeTool: null, vertexCount: 0, commentZone: false });
    this.opts.canvas.style.cursor = '';
    if (commentZone) {
      if (picks.length >= MIN_VERTICES.area) this.opts.onCommentZone?.(picks.map((p) => [p.lon, p.lat]), anchor ?? picks[picks.length - 1]!);
      else if (picks.length > 0) this.notify(t('Zone annulée : pas assez de points'));
      this.updateOverlay();
      return;
    }
    if (picks.length < MIN_VERTICES[tool]) {
      if (picks.length > 0) this.notify(t('Mesure annulée : pas assez de points'));
      this.updateOverlay();
      return;
    }
    const measurement = createMeasurement(tool, picks, this.field);
    if (measurement) this.addMeasurement(measurement);
    else this.notify(t('Hors de la zone chargée'));
    this.updateOverlay();
  }

  private runPointTool(tool: ToolId, pick: ScenePick): void {
    this.cancelTool();
    if (tool === 'fallLine') {
      void this.runFallLine(pick);
      return;
    }
    if (tool === 'avalanche') {
      void this.runAvalanche(pick);
      return;
    }
    const measurement = createMeasurement(tool, [pick], this.field);
    if (!measurement) {
      this.notify(t('Hors de la zone chargée'));
      return;
    }
    this.addMeasurement(measurement);
  }

  /**
   * Fall line: nominal trajectories first (they bound the ground cover read
   * from the point cloud), then the whole fan over that cover.
   */
  private async runFallLine(pick: ScenePick): Promise<void> {
    const field = this.field;
    const stale = () => this.destroyed;
    const yieldToPage = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    this.notify(t('Calcul de la ligne de pente…'));
    const preview = await computeFallLine(field, pick.projX, pick.projY, { runs: 1 });
    if (stale()) return;
    if (!preview) {
      this.notify(t('Hors de la zone chargée'));
      return;
    }
    const cover = await this.readFallCover(fallLineBounds(preview, FALL_COVER_MARGIN_M));
    if (stale()) return;
    const result = await computeFallLine(field, pick.projX, pick.projY, { cover, yieldToPage });
    if (stale() || !result) return;
    this.addMeasurement({ id: nextMeasurementId(), kind: 'fallLine', origin: pick, result, scenario: displayedFallScenario(result) });
    this.notify(result.scenarios.every((s) => s.end === 'noSlide')
      ? t('Pente trop faible : rien ne glisse ici')
      : t('Ligne de pente calculée'));
  }

  /**
   * Avalanche terrain exposure (AutoATES chain, see terrain/avalanche): the
   * canopy cover is read from the point cloud here, the model runs in a worker.
   */
  private async runAvalanche(pick: ScenePick): Promise<void> {
    const token = ++this.avalancheToken;
    const stale = () => this.destroyed || token !== this.avalancheToken;
    const field = this.field;
    const grid = field.getAvalancheGrid();
    this.notify(t('Calcul de l’exposition avalanche…'), { persistent: true });
    const canopy = new CanopyGridBuilder(field, grid);
    const bounds = avalancheReadBounds(grid, pick.projX, pick.projY);
    let forestRead = true;
    try {
      await this.pointPicker.forEachPointToSpacing(bounds, CANOPY_SPACING_M, (x, y, z, cls) => canopy.add(x, y, z, cls));
    } catch (error) {
      console.warn('[LiDAR tools] Canopy read failed:', error);
      forestRead = false;
    }
    if (stale()) return;
    const cover = forestRead ? canopy.finish() : null;
    let result: AvalancheTerrainResult | null;
    try {
      result = await this.avalanche.compute(`${grid.width}x${grid.height}@${grid.originX},${grid.originY}/${grid.cell}`, {
        grid: {
          width: grid.width,
          height: grid.height,
          cell: grid.cell,
          originX: grid.originX,
          originY: grid.originY,
          altitude: grid.altitude,
          slopeDeg: grid.slopeDeg,
        },
        canopyPct: cover?.canopyPct ?? null,
        projX: pick.projX,
        projY: pick.projY,
      });
    } catch (error) {
      if (stale()) return;
      console.warn('[LiDAR tools] Avalanche exposure failed:', error);
      this.notify(t('Calcul de l’exposition avalanche impossible'));
      return;
    }
    if (stale()) return;
    if (!result) {
      this.notify(t('Hors de la zone chargée'));
      return;
    }
    this.addMeasurement({ id: nextMeasurementId(), kind: 'avalanche', origin: pick, result });
    this.notify(t('Exposition avalanche calculée'));
  }

  /** Trees, buildings and water around a fall line, from the drawn LiDAR returns; `null` on failure. */
  private async readFallCover(bounds: CoverBounds): Promise<FallCover | null> {
    const field = this.field;
    const clipped: CoverBounds = {
      minX: Math.max(field.minX, bounds.minX),
      minY: Math.max(field.minY, bounds.minY),
      maxX: Math.min(field.maxX, bounds.maxX),
      maxY: Math.min(field.maxY, bounds.maxY),
    };
    const builder = new FallCoverBuilder(field, clipped);
    try {
      // Render frame: x east, y up, z = −north.
      await this.pointPicker.forEachPointInBox(
        {
          minX: clipped.minX - field.centerX,
          maxX: clipped.maxX - field.centerX,
          minZ: field.centerY - clipped.maxY,
          maxZ: field.centerY - clipped.minY,
        },
        (x, y, z, cls) => builder.add(x + field.centerX, field.centerY - z, y + field.centerZ, cls),
      );
    } catch (error) {
      console.warn('[LiDAR tools] Ground cover read failed:', error);
      return null;
    }
    return builder.finish();
  }

  // ── Measurements ───────────────────────────────────────────────────────────

  private addMeasurement(measurement: Measurement): void {
    if (SINGLE_INSTANCE_KINDS.has(measurement.kind)) {
      for (const old of this.measurements.filter((m) => m.kind === measurement.kind)) this.dropMeasurement(old.id);
    }
    this.measurements.push(measurement);
    this.layers.set(measurement.id, measurementLayer(measurement, this.field));
    const mesh = measurementMesh(measurement, this.field);
    if (mesh) {
      this.meshes.set(measurement.id, mesh);
      this.syncMeshes();
    }
    if (measurement.kind === 'profile') {
      this.store.update({ profile: { id: measurement.id, profile: measurement.profile } });
    }
    this.updateOverlay();
  }

  private removeMeasurement(id: string): void {
    this.dropMeasurement(id);
    this.syncMeshes();
    this.updateOverlay();
  }

  private clearMeasurements(): void {
    for (const m of [...this.measurements]) this.dropMeasurement(m.id);
    this.syncMeshes();
    this.updateOverlay();
  }

  /** Removes a measurement without redrawing. */
  private dropMeasurement(id: string): void {
    this.measurements = this.measurements.filter((m) => m.id !== id);
    this.layers.delete(id);
    this.meshes.delete(id);
    if (this.store.getState().profile?.id === id) {
      this.profileMarker = null;
      this.store.update({ profile: null });
    }
  }

  private syncMeshes(): void {
    this.opts.setAnalysisMesh(mergeMeshes([...this.meshes.values()]));
    this.opts.requestRender();
  }

  // ── Camera ─────────────────────────────────────────────────────────────────

  // ── First-person view ──────────────────────────────────────────────────────

  /** Stands at the point, eye 1.7 m above the ground, looking around over 360°. */
  private enterLookAround(pick: ScenePick): void {
    const start = resolveLookAroundStart(this.field, this.opts.camera, pick);
    if (!start) {
      this.notify(t('Hors de la zone chargée'));
      return;
    }
    this.lookGroundAltitudeM = start.groundAltitudeM;
    this.opts.camera.enterLook(start.eye, { yaw: start.yaw, pitch: start.pitch, fovX: start.fovX });
    this.syncLookAroundHud();
  }

  private exitLookAround(): void {
    this.opts.camera.exitLook();
    this.syncLookAroundHud();
  }

  /** Heading, field of view and reticle target of the first-person HUD (rounded: no churn). */
  private syncLookAroundHud(): void {
    const { camera } = this.opts;
    if (camera.getMode() !== 'look') {
      this.lookHudKey = '';
      this.store.update({ lookAround: null });
      return;
    }
    const readout = readLookAround(this.field, camera);
    const model: LookAroundModel = {
      groundAltitudeM: this.lookGroundAltitudeM,
      headingDeg: Math.round(readout.headingDeg) % 360,
      pitchDeg: Math.round(readout.pitchDeg),
      fovDeg: Math.round(readout.fovDeg * 10) / 10,
      target: readout.target
        ? {
            distanceM: Math.round(readout.target.distanceM),
            altitudeM: Math.round(readout.target.altitudeM),
            elevationDeg: Math.round(readout.target.elevationDeg * 10) / 10,
          }
        : null,
    };
    const key = JSON.stringify(model);
    if (key === this.lookHudKey) return;
    this.lookHudKey = key;
    this.store.update({ lookAround: model });
  }

  private centerOn(pick: ScenePick): void {
    const { camera } = this.opts;
    const eye = camera.getEye();
    const distance = Math.hypot(eye[0] - pick.local[0], eye[1] - pick.local[1], eye[2] - pick.local[2]);
    camera.animateTo({
      targetX: pick.local[0],
      targetY: pick.local[1],
      targetZ: pick.local[2],
      radius: Math.max(30, Math.min(distance, camera.sceneRadius * 2)),
    });
  }

  /**
   * Looks at the slope along its normal: a face seen from below looks
   * steeper, from above flatter; seen square it shows its true shape.
   */
  private faceSlope(pick: ScenePick): void {
    const slope = this.field.slopeAt(pick.projX, pick.projY, FACE_SLOPE_BASELINE_M)
      ?? this.field.slopeAt(pick.projX, pick.projY);
    if (!slope) return;
    const { camera } = this.opts;
    const ground = this.field.toLocal(pick.projX, pick.projY, pick.groundAltitudeM ?? pick.altitudeM);
    // Ground normal (−∂z/∂x, −∂z/∂y, 1) in the render frame (x east, y up, z = −north).
    const nx = -slope.gradX;
    const ny = 1;
    const nz = slope.gradY;
    const length = Math.hypot(nx, ny, nz);
    const flat = slope.slopeDeg < FACE_SLOPE_MIN_DEG;
    const eye = camera.getEye();
    const distance = Math.hypot(eye[0] - ground[0], eye[1] - ground[1], eye[2] - ground[2]);
    camera.animateTo({
      targetX: ground[0],
      targetY: ground[1],
      targetZ: ground[2],
      phi: flat ? 0.15 : Math.acos(ny / length),
      theta: flat ? undefined : Math.atan2(nx / length, nz / length),
      radius: Math.max(120, Math.min(500, distance)),
    });
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private canvasPosition(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.opts.canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pickToken++;
    this.press = {
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
      time: performance.now(),
      moved: false,
    };
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const press = this.press;
    if (press && Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) > CLICK_MOVE_TOLERANCE_PX) {
      press.moved = true;
    }
    if (event.buttons !== 0 || event.target !== this.opts.canvas) return;
    // The route editor resets the cursor on every move.
    if (this.activeTool) this.opts.canvas.style.cursor = 'crosshair';
    this.hoverPosition = this.canvasPosition(event.clientX, event.clientY);
    if (this.hoverFrame == null) {
      this.hoverFrame = window.requestAnimationFrame(() => {
        this.hoverFrame = null;
        const position = this.hoverPosition;
        if (!position) return;
        // Hovering a measurement expands its label.
        const hovered = this.activeTool ? null : this.overlay.hitTest(position.x, position.y);
        const hoverChanged = hovered !== this.overlay.hoveredId;
        this.overlay.hoveredId = hovered;
        if (this.activeTool) {
          this.hover = this.picker.pickTerrain(position.x, position.y);
          this.closeHoverIndex = this.closeIndexForHover(position);
          this.opts.canvas.style.cursor = this.closeHoverIndex >= 0 ? 'pointer' : 'crosshair';
          this.updateOverlay();
        } else if (hoverChanged) {
          this.updateOverlay();
        }
      });
    }
  };

  private readonly onPointerLeave = (): void => {
    this.hoverPosition = null;
    if (this.hover || this.overlay.hoveredId || this.closeHoverIndex >= 0) {
      this.hover = null;
      this.closeHoverIndex = -1;
      this.overlay.hoveredId = null;
      this.updateOverlay();
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const press = this.press;
    if (!press || press.button !== event.button) return;
    this.press = null;
    const held = performance.now() - press.time;
    const click = !press.moved
      && Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) <= CLICK_MOVE_TOLERANCE_PX;
    if (!click) return;
    if (event.button === 2 && held <= RIGHT_CLICK_MAX_HOLD_MS) this.onRightClick(event);
    else if (event.button === 0 && held <= LEFT_CLICK_MAX_HOLD_MS && this.activeTool) void this.onLeftClick(event);
  };

  private onRightClick(event: PointerEvent): void {
    // The route editor ends its drawing mode on this click.
    if (this.opts.routeController.getState().editMode) return;
    if (this.activeTool) {
      if (isDrawingTool(this.activeTool)) this.finishDrawing();
      else this.cancelTool();
      return;
    }
    void this.openMenu(event.clientX, event.clientY);
  }

  private async onLeftClick(event: PointerEvent): Promise<void> {
    const token = this.pickToken;
    const { x, y } = this.canvasPosition(event.clientX, event.clientY);
    // Shift as well as Alt: most Linux window managers (KDE, Xfce, Cinnamon)
    // take Alt+click to move the window, so the page never sees it.
    const pick = await this.picker.pick(x, y, { groundOnly: event.altKey || event.shiftKey });
    if (token !== this.pickToken || !this.activeTool) return;
    if (!pick) {
      this.notify(t('Aucun point sous le curseur'));
      return;
    }
    if (isDrawingTool(this.activeTool)) {
      // Distances, profiles and areas are measured on the ground; the
      // height tool keeps the return itself (tree top, cliff edge).
      const vertex = this.activeTool === 'height' ? pick : this.picker.toGround(pick);
      if (vertex) this.addVertex(vertex, x, y);
      else this.notify(t('Hors de la zone chargée'));
    } else {
      this.runPointTool(this.activeTool, pick);
    }
  }

  private readonly onDoubleClick = (): void => {
    if (this.activeTool && isDrawingTool(this.activeTool)) this.finishDrawing();
  };

  private async lookAroundAtCursor(): Promise<void> {
    const position = this.hoverPosition;
    if (!position) return;
    const pick = await this.picker.pick(position.x, position.y);
    if (pick) this.enterLookAround(pick);
    else this.notify(t('Aucun point sous le curseur'));
  }

  private async openMenu(clientX: number, clientY: number): Promise<void> {
    const token = this.pickToken;
    const { x, y } = this.canvasPosition(clientX, clientY);
    const pick = await this.picker.pick(x, y);
    if (token !== this.pickToken || !pick) return;
    const route = this.opts.routeController.getActiveRoute();
    this.store.update({
      menu: {
        clientX,
        clientY,
        pick,
        slope: this.field.slopeAt(pick.projX, pick.projY),
        crs: this.field.crs,
        measurementId: this.overlay.hitTest(x, y),
        measurementCount: this.measurements.length,
        routeHasStart: (route?.points.length ?? 0) > 0,
        commentsEnabled: this.opts.commentsAvailable?.() ?? false,
      },
    });
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target;
    if (
      target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }
    const { camera } = this.opts;
    const looking = camera.getMode() === 'look';
    if (event.key === 'Escape') {
      if (this.store.getState().menu) this.store.update({ menu: null });
      else if (this.activeTool) this.cancelTool();
      else if (looking) this.exitLookAround();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (looking && LOOK_KEYS[event.key]) {
      // Arrows turn the head by a tenth of the field of view.
      event.preventDefault();
      const [yawSteps, pitchSteps] = LOOK_KEYS[event.key]!;
      const goal = camera.getLookGoal();
      camera.setLookGoal({ yaw: goal.yaw + yawSteps * goal.fovX * 0.1, pitch: goal.pitch + pitchSteps * camera.getFovY() * 0.1 });
      return;
    }
    if ((event.key === 'o' || event.key === 'O') && !event.repeat) {
      if (looking) this.exitLookAround();
      else void this.lookAroundAtCursor();
      return;
    }
    const drawing = this.activeTool != null && isDrawingTool(this.activeTool);
    if (event.key === 'Enter' && drawing) {
      event.preventDefault();
      this.finishDrawing();
      return;
    }
    if (event.key === 'Backspace' && drawing && this.draft.length > 0) {
      event.preventDefault();
      this.removeLastVertex();
      return;
    }
    const tool = toolForKey(event.key);
    if (!tool || event.repeat) return;
    if (this.activeTool === tool) this.cancelTool();
    else this.startTool(tool);
  };

  // ── Helpers ────────────────────────────────────────────────────────────────

  private projector(): Projector {
    const { canvas, camera } = this.opts;
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    const view = camera.getViewMatrix();
    const proj = camera.getProjMatrix();
    return (v) => projectToScreen(v[0], v[1], v[2], width, height, view, proj);
  }

  /** Shows a notice; a `persistent` one (work in progress) stays until the next. */
  private notify(message: string, { persistent = false }: { persistent?: boolean } = {}): void {
    if (this.noticeTimer != null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    this.store.update({ notice: message });
    if (persistent) return;
    this.noticeTimer = window.setTimeout(() => {
      this.noticeTimer = null;
      this.store.update({ notice: null });
    }, NOTICE_MS);
  }
}
