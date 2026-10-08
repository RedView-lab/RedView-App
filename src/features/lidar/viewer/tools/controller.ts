// ============================================
// Outils du viewer LiDAR — contrôleur
// ============================================
//
// Modèle de saisie (la caméra garde tous les gestes : glisser gauche pour
// tourner, glisser droit pour déplacer, molette pour zoomer) :
//  - un clic droit (sans glisser, appui bref) ouvre le menu contextuel sur le
//    point sous le curseur ; pendant qu'un outil de dessin tourne, il le
//    termine ; pendant que l'éditeur de tracé dessine, il lui est laissé ;
//  - outil actif, un clic gauche pose un sommet (Alt ou Maj : le sol sous la
//    végétation) ou lance l'outil à un point ;
//  - touches : M distance, H hauteur/angle, S surface, P profil, F ligne de
//    chute, A exposition avalanche, V visibilité ; Entrée termine, Retour
//    arrière retire le dernier sommet, Échap annule ;
//  - en dessinant une surface (mesure ou zone de commentaire), un clic sur un
//    sommet déjà posé la ferme sur ce sommet (`shared/lib/polygonClosing`).

import { translateAppText as t } from '@/shared/i18n/config';
import { trackAnalyticsEvent, type LidarTool } from '@/shared/lib/analytics';
import { closePolygonAt, polygonCloseIndex, polygonVertexHit } from '@/shared/lib/polygonClosing';
import type { OpenedLodTile } from '../../lib/lodCache';
import type { CameraController } from '../camera';
import type { SceneNode } from '../lod/sceneLod';
import { fromWgs84 } from '../../lib/coordConvert';
import { projectToScreen, type ProjectedScreenPoint } from '../route/terrainRaycaster';
import type { ViewerRouteSceneParams } from '../route/types';
import type { ViewerRouteController } from '../route/viewerRouteController';
import { readLookAround, resolveLookAroundStart } from './lookAround/lookAround';
import { createMeasurement, MIN_VERTICES } from './measurements/compute';
import { draftLayer, measurementLayer, measurementMesh } from './measurements/layers';
import type { Measurement } from './measurements/types';
import { mergeMeshes, type OverlayMeshData } from './overlay/cellMesh';
import { ToolsOverlay, type OverlayLayer, type Projector } from './overlay/toolsOverlay';
import { AvalancheComputer } from './terrain/avalanche/client';
import { PointCloudPicker } from './picking/pointCloudPicker';
import { ScenePicker } from './picking/scenePicker';
import { toolForKey } from './shortcuts';
import { centerOnPick, faceSlope } from './cameraMoves';
import { readSceneCanopy } from './terrain/pointCloudReads';
import { runAvalancheAnalysis, runFallLineAnalysis, type TerrainAnalysisContext } from './terrain/terrainAnalyses';
import { TerrainField } from './terrain/terrainField';
import { isDrawingTool, type ScenePick, type ToolId, type Vec3 } from './types';
import { ToolsUiStore, type ContextMenuAction, type LookAroundModel, type ToolsUiActions } from './ui/toolsUiStore';
import { mountViewerToolsUi } from './ui/mount';

const LIDAR_TOOL_NAMES: Record<ToolId, LidarTool> = {
  distance: 'distance',
  height: 'height',
  area: 'area',
  profile: 'profile',
  fallLine: 'fall_line',
  avalanche: 'avalanche',
  viewshed: 'viewshed',
  pin: 'pin',
};

/** Mesure d'audience : quel outil du viewer sert (jamais le point visé). */
function trackLidarTool(tool: ToolId): void {
  trackAnalyticsEvent({ name: 'lidar_tool_used', data: { tool: LIDAR_TOOL_NAMES[tool] } });
}
export interface ViewerToolsOptions {
  canvas: HTMLCanvasElement;
  /** Parent du canvas de la scène ; reçoit le canvas de superposition. */
  container: HTMLElement;
  camera: CameraController;
  sceneParams: ViewerRouteSceneParams;
  /** Tuiles LOD de la scène, indexées comme `SceneNode.tileIndex`. */
  tiles: readonly OpenedLodTile[];
  /** Nœuds LOD dessinés par la dernière image. */
  getDrawnNodes: () => readonly SceneNode[];
  /** Le filtre de points affiche cette classe ASPRS. */
  isClassVisible: (classification: number) => boolean;
  /** Diamètre actuel des points, m. */
  getPointSize: () => number;
  routeController: ViewerRouteController;
  setAnalysisMesh: (mesh: OverlayMeshData | null) => void;
  requestRender: () => void;
  /** Les commentaires du projet de l'app peuvent être écrits d'ici (pont vers l'onglet de l'app actif). */
  commentsAvailable?: () => boolean;
  /** « Commenter ici » sur un point de la scène. */
  onComment?: (pick: ScenePick) => void;
  /** « Commenter une zone » dessinée comme une surface : anneau WGS84 et son dernier sommet (ancre de la bulle). */
  onCommentZone?: (ring: Array<[number, number]>, anchor: ScenePick) => void;
}

