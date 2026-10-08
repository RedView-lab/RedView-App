import type { ProjectedScreenPoint } from './terrainRaycaster';

export interface RouteHandleInfo {
  index: number;
  lat: number;
  lon: number;
  elevationM: number | null;
  distanceM?: number;
  localX: number;
  localY: number;
  localZ: number;
  screenPoint: ProjectedScreenPoint;
  isStart: boolean;
  isEnd: boolean;
  isSelected: boolean;
  isHovered: boolean;
}

export interface InsertGhostHandle {
  segmentIndex: number;
  lat: number;
  lon: number;
  elevationM: number;
  localX: number;
  localY: number;
  localZ: number;
  screenPoint: ProjectedScreenPoint;
}

export interface DraggingHandleInfo {
  index: number;
  currentLat: number;
  currentLon: number;
  currentElevationM: number;
  currentScreenPoint: ProjectedScreenPoint;
  prevScreenPoint: ProjectedScreenPoint | null;
  nextScreenPoint: ProjectedScreenPoint | null;
}

export interface HoverReticleInfo {
  screenX: number;
  screenY: number;
  elevationM: number;
  lastPointScreen?: ProjectedScreenPoint | null;
  groundPoints?: ProjectedScreenPoint[] | null;
  groundPoints3D?: Array<[number, number, number]> | null;
}

export interface RouteHandlesOverlayOptions {
  container: HTMLElement;
  sceneCanvas: HTMLCanvasElement;
}

export class RouteHandlesOverlay {
  private container: HTMLElement;
  private sceneCanvas: HTMLCanvasElement;
  private overlayCanvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private enabled = true;
  /** Le canvas a été effacé pour un rendu vide et rien n'a été dessiné depuis. */
  private clearedEmpty = false;
  public handles: RouteHandleInfo[] = [];
  private ghostHandle: InsertGhostHandle | null = null;
  private draggingHandle: DraggingHandleInfo | null = null;
  private hoverReticle: HoverReticleInfo | null = null;
  public routeColor = '#E53935';

  constructor(opts: RouteHandlesOverlayOptions) {
    this.container = opts.container;
    this.sceneCanvas = opts.sceneCanvas;

    // Créer le canvas de surcouche haute densité
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.className = 'rv-lidar-route-handles-canvas';
    this.overlayCanvas.style.position = 'absolute';
    this.overlayCanvas.style.inset = '0';
    this.overlayCanvas.style.width = '100%';
    this.overlayCanvas.style.height = '100%';
    this.overlayCanvas.style.pointerEvents = 'none';
    this.overlayCanvas.style.zIndex = '15';

    const ctx = this.overlayCanvas.getContext('2d');
    if (!ctx) throw new Error('Failed to create 2D overlay context');
    this.ctx = ctx;

    this.container.appendChild(this.overlayCanvas);
    this.resize();
  }

  public resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = this.sceneCanvas.clientWidth || window.innerWidth;
    const height = this.sceneCanvas.clientHeight || window.innerHeight;

