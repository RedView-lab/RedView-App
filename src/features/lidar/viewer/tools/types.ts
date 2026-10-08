// ============================================
// Outils du viewer LiDAR — types partagés
// ============================================
//
// Repères utilisés par chaque outil :
//  - proj : mètres CRS (x est, y nord) + altitude absolue (m) ;
//  - local : repère de rendu, centré sur la scène (x est, y haut, z = −nord).

export type Vec3 = [number, number, number];

/** Un point choisi dans la scène (nuage de points d'abord, puis modèle de terrain). */
export interface ScenePick {
  /** Position dans le repère de rendu. */
  local: Vec3;
  projX: number;
  projY: number;
  /** Altitude de la surface choisie (point ou sol), m. */
  altitudeM: number;
  lon: number;
  lat: number;
  /** `points` : un retour LiDAR ; `terrain` : le modèle de sol (MNT). */
  source: 'points' | 'terrain';
  /** Classe ASPRS du retour choisi (`null` sur le modèle de terrain). */
  classification: number | null;
  /** Altitude du sol sous le point choisi (MNT), m. */
  groundAltitudeM: number | null;
}

/** Outils lancés depuis le menu contextuel ou le clavier. */
export type ToolId =
  | 'distance'
  | 'height'
  | 'area'
  | 'profile'
  | 'fallLine'
  | 'avalanche'
  | 'viewshed'
  | 'pin';

/** Outils dessinés sommet par sommet (terminés par un clic droit ou Entrée). */
export type DrawingToolId = Extract<ToolId, 'distance' | 'height' | 'area' | 'profile'>;

export function isDrawingTool(tool: ToolId): tool is DrawingToolId {
  return tool === 'distance' || tool === 'height' || tool === 'area' || tool === 'profile';
}

/** RGBA, 0..255. */
export type Rgba = [number, number, number, number];
