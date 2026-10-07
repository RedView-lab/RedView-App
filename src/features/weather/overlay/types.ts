export type WeatherOverlayMetric = 'temperature' | 'feelsLike' | 'rain' | 'cloudCover' | 'humidity';
export type WeatherOverlayMode = 'gradient' | 'fill';

export interface WeatherOverlayLayer {
  key: string;
  enabled: boolean;
  mode: string;
}

export interface WeatherOverlayState {
  enabled: boolean;
  date: string;
  time: string;
  forecastDay: number;
  layers: WeatherOverlayLayer[];
  radarEnabled?: boolean;
  palettes?: Partial<Record<string, {
    opacity: number;
    scaleSetting: string;
    bands: Array<{ id: string; label: string; color: string; visible: boolean; minValue: number; maxValue: number }>;
  }>>;
}
