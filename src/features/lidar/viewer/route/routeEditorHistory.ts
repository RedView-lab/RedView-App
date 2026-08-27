import type { LidarRouteOverlayPoint } from './types';

export class RouteEditorHistory {
  private undoStack: LidarRouteOverlayPoint[][] = [];
  private redoStack: LidarRouteOverlayPoint[][] = [];
  private readonly maxDepth: number;

  constructor(maxDepth = 50) {
    this.maxDepth = maxDepth;
  }

  public get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public push(pointsBefore: LidarRouteOverlayPoint[]): void {
    this.undoStack.push(structuredClone(pointsBefore));
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  public undo(currentPoints: LidarRouteOverlayPoint[]): LidarRouteOverlayPoint[] | null {
    if (this.undoStack.length === 0) return null;
    const previous = this.undoStack.pop()!;
    this.redoStack.push(structuredClone(currentPoints));
    return previous;
  }

  public redo(currentPoints: LidarRouteOverlayPoint[]): LidarRouteOverlayPoint[] | null {
    if (this.redoStack.length === 0) return null;
    const next = this.redoStack.pop()!;
    this.undoStack.push(structuredClone(currentPoints));
    return next;
  }

  public clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
