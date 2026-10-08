// ============================================
// Choix du backend de rendu
// ============================================
//
// WebGPU quand le navigateur offre un adaptateur matériel et que le device
// démarre ; sinon WebGL 2, qui dessine le même viewer (voir sceneRenderer.ts).
// Sous Linux en 2026 c'est le cas courant : Firefox ne livre WebGPU que sous
// Windows et macOS, et Chrome l'active pour Intel Gen12+ et NVIDIA sous
// Wayland, derrière des drapeaux ailleurs.

import { claimViewerCanvas } from './canvas';
import { preflightWebGPU } from './device';
import type { LidarRenderer } from './sceneRenderer';

/** `auto` : WebGPU, sinon WebGL 2 ; `webgl` : WebGL 2 seulement (`?engine=webgl`, ou après un échec de WebGPU). */
export type RendererRequest = 'auto' | 'webgl';

export interface CreatedRenderer {
  renderer: LidarRenderer;
  /** Pourquoi WebGPU n'est pas le backend (null quand il l'est, ou quand WebGL 2 a été demandé). */
  webgpuUnavailable: string | null;
}

function describe(error: unknown): string {
  return (error as Error)?.message || String(error);
}

/**
 * Crée le renderer sur le canvas du viewer (un élément neuf quand une
 * tentative précédente a pris le canvas, voir `claimViewerCanvas`).
 * @throws quand aucun backend ne peut démarrer (pas de WebGL 2, ou échec du pilote).
 */
export async function createLidarRenderer(request: RendererRequest): Promise<CreatedRenderer> {
  let webgpuUnavailable: string | null = null;
  if (request === 'auto') {
    const preflight = await preflightWebGPU();
    if (preflight.ok) {
      // Chaque backend est son propre chunk, chargé seulement quand il est
      // choisi : aucun module WebGPU n'est évalué dans un navigateur sans l'API.
      const { WebGpuLidarRenderer } = await import('../renderer');
      const renderer = new WebGpuLidarRenderer();
      try {
        await renderer.init(claimViewerCanvas());
        return { renderer, webgpuUnavailable: null };
      } catch (error) {
        renderer.destroy();
        webgpuUnavailable = describe(error);
        console.warn(`[Viewer] WebGPU did not start (${webgpuUnavailable}): WebGL 2 backend.`);
      }
    } else {
      webgpuUnavailable = `${preflight.code}: ${preflight.detail}`;
      console.info(`[Viewer] WebGPU unavailable (${webgpuUnavailable}): WebGL 2 backend.`);
    }
  }
  // Chargé à la demande : les sessions WebGPU ne le téléchargent jamais.
  const { WebGlLidarRenderer } = await import('./webgl/glRenderer');
  return { renderer: new WebGlLidarRenderer(claimViewerCanvas()), webgpuUnavailable };
}
