// ============================================
// LiDAR viewer tools — UI state (context menu, tool hint, profile card)
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
  /** Comments of the app project (lidar/viewer/comments). */
  | { type: 'comment' }
  | { type: 'commentZone' }
  | { type: 'deleteMeasurement'; id: string }
  | { type: 'clearMeasurements' };

export interface ContextMenuModel {
  /** Viewport position of the click, CSS px. */
  clientX: number;
  clientY: number;
  pick: ScenePick;
  slope: SlopeSample | null;
  crs: DetectedCrs;
  /** Measurement under the cursor (its label or a vertex). */
  measurementId: string | null;
  measurementCount: number;
  /** The active route already has a start (waypoint / finish offered). */
  routeHasStart: boolean;
  /** The app project is open in RedView: comments can be added from here. */
  commentsEnabled: boolean;
}

export interface ProfileCardModel {
  id: string;
  profile: ProfileResult;
}

/** First-person view state shown by its HUD. */
export interface LookAroundModel extends LookAroundReadout {
  /** Ground altitude under the eye, m. */
  groundAltitudeM: number;
}

export interface ToolsUiState {
  menu: ContextMenuModel | null;
  activeTool: ToolId | null;
  /** Vertices placed by the active drawing tool. */
  vertexCount: number;
  profile: ProfileCardModel | null;
  /** Short transient message (copied, out of the loaded area…). */
  notice: string | null;
  lookAround: LookAroundModel | null;
  /** The area tool outlines a comment zone. */
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

/** Callbacks of the React layer into the tools controller. */
export interface ToolsUiActions {
  onMenuAction(action: ContextMenuAction): void;
  closeMenu(): void;
  cancelTool(): void;
  closeProfile(): void;
  /** Hovered profile sample (3D marker), `null` when the pointer leaves the chart. */
  hoverProfile(sampleIndex: number | null): void;
  notify(message: string): void;
  /** Horizontal field of view of the first-person view, degrees. */
  setLookFov(fovDeg: number): void;
  exitLookAround(): void;
}
