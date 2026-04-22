import type { Map as MapboxMap } from 'mapbox-gl';

export interface AltitudeCategory {
  id: string;
  label: string;
  minMeters: number;
  maxMeters: number;
  color: string;
  displayRange: string;
}

export type AltitudeColorMode = 'gradient' | 'step';

export type AltitudeResolutionKey = '0.40 m (LIDAR)' | '1 m' | '5 m' | '10 m';

export type AltitudeScaleSettingKey = '2 couleurs' | '3 couleurs' | '4 couleurs' | '6 couleurs';

export interface AltitudeState {
  enabled: boolean;
  opacity: number;
  colorMode: AltitudeColorMode;
  resolution: AltitudeResolutionKey;
  scaleSetting: AltitudeScaleSettingKey;
  hiddenBandIds: string[];
  customColors: Record<string, string>;
}

export interface AltitudePanelProps {
  map: MapboxMap | null;
  isMapLoaded: boolean;
}