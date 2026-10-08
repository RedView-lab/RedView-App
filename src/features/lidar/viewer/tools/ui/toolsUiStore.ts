// ============================================
// Outils du viewer LiDAR — état de l'interface (menu contextuel, indication d'outil, carte de profil)
// ============================================

import type { LookAroundReadout } from '../lookAround/lookAround';
import type { ProfileResult } from '../terrain/profile';
import type { SlopeSample } from '../terrain/terrainField';
import type { DetectedCrs } from '../../../types';
import type { ScenePick, ToolId } from '../types';

type RoutePlacement = 'start' | 'waypoint' | 'end';

export type ContextMenuAction =
  | { type: 'tool'; tool: ToolId }
  | { type: 'center' }
  | { type: 'faceSlope' }
  | { type: 'lookAround' }
  | { type: 'route'; position: RoutePlacement }
  /** Commentaires du projet de l'app (lidar/viewer/comments). */
  | { type: 'comment' }
  | { type: 'commentZone' }
  | { type: 'deleteMeasurement'; id: string }
  | { type: 'clearMeasurements' };

export interface ContextMenuModel {
  /** Position du clic dans la fenêtre, px CSS. */
  clientX: number;
  clientY: number;
  pick: ScenePick;
  slope: SlopeSample | null;
  crs: DetectedCrs;
  /** Mesure sous le curseur (son étiquette ou un sommet). */
  measurementId: string | null;
  measurementCount: number;
  /** Le tracé actif a déjà un départ (étape / arrivée proposées). */
  routeHasStart: boolean;
  /** Le projet de l'app est ouvert dans RedView : des commentaires peuvent être ajoutés d'ici. */
  commentsEnabled: boolean;
}

export interface ProfileCardModel {
  id: string;
  profile: ProfileResult;
}

/** État de la vue à la première personne affiché par son HUD. */
export interface LookAroundModel extends LookAroundReadout {
  /** Altitude du sol sous l'œil, m. */
  groundAltitudeM: number;
}

export interface ToolsUiState {
  menu: ContextMenuModel | null;
  activeTool: ToolId | null;
  /** Sommets posés par l'outil de dessin actif. */
  vertexCount: number;
  profile: ProfileCardModel | null;
  /** Court message transitoire (copié, hors de la zone chargée…). */
  notice: string | null;
  lookAround: LookAroundModel | null;
  /** L'outil surface délimite une zone de commentaire. */
  commentZone: boolean;
}

export class ToolsUiStore {
  private state: ToolsUiState = { menu: null, activeTool: null, vertexCount: 0, profile: null, notice: null, lookAround: null, commentZone: false };
  private readonly listeners = new Set<() => void>();

  getState = (): ToolsUiState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(patch: Partial<ToolsUiState>): void {
    let changed = false;
    for (const key of Object.keys(patch) as Array<keyof ToolsUiState>) {
      if (this.state[key] !== patch[key]) changed = true;
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** Rappels de la couche React vers le contrôleur des outils. */
export interface ToolsUiActions {
  onMenuAction(action: ContextMenuAction): void;
  closeMenu(): void;
  cancelTool(): void;
  closeProfile(): void;
  /** Échantillon de profil survolé (marqueur 3D), `null` quand le pointeur quitte le graphique. */
  hoverProfile(sampleIndex: number | null): void;
  notify(message: string): void;
  /** Champ de vision horizontal de la vue à la première personne, degrés. */
  setLookFov(fovDeg: number): void;
  exitLookAround(): void;
}
