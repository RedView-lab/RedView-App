export type WeatherOverlayMetric = 'temperature' | 'feelsLike' | 'rain' | 'cloudCover' | 'humidity';
export type WeatherOverlayMode = 'gradient' | 'fill';
export type WeatherOverlayTab = 'forecast' | 'trends';

export interface WeatherOverlayLayer {
  key: string;
  enabled: boolean;
  mode: string;
}

export interface WeatherOverlayState {
  enabled: boolean;
  tab: WeatherOverlayTab;
  date: string;
  time: string;
  forecastDay: number;
  layers: WeatherOverlayLayer[];
}

export interface WeatherGridPoint {
  lat: number;
  lng: number;
  row: number;
  col: number;
}

export interface WeatherGridDefinition {
  bounds: [west: number, south: number, east: number, north: number];
  rows: number;
  cols: number;
  points: WeatherGridPoint[];
}

export interface WeatherOverlaySample {
  lat: number;
  lng: number;
  temperature: number;
  feelsLike: number;
  rain: number;
  cloudCover: number;
  humidity: number;
}

export interface WeatherSelection {
  mode: WeatherOverlayTab;
  key: string;
  forecastIso?: string;
  monthIso?: string;
}

export interface WeatherGridDataset {
  selectionKey: string;
  grid: WeatherGridDefinition;
  samples: WeatherOverlaySample[];
  fetchedAt: number;
}