export type MapContextMenuActionId =
  | 'copy-coordinates'
  | 'create-poi'
  | 'set-start'
  | 'add-waypoint'
  | 'set-finish';

export interface MapContextMenuPoint {
  lng: number;
  lat: number;
  elevationMeters: number | null;
  slopePct: number | null;
  coordinatesLabel: string;
  title: string | null;
  categoryLabel: string | null;
  surfaceLabel: string | null;
  openingHoursLabel: string | null;
  overlayDetails: MapContextMenuOverlayDetail[];
}

export type MapContextMenuOverlayDetailKind = 'sunlight' | 'weather' | 'wind';

export interface MapContextMenuOverlayDetail {
  id: string;
  kind: MapContextMenuOverlayDetailKind;
  icon: 'sun' | 'thermometer' | 'wind';
  label: string;
}

export interface MapContextMenuOverlayContext {
  weather: {
    enabled: boolean;
    tab: 'forecast' | 'trends';
    date: string;
    time: string;
    forecastDay: number;
    activeLayers: Array<'temperature' | 'feelsLike' | 'rain' | 'cloudCover' | 'humidity'>;
  };
  wind: {
    enabled: boolean;
    date: string;
    time: string;
    forecastDay: number;
    terrainOverlayEnabled: boolean;
    particlesEnabled: boolean;
  };
  sunlight: {
    enabled: boolean;
    date: string;
    time: string;
    shadowEnabled: boolean;
    sunlightMapEnabled: boolean;
  };
}

export interface MapContextMenuActionPayload {
  action: MapContextMenuActionId;
  point: MapContextMenuPoint;
  screenPoint: {
    x: number;
    y: number;
  };
}