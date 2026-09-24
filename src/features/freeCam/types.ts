export type FreeCamMode = '3d' | 'plan';

export interface FreeCamTelemetry {
  isActive: boolean;
  isPointerLocked: boolean;
  mode: FreeCamMode;
  zoom: number;
  pitch: number;
  bearing: number;
  speedMultiplier: number;
  altitudeM: number | null;
  coordinates: [number, number];
}

export interface FreeCamConfig {
  /** Base horizontal speed in meters/second at zoom level 16 */
  baseSpeedMps: number;
  /** Vertical zoom levels traversed per second */
  zoomSpeed: number;
  /** Mouse rotation sensitivity in degrees per screen pixel */
  mouseSensitivity: number;
  /** Minimum camera pitch in 3D mode (0 = looking down) */
  minPitch: number;
  /** Maximum camera pitch in 3D mode (up to 85° looking towards horizon) */
  maxPitch: number;
  /** Physics velocity damping/friction rate (0 to 1, higher = stops faster) */
  friction: number;
  /** Acceleration factor */
  acceleration: number;
}

export interface UseFreeCamOptions {
  config?: Partial<FreeCamConfig>;
  onActiveChange?: (active: boolean) => void;
  onModeChange?: (mode: FreeCamMode) => void;
}

export interface UseFreeCamReturn {
  isActive: boolean;
  isPointerLocked: boolean;
  mode: FreeCamMode;
  speedMultiplier: number;
  telemetry: FreeCamTelemetry;
  toggleFreeCam: () => void;
  enableFreeCam: () => void;
  disableFreeCam: () => void;
  toggleMode: () => void;
  setMode: (mode: FreeCamMode) => void;
  requestPointerLock: () => void;
  exitPointerLock: () => void;
  setSpeedMultiplier: (speed: number | ((prev: number) => number)) => void;
  increaseSpeed: () => void;
  decreaseSpeed: () => void;
}
