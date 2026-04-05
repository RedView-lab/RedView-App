export const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;

export const MAPBOX_STYLE = 'mapbox://styles/mapbox/standard-satellite';

export const DEFAULT_VIEW = {
  center: [2.3522, 46.6034] as [number, number],
  zoom: 5.5,
  pitch: 45,
  bearing: 0,
  projection: 'globe' as const,
};

export const FOG_CONFIG = {
  color: 'rgb(186, 210, 235)',
  'high-color': 'rgb(36, 92, 223)',
  'horizon-blend': 0.08,
  'space-color': 'rgb(11, 11, 25)',
  'star-intensity': 0.6,
};
