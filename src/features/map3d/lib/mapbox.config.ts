export const MAPBOX_TOKEN = (import.meta.env?.VITE_MAPBOX_TOKEN ?? '') as string;

// Le style par défaut correspond à DEFAULT_BASEMAP_ID dans features/controlPanel/basemaps.
// Outdoors (vectoriel) est facturé en Vector Tiles, PAS en Raster Tiles : le
// chargement par défaut de l'app ne coûte plus rien sur le SKU Raster Tiles.
// Le satellite reste disponible comme option de fond de gamme premium.
export const MAPBOX_STYLE = 'mapbox://styles/mapbox/outdoors-v12';

// Caméra par défaut d'un nouveau projet : la France vue de loin, pour que
// l'utilisateur parte d'une vue nationale et zoome sur sa zone d'intérêt.
export const DEFAULT_VIEW = {
  center: [2.3522, 46.6034] as [number, number],
  zoom: 5,
  pitch: 0,
  bearing: 0,
  projection: 'globe' as const,
};

// Ciel de plein jour (environnement « Jour ») : voile clair bleuté à l'horizon,
// ciel bleu au-dessus. L'espace autour du globe est d'un bleu profond vu de
// loin et s'éclaircit en bleu ciel une fois zoomé (vue inclinée en montagne).
// L'ancien brouillard orangé / mauve ressemblait à un coucher de soleil.
export const FOG_CONFIG = {
  range: [0.6, 8.5],
  color: 'rgb(220, 232, 244)',
  'high-color': 'rgb(80, 145, 225)',
  'horizon-blend': ['interpolate', ['linear'], ['zoom'], 4, 0.2, 7, 0.08],
  'space-color': ['interpolate', ['linear'], ['zoom'], 4, 'rgb(16, 40, 86)', 7, 'rgb(118, 170, 232)'],
  'star-intensity': 0,
};
