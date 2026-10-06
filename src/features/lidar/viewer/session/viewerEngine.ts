// ============================================
// Viewer engine selection (`?engine=`)
// ============================================
//
// The point-cloud viewer draws with WebGPU or WebGL 2 (same features, see
// renderer/sceneRenderer.ts); the terrain engine (viewer-webgl/) is the
// older orthophoto-draped DTM without points, kept as the last resort.
//   (absent) / webgpu  → WebGPU, else WebGL 2
//   webgl              → WebGL 2 only
//   terrain            → terrain engine

/** Engine of the panel's selector. */
export type ViewerEngineKey = 'webgpu' | 'webgl' | 'terrain';

/** What the URL asks for: `auto` tries WebGPU first. */
export type ViewerEngineRequest = 'auto' | 'webgl' | 'terrain';

export const VIEWER_ENGINE_PARAM = 'engine';

export function parseViewerEngineParam(raw: string | null): ViewerEngineRequest {
  if (raw === 'webgl') return 'webgl';
  if (raw === 'terrain') return 'terrain';
  return 'auto';
}

/** `?engine=` value selecting `key` (null: no parameter, automatic choice). */
export function viewerEngineParamValue(key: ViewerEngineKey): string | null {
  return key === 'webgpu' ? null : key;
}

/**
 * Engine to reopen the viewer with after the GPU context of `running` was
 * lost twice in a row: WebGPU → WebGL 2 → terrain.
 */
export function fallbackViewerEngine(running: ViewerEngineKey): ViewerEngineKey {
  return running === 'webgpu' ? 'webgl' : 'terrain';
}