const CLICK_MOVE_TOLERANCE_PX = 6;
const RIGHT_CLICK_MAX_HOLD_MS = 350;
const LEFT_CLICK_MAX_HOLD_MS = 450;
const NOTICE_MS = 2600;
/** Un clic aussi proche du dernier sommet (double clic) n'en ajoute pas, px CSS. */
const DUPLICATE_VERTEX_PX = 4;

/** Flèches de la vue à la première personne : [pas de lacet, pas de tangage]. */
const LOOK_KEYS: Readonly<Record<string, [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

/** Une seule analyse de chacun de ces types est affichée à la fois (des zones superposées se mélangeraient). */
const SINGLE_INSTANCE_KINDS = new Set<Measurement['kind']>(['avalanche', 'viewshed', 'profile']);

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
  /** Incrémenté à chaque demande d'avalanche : une plus ancienne encore en cours est abandonnée. */
  private avalancheToken = 0;

  private measurements: Measurement[] = [];
  private readonly layers = new Map<string, OverlayLayer>();
  private readonly meshes = new Map<string, OverlayMeshData>();

  private activeTool: ToolId | null = null;
  /** La surface en cours de dessin délimite une zone de commentaire, pas une mesure. */
  private commentZoneDrawing = false;
  /** Contour de la zone de commentaire survolée / ouverte, drapé sur le modèle de terrain. */
  private commentZoneLayer: OverlayLayer | null = null;
  private draft: ScenePick[] = [];
  private hover: ScenePick | null = null;
  /** Surface en cours de dessin : sommet sous le curseur sur lequel un clic la fermerait, ou -1. */
  private closeHoverIndex = -1;
  private profileMarker: Vec3 | null = null;
  private press: PointerPress | null = null;
  private destroyed = false;
  /** Incrémenté à chaque nouvel appui : un picking encore en cours pour un appui plus ancien est abandonné. */
  private pickToken = 0;
  private hoverFrame: number | null = null;
  private hoverPosition: { x: number; y: number } | null = null;
  private noticeTimer: number | null = null;
  /** Sol sous l'œil de la vue à la première personne, m. */
  private lookGroundAltitudeM = 0;
  /** Dernier état du HUD envoyé à React (JSON), pour sauter les mises à jour identiques. */
  private lookHudKey = '';

  /** `null` quand la scène n'a pas de modèle de terrain sur lequel mesurer. */
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
      // L'éditeur de tracé et un outil utilisent tous deux le clic gauche : le dernier lancé l'emporte.
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
   * Couvert de canopée (0–1) de toute la scène sur une grille de nœuds
   * d'espacement d'environ `cellM` sur les bornes du modèle de terrain (entrée
   * du modèle de neige, lu comme la forêt de l'avalanche : retours de
   * végétation haute à plus de 3 m du sol). `null` quand le nuage n'a pas de
   * classification du sol.
   */
  readSceneCanopy(cellM: number): Promise<{ data: Float32Array; width: number; height: number } | null> {
    return readSceneCanopy(this.field, this.pointPicker, cellM);
  }

  // ── Commentaires (lidar/viewer/comments) ──────────────────────────────────

  /** Point du repère de rendu d'une position WGS84 (altitude du MNT quand `altitudeM` est null) ; null hors de la scène. */
  localFromLonLat(lon: number, lat: number, altitudeM: number | null): Vec3 | null {
    const [projX, projY] = fromWgs84(lon, lat, this.field.crs);
    if (!Number.isFinite(projX) || !Number.isFinite(projY) || !this.field.contains(projX, projY)) return null;
    const altitude = altitudeM ?? this.field.altitudeAt(projX, projY);
    return altitude == null ? null : this.field.toLocal(projX, projY, altitude);
  }

  projectLocal(local: Vec3): ProjectedScreenPoint {
    return this.projector()(local);
  }

  /** Le modèle de terrain ne cache pas ce point à la caméra. */
  isLocalVisible(local: Vec3): boolean {
    return this.field.isVisibleFrom(local, [...this.opts.camera.getEye()]);
  }

  /** Dessine (ou efface, avec null) au sol le contour d'une zone de commentaire (anneau WGS84). */
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

  /** Reprojette la superposition ; à appeler une fois par image rendue après un mouvement de caméra. */
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

  // ── Rappels React ──────────────────────────────────────────────────────────

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
          trackLidarTool(action.tool);
          this.runPointTool(action.tool, pick);
        }
        break;
      case 'center':
        this.centerOn(pick);
        break;
      case 'lookAround':
        trackAnalyticsEvent({ name: 'lidar_tool_used', data: { tool: 'look_around' } });
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
        this.startTool('area', this.picker.toGround(pick) ?? undefined, { track: false });
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

  private startTool(tool: ToolId, firstPick?: ScenePick, { track = true }: { track?: boolean } = {}): void {
    if (track) trackLidarTool(tool);
    const route = this.opts.routeController;
    if (route.getState().editMode) route.setEditMode(false);
    // Retour arrière supprimerait aussi un point de tracé sélectionné.
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
      // Un clic sur un sommet posé ferme la surface à cet endroit, sans jamais ajouter de doublon.
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
   * Sommet sur lequel le survol fermerait la surface. Pas le dernier : le
   * curseur s'y trouve juste après l'avoir posé (un second clic termine
   * toujours, comme un double clic, mais l'aperçu clignoterait à chaque sommet).
   */
  private closeIndexForHover(position: { x: number; y: number }): number {
    if (this.activeTool !== 'area') return -1;
    const index = polygonCloseIndex(this.draftScreenPoints(), position, MIN_VERTICES.area);
    return index === this.draft.length - 1 ? -1 : index;
  }

  /** Sommets du brouillon à l'écran (px CSS du canvas), null derrière la caméra. */
  private draftScreenPoints(): Array<{ x: number; y: number } | null> {
    const project = this.projector();
    return this.draft.map((vertex) => {
      const p = project(vertex.local);
      return p.inFront ? { x: p.screenX, y: p.screenY } : null;
    });
  }

  /**
   * Termine le dessin avec `picks` (tout le brouillon, ou la boucle fermée sur
   * un sommet) ; la bulle d'une zone de commentaire va sur `anchor` (par
   * défaut : le dernier sommet).
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

  private async runFallLine(pick: ScenePick): Promise<void> {
    const done = await runFallLineAnalysis(this.analysisContext(() => this.destroyed), pick);
    if (!done) return;
    this.addMeasurement(done.measurement);
    this.notify(done.message);
  }

  private async runAvalanche(pick: ScenePick): Promise<void> {
    const token = ++this.avalancheToken;
    const stale = () => this.destroyed || token !== this.avalancheToken;
    const done = await runAvalancheAnalysis(this.analysisContext(stale), this.avalanche, pick);
    if (!done) return;
    this.addMeasurement(done.measurement);
    this.notify(done.message);
  }

  private analysisContext(isStale: () => boolean): TerrainAnalysisContext {
    return {
      field: this.field,
      pointPicker: this.pointPicker,
      notify: (message, options) => this.notify(message, options),
      isStale,
    };
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

  /** Retire une mesure sans redessiner. */
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

  // ── Vue à la première personne ─────────────────────────────────────────────

  /** Se place au point, l'œil à 1,7 m au-dessus du sol, et regarde autour à 360°. */
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

  /** Cap, champ de vision et cible du réticule du HUD à la première personne (arrondis : pas de remous). */
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
    centerOnPick(this.opts.camera, pick);
  }

  private faceSlope(pick: ScenePick): void {
    faceSlope(this.opts.camera, this.field, pick);
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
    // L'éditeur de tracé réinitialise le curseur à chaque mouvement.
    if (this.activeTool) this.opts.canvas.style.cursor = 'crosshair';
    this.hoverPosition = this.canvasPosition(event.clientX, event.clientY);
    if (this.hoverFrame == null) {
      this.hoverFrame = window.requestAnimationFrame(() => {
        this.hoverFrame = null;
        const position = this.hoverPosition;
        if (!position) return;
        // Le survol d'une mesure déplie son étiquette.
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
    // L'éditeur de tracé termine son mode de dessin sur ce clic.
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
    // Maj aussi bien qu'Alt : la plupart des gestionnaires de fenêtres Linux
    // (KDE, Xfce, Cinnamon) prennent Alt+clic pour déplacer la fenêtre, la page
    // ne le voit donc jamais.
    const pick = await this.picker.pick(x, y, { groundOnly: event.altKey || event.shiftKey });
    if (token !== this.pickToken || !this.activeTool) return;
    if (!pick) {
      this.notify(t('Aucun point sous le curseur'));
      return;
    }
    if (isDrawingTool(this.activeTool)) {
      // Distances, profils et surfaces se mesurent au sol ; l'outil de
      // hauteur garde le retour lui-même (cime d'arbre, bord de falaise).
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
      // Les flèches tournent la tête d'un dixième du champ de vision.
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

  /** Affiche un avis ; un avis `persistent` (travail en cours) reste jusqu'au suivant. */
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
