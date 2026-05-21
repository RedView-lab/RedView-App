export interface SunlightLegendBandContract {
  id: string;
  minMinutes: number;
  maxMinutes: number;
  color: string;
  visible: boolean;
}

export interface SunlightMapComputationRequest {
  date: string;
  time: string;
  opacity: number;
  viewportBounds: [number, number, number, number];
  viewportSize: {
    width: number;
    height: number;
  };
  bands: SunlightLegendBandContract[];
}

export interface SunlightTrajectoryComputationRequest {
  date: string;
  time: string;
  sampleStepMeters: number;
  smoothingMeters: number;
  routeCoordinates: Array<readonly [number, number]>;
  bands: SunlightLegendBandContract[];
}

export interface SunlightTrajectorySample {
  distanceMeters: number;
  exposureMinutes: number;
  shadedRatio: number;
}