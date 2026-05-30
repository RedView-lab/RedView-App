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
  coordinatesLabel: string;
}

export interface MapContextMenuActionPayload {
  action: MapContextMenuActionId;
  point: MapContextMenuPoint;
  screenPoint: {
    x: number;
    y: number;
  };
}