    if (this.overlayCanvas.width !== Math.round(width * dpr) || this.overlayCanvas.height !== Math.round(height * dpr)) {
      this.overlayCanvas.width = Math.round(width * dpr);
      this.overlayCanvas.height = Math.round(height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  public setEditMode(_editMode: boolean): void {
    // Gardé pour la compatibilité de l'API
  }

  public setRouteColor(color: string): void {
    this.routeColor = color || '#E53935';
  }

  public render(
    handles: RouteHandleInfo[],
    ghost: InsertGhostHandle | null,
    dragging: DraggingHandleInfo | null,
    reticle: HoverReticleInfo | null = null,
  ): void {
    this.handles = handles;
    this.ghostHandle = ghost;
    this.draggingHandle = dragging;
    this.hoverReticle = reticle;

    // Rien à dessiner (pas de tracé) : effacer une fois, pas à chaque mouvement de caméra.
    const empty = handles.length === 0 && !ghost && !dragging && !reticle;
    if (empty && this.clearedEmpty) return;
    this.clearedEmpty = empty;

    this.resize();
    const width = this.sceneCanvas.clientWidth || window.innerWidth;
    const height = this.sceneCanvas.clientHeight || window.innerHeight;
    this.ctx.clearRect(0, 0, width, height);

    if (!this.enabled) {
      return;
    }

    // 1) Dessiner le guide élastique pendant qu'un point est glissé
    if (this.draggingHandle) {
      const { currentScreenPoint, prevScreenPoint, nextScreenPoint } = this.draggingHandle;

      this.ctx.save();
      this.ctx.setLineDash([5, 5]);
      this.ctx.lineWidth = 1.8;
      this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';

      if (prevScreenPoint && prevScreenPoint.inFront) {
        this.ctx.beginPath();
        this.ctx.moveTo(prevScreenPoint.screenX, prevScreenPoint.screenY);
        this.ctx.lineTo(currentScreenPoint.screenX, currentScreenPoint.screenY);
        this.ctx.stroke();
      }

      if (nextScreenPoint && nextScreenPoint.inFront) {
        this.ctx.beginPath();
        this.ctx.moveTo(currentScreenPoint.screenX, currentScreenPoint.screenY);
        this.ctx.lineTo(nextScreenPoint.screenX, nextScreenPoint.screenY);
        this.ctx.stroke();
      }

      this.ctx.restore();
    }

    // 2) Dessiner les poignées des nœuds du tracé
    const totalPoints = handles.length;
    const stride = totalPoints > 800 ? Math.ceil(totalPoints / 400) : 1;

    for (let i = 0; i < totalPoints; i++) {
      const handle = handles[i];
      if (!handle || !handle.screenPoint.inFront) continue;

      const isPriority = handle.isStart || handle.isEnd || handle.isSelected || handle.isHovered;
      if (!isPriority && stride > 1 && i % stride !== 0) continue;

      const { screenX, screenY, distance } = handle.screenPoint;
      const baseRadius = handle.isStart || handle.isEnd ? 7.5 : handle.isSelected ? 8.0 : handle.isHovered ? 6.5 : 4.5;
      const radius = Math.max(3.0, Math.min(12.0, baseRadius * (300 / Math.max(100, distance))));

      this.ctx.save();

      // Halo pour la sélection / le survol
      if (handle.isSelected) {
        this.ctx.beginPath();
        this.ctx.arc(screenX, screenY, radius + 5, 0, Math.PI * 2);
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
        this.ctx.fill();

        this.ctx.beginPath();
        this.ctx.arc(screenX, screenY, radius + 2, 0, Math.PI * 2);
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        this.ctx.lineWidth = 1.8;
        this.ctx.stroke();
      } else if (handle.isHovered) {
        this.ctx.beginPath();
        this.ctx.arc(screenX, screenY, radius + 4, 0, Math.PI * 2);
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        this.ctx.fill();
      }

      // Cercle de base de la poignée
      this.ctx.beginPath();
      this.ctx.arc(screenX, screenY, radius, 0, Math.PI * 2);

      if (handle.isSelected) {
        this.ctx.fillStyle = '#FFFFFF';
      } else if (handle.isStart) {
        this.ctx.fillStyle = '#00E676';
      } else if (handle.isEnd) {
        this.ctx.fillStyle = '#FF1744';
      } else {
        this.ctx.fillStyle = '#FFFFFF';
      }

      this.ctx.fill();
      this.ctx.lineWidth = 1.5;
      this.ctx.strokeStyle = '#11141c';
      this.ctx.stroke();

      if (handle.isStart || handle.isEnd) {
        this.ctx.beginPath();
        this.ctx.arc(screenX, screenY, radius * 0.4, 0, Math.PI * 2);
        this.ctx.fillStyle = '#11141c';
        this.ctx.fill();
      }

      this.ctx.restore();
    }

    // 3) Dessiner la poignée fantôme d'insertion sur le segment survolé (point blanc simple et net)
    if (this.ghostHandle && !this.draggingHandle && this.ghostHandle.screenPoint.inFront) {
      const { screenX, screenY } = this.ghostHandle.screenPoint;
      const ghostRadius = 5.0;

      this.ctx.save();

      // Halo blanc doux
      this.ctx.beginPath();
      this.ctx.arc(screenX, screenY, ghostRadius + 3, 0, Math.PI * 2);
      this.ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      this.ctx.fill();

      // Poignée blanche nette
      this.ctx.beginPath();
      this.ctx.arc(screenX, screenY, ghostRadius, 0, Math.PI * 2);
      this.ctx.fillStyle = '#FFFFFF';
      this.ctx.fill();
      this.ctx.strokeStyle = '#181c24';
      this.ctx.lineWidth = 1.4;
      this.ctx.stroke();

      this.ctx.restore();
    }

    // 4) Dessiner la ligne guide vers le curseur en mode tracé/ajout (drapée sur la surface du terrain)
    if (this.hoverReticle && !this.draggingHandle) {
      const { screenX, screenY, lastPointScreen, groundPoints } = this.hoverReticle;

      if (groundPoints && groundPoints.length > 1) {
        this.ctx.save();

        // Ombre de fond à fort contraste
        this.ctx.beginPath();
        this.ctx.setLineDash([5, 4]);
        this.ctx.lineWidth = 3.2;
        this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';

        let started = false;
        for (let i = 0; i < groundPoints.length; i++) {
          const pt = groundPoints[i]!;
          if (pt.inFront) {
            if (!started) {
              this.ctx.moveTo(pt.screenX, pt.screenY);
              started = true;
            } else {
              this.ctx.lineTo(pt.screenX, pt.screenY);
            }
          } else {
            started = false;
          }
        }
        if (started) this.ctx.stroke();

        // Ligne pointillée colorée principale plaquée au sol
        this.ctx.beginPath();
        this.ctx.setLineDash([5, 4]);
        this.ctx.lineWidth = 1.8;
        this.ctx.strokeStyle = this.routeColor || '#FF9800';

        started = false;
        for (let i = 0; i < groundPoints.length; i++) {
          const pt = groundPoints[i]!;
          if (pt.inFront) {
            if (!started) {
              this.ctx.moveTo(pt.screenX, pt.screenY);
              started = true;
            } else {
              this.ctx.lineTo(pt.screenX, pt.screenY);
            }
          } else {
            started = false;
          }
        }
        if (started) this.ctx.stroke();

        this.ctx.restore();
      } else if (lastPointScreen && lastPointScreen.inFront) {
        // Ligne droite de repli si les points du sol ne sont pas disponibles
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.setLineDash([5, 4]);
        this.ctx.lineWidth = 1.8;
        this.ctx.strokeStyle = `${this.routeColor}CC`;
        this.ctx.moveTo(lastPointScreen.screenX, lastPointScreen.screenY);
        this.ctx.lineTo(screenX, screenY);
        this.ctx.stroke();
        this.ctx.restore();
      }
    }
  }

  public destroy(): void {
    if (this.overlayCanvas.parentElement) {
      this.overlayCanvas.parentElement.removeChild(this.overlayCanvas);
    }
    this.handles = [];
    this.ghostHandle = null;
    this.draggingHandle = null;
  }
}
