// ============================================
// Choix du moteur du viewer (`?engine=`)
// ============================================
//
// Le viewer de nuage de points dessine en WebGPU ou en WebGL 2 (mêmes
// fonctions, voir renderer/sceneRenderer.ts) ; le moteur terrain (viewer-webgl/)
// est l'ancien MNT drapé d'orthophoto sans points, gardé en dernier recours.
//   (absent) / webgpu  → WebGPU, sinon WebGL 2
//   webgl              → WebGL 2 seulement
//   terrain            → moteur terrain

/** Moteur du sélecteur du panneau. */
export type ViewerEngineKey = 'webgpu' | 'webgl' | 'terrain';

/** Ce que demande l'URL : `auto` essaie WebGPU d'abord. */
export type ViewerEngineRequest = 'auto' | 'webgl' | 'terrain';

export const VIEWER_ENGINE_PARAM = 'engine';

export function parseViewerEngineParam(raw: string | null): ViewerEngineRequest {
  if (raw === 'webgl') return 'webgl';
  if (raw === 'terrain') return 'terrain';
  return 'auto';
}

/** Valeur de `?engine=` qui sélectionne `key` (null : pas de paramètre, choix automatique). */
export function viewerEngineParamValue(key: ViewerEngineKey): string | null {
  return key === 'webgpu' ? null : key;
}

/**
 * Moteur avec lequel rouvrir le viewer après deux pertes consécutives du
 * contexte GPU de `running` : WebGPU → WebGL 2 → terrain.
 */
export function fallbackViewerEngine(running: ViewerEngineKey): ViewerEngineKey {
  return running === 'webgpu' ? 'webgl' : 'terrain';
}
