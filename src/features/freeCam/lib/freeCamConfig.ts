import type { FreeCamConfig } from '../types';

export const DEFAULT_FREECAM_CONFIG: FreeCamConfig = {
  baseSpeedMps: 45,
  zoomSpeed: 2.0,
  mouseSensitivity: 0.16,
  minPitch: 0,
  maxPitch: 85,
  friction: 12.0,
  acceleration: 20.0,
};

export const SPEED_MULTIPLIER_STEPS = [0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0];
