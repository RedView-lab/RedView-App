// ============================================
// Rendering backend selection
// ============================================
//
// WebGPU when the browser offers a hardware adapter and the device starts;
// otherwise WebGL 2, which draws the same viewer (see sceneRenderer.ts).
// On Linux in 2026 that is the common case: Firefox ships WebGPU on
// Windows and macOS only, and Chrome enables it for Intel Gen12+ and
// NVIDIA on Wayland, behind flags elsewhere.

import { claimViewerCanvas } from './canvas';
import { preflightWebGPU } from './device';
import type { LidarRenderer } from './sceneRenderer';

/** `auto`: WebGPU, else WebGL 2; `webgl`: WebGL 2 only (`?engine=webgl`, or after a WebGPU failure). */
export type RendererRequest = 'auto' | 'webgl';

export interface CreatedRenderer {
  renderer: LidarRenderer;
  /** Why WebGPU is not the backend (null when it is, or when WebGL 2 was requested). */
  webgpuUnavailable: string | null;
}

function describe(error: unknown): string {
  return (error as Error)?.message || String(error);
}

/**
 * Creates the renderer on the viewer canvas (a fresh element when a
 * previous attempt took the canvas, see `claimViewerCanvas`).
 * @throws when neither backend can start (no WebGL 2, or a driver failure).
 */
export async function createLidarRenderer(request: RendererRequest): Promise<CreatedRenderer> {
  let webgpuUnavailable: string | null = null;
  if (request === 'auto') {
    const preflight = await preflightWebGPU();
    if (preflight.ok) {
      // Each backend is its own chunk, loaded only when chosen: no WebGPU
      // module is evaluated in a browser without the API.
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
  // Loaded on demand: WebGPU sessions never fetch it.
  const { WebGlLidarRenderer } = await import('./webgl/glRenderer');
  return { renderer: new WebGlLidarRenderer(claimViewerCanvas()), webgpuUnavailable };
}
