export type OverlayStatusId = 'map' | 'weather' | 'shadow' | 'itinerary';

export type OverlayStatusState = 'loading' | 'ready' | 'error';

export interface OverlayStatusSnapshot {
  id: OverlayStatusId;
  label: string;
  state: OverlayStatusState;
  progress: number;
  detail?: string;
  reloadable?: boolean;
  nonce?: number;
  updatedAt: number;
}

export type OverlayStatusReporter = (status: OverlayStatusSnapshot | null) => void;

export type OverlayReloadRegistrar = (reload: (() => void) | null) => void;

export function clampOverlayProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function createOverlayStatus(
  status: Omit<OverlayStatusSnapshot, 'progress' | 'updatedAt'> & { progress?: number },
): OverlayStatusSnapshot {
  return {
    ...status,
    progress: clampOverlayProgress(status.progress ?? 0),
    updatedAt: Date.now(),
  };
}